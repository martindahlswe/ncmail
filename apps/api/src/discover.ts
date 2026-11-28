import { resolveSrv } from "node:dns/promises";
import { guardUrl, httpRequest } from "./netguard.ts";

/**
 * Finds the mail servers of an email domain, for the admin page's "Add mail server", in the order mail apps use:
 *  1. the domain's own autoconfig file (autoconfig.<domain>, then <domain>/.well-known/autoconfig);
 *  2. DNS SRV records (RFC 6186 for IMAP and submission, RFC 5804 for ManageSieve);
 *  3. Thunderbird's public database of mail providers (autoconfig.thunderbird.net), unless NCMAIL_ISPDB=0. Only the
 *     domain is sent there.
 * Fetches go through the same address policy as everything else the service connects to (NCMAIL_PRIVATE_HOSTS).
 */
type Security = "tls" | "starttls" | "none";
export interface Found { host: string; port: number; security: Security }
export interface Discovery {
  source: "autoconfig" | "srv" | "ispdb";
  /** Where the settings were found, to show the administrator. */
  from: string;
  imap: Found; smtp: Found; sieve?: Found;
  username: "email" | "local";
  /** The provider's name in the autoconfig file, if any. */
  name?: string;
}

export const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const MAX_BYTES = 200_000;

/**
 * A host name a domain's published settings may point at: letters, digits, dots and hyphens, with a dot, and not an IP
 * address. (An address or a single-label name like "localhost" can only point inwards.)
 */
export const publicHost = (h: string) => /^(?=.{3,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) && !/^[\d.]+$/.test(h) && !h.includes("..");
const socket = (s: string): Security | null => ({ SSL: "tls", TLS: "tls", STARTTLS: "starttls", plain: "none" } as Record<string, Security>)[s.trim()] ?? null;
const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, "i"))?.[1] ?? "";
const unescape = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");

/** The first usable server of `type` in a Mozilla autoconfig document (config-v1.1.xml), best security first. */
function servers(xml: string, element: "incomingServer" | "outgoingServer", type: string, domain: string) {
  const out: (Found & { username: string })[] = [];
  const re = new RegExp(`<${element}\\s+type="${type}"\\s*>([\\s\\S]*?)</${element}>`, "gi");
  for (const m of xml.matchAll(re)) {
    const body = m[1]!;
    const host = unescape(tag(body, "hostname")).replace(/%EMAILDOMAIN%/g, domain).toLowerCase();
    const port = Number(tag(body, "port"));
    const security = socket(tag(body, "socketType"));
    if (!publicHost(host) || !(port > 0 && port < 65536) || !security) continue;
    out.push({ host, port, security, username: tag(body, "username") });
  }
  const rank = { tls: 0, starttls: 1, none: 2 };
  return out.sort((a, b) => rank[a.security] - rank[b.security])[0] ?? null;
}

export function parseAutoconfig(xml: string, domain: string): Omit<Discovery, "source" | "from"> | null {
  const imap = servers(xml, "incomingServer", "imap", domain);
  const smtp = servers(xml, "outgoingServer", "smtp", domain);
  if (!imap || !smtp) return null;
  const name = unescape(tag(xml, "displayName")) || undefined;
  const { username, ...i } = imap;
  return { imap: i, smtp: { host: smtp.host, port: smtp.port, security: smtp.security }, username: /%EMAILLOCALPART%/.test(username) ? "local" : "email", name };
}

async function fetchXml(url: string): Promise<string | null> {
  try {
    const u = new URL(url);
    const lookup = await guardUrl(u, "autoconfig server");
    const r = await httpRequest(u, { method: "GET", headers: { accept: "application/xml, text/xml" }, lookup, timeoutMs: 6000, maxBytes: MAX_BYTES });
    if (!r.ok) return null;
    const text = await r.text();
    return text.length > MAX_BYTES || !/<clientConfig/i.test(text) ? null : text;
  } catch { return null; }
}

async function srv(name: string): Promise<{ name: string; port: number } | null> {
  try {
    const recs = (await resolveSrv(name)).filter((r) => r.name && r.name !== ".").sort((a, b) => a.priority - b.priority || b.weight - a.weight);
    const r = recs.find((x) => x.port > 0 && x.port < 65536 && publicHost(x.name.replace(/\.$/, "").toLowerCase()));
    return r ? { name: r.name.replace(/\.$/, "").toLowerCase(), port: r.port } : null;
  } catch { return null; }
}

async function fromSrv(domain: string): Promise<Omit<Discovery, "source" | "from"> | null> {
  const [imaps, imap, subs, sub, sieve] = await Promise.all([
    srv(`_imaps._tcp.${domain}`), srv(`_imap._tcp.${domain}`), srv(`_submissions._tcp.${domain}`), srv(`_submission._tcp.${domain}`), srv(`_sieve._tcp.${domain}`),
  ]);
  const i = imaps ? { host: imaps.name, port: imaps.port, security: "tls" as const } : imap ? { host: imap.name, port: imap.port, security: "starttls" as const } : null;
  const s = subs ? { host: subs.name, port: subs.port, security: "tls" as const } : sub ? { host: sub.name, port: sub.port, security: "starttls" as const } : null;
  if (!i || !s) return null;
  return { imap: i, smtp: s, ...(sieve ? { sieve: { host: sieve.name, port: sieve.port, security: "starttls" as const } } : {}), username: "email" };
}

export async function discover(domainIn: string): Promise<Discovery | null> {
  const domain = domainIn.trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "");
  if (!DOMAIN.test(domain)) throw Object.assign(new Error("Enter a domain such as example.com."), { statusCode: 400 });
  for (const url of [
    `https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(`user@${domain}`)}`,
    `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`,
  ]) {
    const xml = await fetchXml(url);
    const found = xml && parseAutoconfig(xml, domain);
    if (found) return { source: "autoconfig", from: new URL(url).host, ...found };
  }
  const bySrv = await fromSrv(domain);
  if (bySrv) return { source: "srv", from: `DNS records of ${domain}`, ...bySrv };
  if (process.env.NCMAIL_ISPDB !== "0") {
    const xml = await fetchXml(`https://autoconfig.thunderbird.net/v1.1/${domain}`);
    const found = xml && parseAutoconfig(xml, domain);
    if (found) return { source: "ispdb", from: "Thunderbird's list of mail providers", ...found };
  }
  return null;
}
