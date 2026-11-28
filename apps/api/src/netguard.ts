import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net, { type LookupFunction } from "node:net";
import { authOn } from "./auth.ts";
import { presetEndpoints } from "./presets.ts";

/**
 * Where the server may connect. Users type the mail, Sieve and calendar servers themselves, so on a shared service an unchecked
 * address would let one user probe the internal network (or the cloud metadata address) and send credentials to it.
 *
 *   NCMAIL_PRIVATE_HOSTS=allow          any address (the default for a single-user install, where the user is the admin)
 *   NCMAIL_PRIVATE_HOSTS=block          refuse loopback / private / link-local addresses (the default when users sign in with Nextcloud)
 *   NCMAIL_PRIVATE_HOSTS=mail.corp,10.1.2.3,10.5.0.0/16   block them except these hosts, addresses or networks
 *   NCMAIL_REQUIRE_TLS=1                refuse unencrypted IMAP / SMTP / Sieve and http:// calendar addresses
 */
const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

const v4 = (ip: string) => ip.split(".").reduce((n, p) => n * 256 + Number(p), 0);
const inCidr = (ip: string, cidr: string) => {
  const [base, bits = "32"] = cidr.split("/");
  if (!net.isIPv4(ip) || !net.isIPv4(base!)) return false;
  const mask = bits === "0" ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return ((v4(ip) & mask) >>> 0) === ((v4(base!) & mask) >>> 0);
};
const PRIVATE_V4 = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/3"];

/** The 16 bytes of an IPv6 address in any spelling (zero groups written out, "::" anywhere, a trailing dotted IPv4 part), or null. */
function v6Bytes(ip: string): number[] | null {
  const s = ip.replace(/%.*$/, "").toLowerCase(); // a zone id ("fe80::1%eth0") names an interface, not part of the address
  if (!net.isIPv6(s)) return null;
  const words = (part: string) => {
    if (!part) return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (g.includes(".")) { const b = g.split(".").map(Number); out.push((b[0]! << 8) | b[1]!, (b[2]! << 8) | b[3]!); }
      else out.push(parseInt(g, 16));
    }
    return out;
  };
  const [head, tail] = s.includes("::") ? s.split("::") as [string, string] : [s, undefined];
  const h = words(head), t = tail === undefined ? [] : words(tail);
  const all = [...h, ...Array(8 - h.length - t.length).fill(0), ...t];
  return all.flatMap((w) => [w >> 8, w & 255]);
}

/**
 * The address in one canonical form: IPv4 as a.b.c.d, IPv6 as eight lowercase groups. IPv6 forms that carry an IPv4 address
 * (mapped ::ffff:0:0/96 and ::ffff:0:0:0/96, compatible ::/96, NAT64 64:ff9b::/96, 6to4 2002::/16) come back as that IPv4 address,
 * since that is where a connection to them ends up.
 */
export function canonicalIp(ip: string): string | null {
  if (net.isIPv4(ip)) return ip.split(".").map(Number).join(".");
  const b = v6Bytes(ip);
  if (!b) return null;
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  const v4At = (i: number) => b.slice(i, i + 4).join(".");
  if (zero(0, 10) && b[10] === 255 && b[11] === 255) return v4At(12);
  if (zero(0, 8) && b[8] === 255 && b[9] === 255 && zero(10, 12)) return v4At(12); // ::ffff:0:0:0/96 (SIIT)
  if (zero(0, 12)) return v4At(12);
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return v4At(12);
  if (b[0] === 0x20 && b[1] === 0x02) return v4At(2);
  const g: string[] = [];
  for (let i = 0; i < 16; i += 2) g.push(((b[i]! << 8) | b[i + 1]!).toString(16));
  return g.join(":");
}

export function isPrivateIp(raw: string): boolean {
  const ip = canonicalIp(raw);
  if (!ip) return true; // not an address we can classify: treat as unsafe
  if (net.isIPv4(ip)) return PRIVATE_V4.some((c) => inCidr(ip, c));
  const [g0, g1, g2] = ip.split(":").map((x) => parseInt(x, 16)) as [number, number, number];
  return (g0 & 0xfe00) === 0xfc00     // fc00::/7 unique local
    || (g0 & 0xffc0) === 0xfe80       // fe80::/10 link-local
    || (g0 & 0xffc0) === 0xfec0       // fec0::/10 site-local (deprecated, still routed by some stacks)
    || (g0 & 0xff00) === 0xff00       // ff00::/8 multicast
    || (g0 === 0x64 && g1 === 0xff9b && g2 === 1) // 64:ff9b:1::/48 local-use NAT64
    || (g0 === 0x100 && ip.startsWith("100:0:0:0:")); // 100::/64 discard
}

type Policy = { mode: "allow" } | { mode: "block"; allow: string[] };
const policy = (): Policy => {
  const v = (process.env.NCMAIL_PRIVATE_HOSTS ?? "").trim().toLowerCase();
  if (v === "allow") return { mode: "allow" };
  if (v === "" || v === "block") return v === "" && !authOn() ? { mode: "allow" } : { mode: "block", allow: [] };
  return { mode: "block", allow: v.split(",").map((s) => s.trim()).filter(Boolean) };
};
const sameIp = (a: string, ip: string) => net.isIP(a) > 0 && canonicalIp(a) === canonicalIp(ip);
const permitted = (host: string, ip: string, allow: string[]) => {
  const v4 = canonicalIp(ip) ?? ip;
  return allow.some((a) => a === host || sameIp(a, ip) || (a.includes("/") && inCidr(v4, a)) || (a.startsWith("*.") && host.endsWith(a.slice(1))));
};

