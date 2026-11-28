import net from "node:net";
import tls from "node:tls";

/** A small ManageSieve (RFC 5804) client: enough to list, read, check, upload and activate scripts. */
export interface SieveConn { host: string; port: number; security: "none" | "starttls" | "tls"; username: string; password: string }
type Token = string;
interface Response { status: "OK" | "NO" | "BYE"; text: string; lines: Token[][] }

const err = (message: string, statusCode = 502) => Object.assign(new Error(message), { statusCode });

import { guardedLookup, requireTls } from "../netguard.ts";

export class ManageSieve {
  private sock!: net.Socket | tls.TLSSocket;
  private buf = Buffer.alloc(0);
  private waiter: (() => void) | null = null;
  private closed: Error | null = null;

  static async open(c: SieveConn): Promise<ManageSieve> {
    const m = new ManageSieve();
    await m.connect(c);
    return m;
  }

  private attach(s: net.Socket | tls.TLSSocket) {
    this.sock = s;
    s.on("data", (d) => { this.buf = Buffer.concat([this.buf, d]); this.waiter?.(); });
    s.on("error", (e) => { this.closed = e; this.waiter?.(); });
    s.on("close", () => { this.closed ??= new Error("The connection closed"); this.waiter?.(); });
  }

  private async connect(c: SieveConn) {
    requireTls(c.security, "Sieve service");
    const lookup = await guardedLookup(c.host, "Sieve service", undefined, c.port);
    const sock: net.Socket | tls.TLSSocket = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(err("Timed out connecting to the Sieve server")), 10_000);
      const done = (s: net.Socket) => { clearTimeout(t); resolve(s); };
      const s = c.security === "tls" ? tls.connect({ host: c.host, port: c.port, servername: c.host, lookup }, () => done(s)) : net.connect({ host: c.host, port: c.port, lookup }, () => done(s));
      s.once("error", (e) => { clearTimeout(t); reject(err(`Could not reach the Sieve server on ${c.host}:${c.port} (${(e as any).code ?? e.message})`)); });
    });
    this.attach(sock);
    await this.read(); // greeting with capabilities
    if (c.security === "starttls") {
      await this.cmd("STARTTLS");
      this.sock.removeAllListeners("data");
      const secure = tls.connect({ socket: this.sock as net.Socket, servername: c.host });
      await new Promise<void>((res, rej) => { secure.once("secureConnect", res); secure.once("error", (e) => rej(err(`Could not secure the connection (${e.message})`))); });
      this.buf = Buffer.alloc(0); this.attach(secure);
      await this.read(); // capabilities again
    }
    const r = await this.cmd(`AUTHENTICATE "PLAIN" "${Buffer.from(`\u0000${c.username}\u0000${c.password}`).toString("base64")}"`, true);
    if (r.status !== "OK") throw err("The mail server did not accept the login for filters", 400);
  }

  /** Parse one logical line (with any literals) from the buffer; null if it is not complete yet. */
  private parse(): { tokens: Token[]; used: number } | null {
    const b = this.buf; let i = 0; const tokens: Token[] = [];
    while (i < b.length) {
      const ch = b[i]!;
      if (ch === 13) { if (i + 1 >= b.length) return null; return { tokens, used: i + 2 }; } // CRLF ends the line
      if (ch === 32) { i++; continue; }
      if (ch === 34) { // quoted string
        let j = i + 1, s = "";
        for (; j < b.length && b[j] !== 34; j++) { if (b[j] === 92) j++; s += String.fromCharCode(b[j]!); }
        if (j >= b.length) return null;
        tokens.push(Buffer.from(s, "latin1").toString("utf8")); i = j + 1; continue;
      }
      if (ch === 123) { // literal {n} or {n+}
        const end = b.indexOf(125, i); if (end < 0) return null;
        const n = parseInt(b.subarray(i + 1, end).toString(), 10);
        const start = end + 3; // after "}" CRLF
        if (b.length < start + n) return null;
        tokens.push(b.subarray(start, start + n).toString("utf8")); i = start + n; continue;
      }
      let j = i; while (j < b.length && b[j] !== 32 && b[j] !== 13) j++;
      if (j >= b.length) return null;
      tokens.push(b.subarray(i, j).toString()); i = j;
    }
    return null;
  }

  /** Read lines until the final OK / NO / BYE. */
  private async read(): Promise<Response> {
    const lines: Token[][] = [];
    for (;;) {
      const p = this.parse();
      if (!p) {
        if (this.closed) throw err(`Lost the connection to the Sieve server (${this.closed.message})`);
        await new Promise<void>((res, rej) => { const t = setTimeout(() => rej(err("The Sieve server did not answer")), 20_000); this.waiter = () => { clearTimeout(t); this.waiter = null; res(); }; });
        continue;
      }
      this.buf = this.buf.subarray(p.used);
      const first = (p.tokens[0] ?? "").toUpperCase();
      if (first === "OK" || first === "NO" || first === "BYE") return { status: first, text: p.tokens.slice(1).filter((t) => !t.startsWith("(")).join(" "), lines };
      lines.push(p.tokens);
    }
  }

  private async cmd(line: string, allowNo = false): Promise<Response> {
    this.sock.write(line + "\r\n");
    const r = await this.read();
    if (r.status !== "OK" && !allowNo) throw err(r.text || `The Sieve server refused ${line.split(" ")[0]}`, r.status === "NO" ? 400 : 502);
    return r;
  }

  async list(): Promise<{ name: string; active: boolean }[]> {
    const r = await this.cmd("LISTSCRIPTS");
    return r.lines.map((l) => ({ name: l[0]!, active: (l[1] ?? "").toUpperCase() === "ACTIVE" }));
  }
  async get(name: string): Promise<string | null> {
    this.sock.write(`GETSCRIPT "${name}"\r\n`);
    const r = await this.read();
    if (r.status === "NO") return null;
    return r.lines[0]?.[0] ?? "";
  }
  private lit(s: string) { return `{${Buffer.byteLength(s)}+}\r\n${s}`; }
  /** The server's own syntax check; throws its message (line and column) when the script is wrong. */
  async check(script: string) { await this.cmd(`CHECKSCRIPT ${this.lit(script)}`); }
  async put(name: string, script: string) { await this.cmd(`PUTSCRIPT "${name}" ${this.lit(script)}`); }
  /** Make a script the active one; "" switches filtering off. */
  async setActive(name: string) { await this.cmd(`SETACTIVE "${name}"`); }
  async delete(name: string) { await this.cmd(`DELETESCRIPT "${name}"`); }
  async close() { try { this.sock.write("LOGOUT\r\n"); } catch { /* already closed */ } this.sock.destroy(); }
}

export async function withSieve<T>(c: SieveConn, fn: (s: ManageSieve) => Promise<T>): Promise<T> {
  const s = await ManageSieve.open(c);
  try { return await fn(s); } finally { await s.close(); }
}
