import net from "node:net";
import tls from "node:tls";
import type { LookupFunction } from "node:net";
import { guardHost, pinnedLookup } from "./netguard.ts";

/**
 * Checks that a mail server answers, without logging in: connect, read the greeting, and (for STARTTLS) switch to TLS. The
 * certificate is checked the way accounts check it. Used by the admin page, so an administrator sees a typo or a closed
 * port before people try to sign in.
 */
export interface ProbeResult {
  ok: boolean; message: string;
  /** "plain": answers without encryption; "cert-soon": the certificate runs out within CERT_WARN_DAYS. */
  warning?: "plain" | "cert-soon";
  /** When the certificate runs out (ISO date), for TLS and STARTTLS. */
  certExpires?: string;
  /** Another port and security that does answer, when the chosen one failed. */
  suggestion?: { port: number; security: Security };
}
type Security = "tls" | "starttls" | "none";
const CERT_WARN_DAYS = 14;
type Kind = "imap" | "smtp" | "sieve";
const TIMEOUT_MS = 8000;

/** At most this many lines and bytes per reply: a greeting or a STARTTLS answer is a few lines. More is a broken or hostile server. */
const MAX_LINES = 200, MAX_BYTES = 64 * 1024;

/** Reads lines until `done` says the server's reply is complete. */
function reader(sock: net.Socket) {
  let buf = "", bytes = 0;
  const waiting: { done: (l: string[]) => boolean; resolve: (l: string[]) => void; reject: (e: Error) => void }[] = [];
  let lines: string[] = [];
  const pump = () => {
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { lines.push(buf.slice(0, i).replace(/\r$/, "")); buf = buf.slice(i + 1); }
    const w = waiting[0];
    if (!w) return;
    if (lines.length > MAX_LINES || bytes > MAX_BYTES) { waiting.shift(); w.reject(Object.assign(new Error("The server sent far more than a mail server's greeting."), { code: "TOO_MUCH" })); sock.destroy(); return; }
    if (w.done(lines)) { waiting.shift(); const got = lines; lines = []; bytes = 0; w.resolve(got); }
  };
  const onData = (d: Buffer) => { bytes += d.length; buf += d.toString("latin1"); if (buf.length > MAX_BYTES) buf = buf.slice(-MAX_BYTES); pump(); };
  sock.on("data", onData);
  return {
    next: (done: (l: string[]) => boolean) => new Promise<string[]>((resolve, reject) => { waiting.push({ done, resolve, reject }); pump(); }),
    detach: () => sock.off("data", onData),
  };
}

const imapDone = (tag: string | null) => (l: string[]) => l.some((x) => (tag ? x.startsWith(`${tag} `) : /^\* (OK|PREAUTH|BYE)/i.test(x)));
const smtpDone = (l: string[]) => l.some((x) => /^\d{3} /.test(x));
const sieveDone = (l: string[]) => l.some((x) => /^(OK|NO|BYE)\b/i.test(x));

/** The socket is handed to `track` at once, so a probe that times out can close it even before it has connected. */
function connect(host: string, port: number, secure: boolean, track: (s: net.Socket) => void, lookup?: LookupFunction): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = secure ? tls.connect({ host, port, lookup, servername: net.isIP(host) ? undefined : host }) : net.connect({ host, port, lookup });
    track(sock);
    sock.once(secure ? "secureConnect" : "connect", () => resolve(sock));
    sock.once("error", reject);
  });
}
function upgrade(sock: net.Socket, host: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const t = tls.connect({ socket: sock, servername: net.isIP(host) ? undefined : host });
    t.once("secureConnect", () => resolve(t));
    t.once("error", reject);
  });
}

function explain(e: any, host: string, port: number): string {
  const code = String(e?.code ?? "");
  if (code === "TOO_MUCH") return "The server sent far more than a mail server's greeting.";
  if (e?.statusCode === 400 && e?.message) return String(e.message); // refused by the address policy
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `${host} could not be found (DNS).`;
  if (code === "ECONNREFUSED") return `Nothing answers on port ${port}.`;
  if (code === "ETIMEDOUT" || code === "TIMEOUT") return `No answer from ${host}:${port} (timed out).`;
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return `${host} cannot be reached from the mail service.`;
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS_CERT_ALTNAME/.test(code)) return `The server's certificate is not valid for ${host} (${code}).`;
  if (code === "ERR_SSL_WRONG_VERSION_NUMBER" || /wrong version number/i.test(e?.message ?? "")) return "The server did not start TLS here: try STARTTLS or another port.";
  return e?.message ? String(e.message) : "The connection failed.";
}

/**
 * `guarded`: apply the address policy (NCMAIL_PRIVATE_HOSTS) and connect only to the checked addresses. Used for servers
 * that a domain lookup found, which a third party chose; servers an administrator typed in are probed as given.
 */