export type Resolver = (host: string) => Promise<LookupAddress[]>;
const systemResolver: Resolver = (host) => lookup(host, { all: true });

/**
 * The addresses a connection to `host` may use, each one checked against the policy; null when any address is fine.
 * Connections must then go to exactly these addresses (see pinnedLookup), never resolve the name again: a second lookup
 * can answer differently from the one that was checked. Nothing is cached, so every new connection is checked afresh.
 */
/**
 * `mailPort`: set for mail connections (IMAP, SMTP, ManageSieve) only. A private address is then also allowed when the host
 * and this port are one of the mail servers an administrator listed (presetEndpoints); HTTP connections never pass it.
 */
export async function guardHost(host: string, what = "server", resolve: Resolver = systemResolver, mailPort?: number): Promise<LookupAddress[] | null> {
  const p = policy();
  if (p.mode === "allow") return null;
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  let addrs: LookupAddress[];
  try { addrs = net.isIP(h) ? [{ address: h, family: net.isIP(h) }] : await resolve(h); }
  catch { throw httpError(400, `The ${what} address "${host}" could not be found.`); }
  if (!addrs.length) throw httpError(400, `The ${what} address "${host}" could not be found.`);
  const listed = mailPort !== undefined && presetEndpoints().has(`${h}:${mailPort}`); // a mail server the administrator listed
  const bad = listed ? undefined : addrs.find((a) => isPrivateIp(a.address) && !permitted(h, a.address, p.allow));
  if (bad) throw httpError(400, `The ${what} address "${host}" is on a private or local network, which this service does not connect to. An administrator can allow it (NCMAIL_PRIVATE_HOSTS).`);
  return addrs;
}

/**
 * A socket `lookup` that answers only with the addresses guardHost checked (undefined, i.e. the system resolver, when it
 * returned null). Passed to net/tls.connect the connection still uses the host name for TLS (SNI and certificate checks).
 */
export function pinnedLookup(addrs: LookupAddress[] | null): LookupFunction | undefined {
  if (!addrs) return undefined;
  return (hostname, opts, cb) => {
    const fam = typeof opts === "object" && opts ? opts.family : undefined;
    const pick = addrs.filter((a) => !fam || fam === "IPv4" && a.family === 4 || fam === "IPv6" && a.family === 6 || a.family === fam);
    const all = typeof opts === "object" && opts?.all;
    process.nextTick(() => {
      if (!pick.length) return cb(Object.assign(new Error(`No usable address for ${hostname}`), { code: "ENOTFOUND" }), "", 4);
      if (all) return (cb as unknown as (e: null, a: LookupAddress[]) => void)(null, pick);
      cb(null, pick[0]!.address, pick[0]!.family);
    });
  };
}

/** Check `host` and return the lookup to connect with: guardHost and pinnedLookup in one step. */
export const guardedLookup = async (host: string, what = "server", resolve?: Resolver, mailPort?: number) => pinnedLookup(await guardHost(host, what, resolve, mailPort));

export function requireTls(security: string, what: string) {
  if (process.env.NCMAIL_REQUIRE_TLS === "1" && security === "none") throw httpError(400, `The ${what} must use an encrypted connection (SSL/TLS or STARTTLS).`);
}
export const guardUrl = async (u: URL, what = "server") => {
  if (process.env.NCMAIL_REQUIRE_TLS === "1" && u.protocol === "http:") throw httpError(400, `The ${what} address must start with https://.`);
  return guardedLookup(u.hostname, what);
};

export interface PlainResponse { status: number; ok: boolean; headers: { get(name: string): string | null }; text(): Promise<string> }
/**
 * One HTTP(S) request that connects only where `lookup` allows (fetch has no lookup hook) and does not follow redirects.
 * No connection pooling: a kept-alive socket would skip the lookup of the next request.
 */
export function httpRequest(url: URL, init: { method: string; headers?: Record<string, string>; body?: string; lookup?: LookupFunction; timeoutMs: number; /** stop reading the body past this many bytes */ maxBytes?: number }): Promise<PlainResponse> {
  const headers = { ...(init.body !== undefined ? { "content-length": String(Buffer.byteLength(init.body)) } : {}), ...init.headers };
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? https : http).request(url, { method: init.method, headers, lookup: init.lookup, agent: false, signal: AbortSignal.timeout(init.timeoutMs) }, (res) => {
      const chunks: Buffer[] = [];
      const body = new Promise<string>((ok, fail) => {
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (init.maxBytes !== undefined && size > init.maxBytes) { req.destroy(); fail(Object.assign(new Error("The response was too large"), { code: "TOO_LARGE" })); return; }
          chunks.push(c);
        });
        res.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
        res.on("error", fail); res.on("aborted", () => fail(new Error("The connection closed")));
      });
      body.catch(() => {});
      const status = res.statusCode ?? 0;
      const headers = { get: (name: string) => { const v = res.headers[name.toLowerCase()]; return v === undefined ? null : Array.isArray(v) ? v.join(", ") : String(v); } };
      resolve({ status, ok: status >= 200 && status < 300, headers, text: () => body });
    });
    req.on("error", reject);
    req.end(init.body);
  });
}