export async function probe(kind: Kind, s: { host: string; port: number; security: Security }, timeoutMs = TIMEOUT_MS, guarded = false): Promise<ProbeResult> {
  let sock: net.Socket | null = null;
  const sockets: net.Socket[] = [];
  const timer = new Promise<never>((_, reject) => setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "TIMEOUT" })), timeoutMs).unref());
  const run = async (): Promise<ProbeResult> => {
    const lookup = guarded ? pinnedLookup(await guardHost(s.host, "mail server")) : undefined;
    sock = await connect(s.host, s.port, s.security === "tls", (x) => sockets.push(x), lookup);
    let r = reader(sock);
    // the greeting ends at the first complete reply of any kind, so a server of another sort (an IMAP server on the SMTP
    // port, say) is reported instead of waited on
    const greet = await r.next(kind === "imap" ? (l) => l.length > 0 : kind === "smtp" ? (l) => l.some((x) => !/^\d{3}-/.test(x)) : (l) => l.some((x) => /^(OK|NO|BYE)\b/i.test(x) || /^(\* |\d{3}[ -])/.test(x)));
    const first = greet[0] ?? "";
    const okGreeting = kind === "imap" ? /^\* (OK|PREAUTH)/i.test(first) : kind === "smtp" ? /^220[ -]/.test(first) : greet.some((x) => /^OK\b/i.test(x));
    if (!okGreeting) return { ok: false, message: `This does not look like ${kind === "imap" ? "an IMAP" : kind === "smtp" ? "an SMTP" : "a ManageSieve"} server: "${first.slice(0, 80)}"` };
    if (s.security === "starttls") {
      if (kind === "smtp") { sock.write("EHLO ncmail-check\r\n"); await r.next(smtpDone); }
      sock.write(kind === "imap" ? "a1 STARTTLS\r\n" : kind === "smtp" ? "STARTTLS\r\n" : "STARTTLS\r\n");
      const resp = await r.next(kind === "imap" ? imapDone("a1") : kind === "smtp" ? smtpDone : sieveDone);
      const last = resp[resp.length - 1] ?? "";
      if (!(kind === "imap" ? /^a1 OK/i.test(last) : kind === "smtp" ? /^220 /.test(last) : /^OK\b/i.test(last))) return { ok: false, message: "The server does not offer STARTTLS here." };
      r.detach();
      sock = await upgrade(sock, s.host);
      sockets.push(sock);
      r = reader(sock);
    }
    if (s.security === "none") return { ok: true, warning: "plain", message: "Answers, but without encryption: passwords would travel in clear text." };
    const cert = (sock as tls.TLSSocket).getPeerCertificate?.();
    const expires = cert?.valid_to ? new Date(cert.valid_to) : null;
    if (!expires || isNaN(expires.getTime())) return { ok: true, message: "Answers, and the certificate is valid." };
    const days = Math.floor((expires.getTime() - Date.now()) / 86_400_000);
    const until = expires.toISOString().slice(0, 10);
    if (days <= CERT_WARN_DAYS) return { ok: true, warning: "cert-soon", certExpires: expires.toISOString(), message: `Answers, but the certificate runs out in ${Math.max(days, 0)} day${days === 1 ? "" : "s"} (${until}).` };
    return { ok: true, certExpires: expires.toISOString(), message: `Answers, and the certificate is valid until ${until}.` };
  };
  try { return await Promise.race([run(), timer]); }
  catch (e) { return { ok: false, message: explain(e, s.host, s.port) }; }
  finally { for (const x of sockets) x.destroy(); }
}

/** The usual ports for each kind of server, most secure first. */
const USUAL: Record<Kind, { port: number; security: Security }[]> = {
  imap: [{ port: 993, security: "tls" }, { port: 143, security: "starttls" }],
  smtp: [{ port: 465, security: "tls" }, { port: 587, security: "starttls" }],
  sieve: [{ port: 4190, security: "starttls" }],
};

/** probe(), and when the server does not answer as set up, the first usual port that does (same host), as a suggestion. */
export async function check(kind: Kind, s: { host: string; port: number; security: Security }, alternatives = USUAL[kind], guarded = false): Promise<ProbeResult> {
  const r = await probe(kind, s, TIMEOUT_MS, guarded);
  if (r.ok) return r;
  // a host that cannot be found or reached will not answer on another port either
  if (/could not be found|cannot be reached|private or local network/.test(r.message)) return r;
  for (const alt of alternatives) {
    if (alt.port === s.port && alt.security === s.security) continue;
    const a = await probe(kind, { host: s.host, ...alt }, TIMEOUT_MS, guarded);
    if (a.ok) return { ...r, suggestion: alt };
  }
  return r;
}
