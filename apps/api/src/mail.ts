import { describeImapError, isImapRefusal } from "./imapError.ts";
import { createHash } from "node:crypto";
import net, { type LookupFunction } from "node:net";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { ServerConfig, TestResult } from "@ncmail/shared";
import { guardedLookup, guardHost, requireTls } from "./netguard.ts";

/**
 * An IMAP client for a server that passed the address check. `lookup` (from guardedLookup) makes the socket connect only to the
 * checked addresses; ImapFlow hands its `tls` options to net/tls.connect, and keeps the host name for SNI and certificate checks.
 */
export function imapClient(c: ServerConfig, lookup: LookupFunction | undefined, extra: Record<string, unknown> = {}) {
  return new ImapFlow({
    host: c.host,
    ...(lookup ? { tls: { lookup } } : {}),
    port: c.port,
    secure: c.security === "tls",
    doSTARTTLS: c.security === "starttls" ? true : c.security === "none" ? false : undefined,
    auth: { user: c.username, pass: c.password },
    logger: false,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    ...extra,
  });
}

/**
 * An SMTP transport for a server that passed the address check. Nodemailer resolves names itself and has no lookup hook, so it
 * is given one checked address to connect to, with the host name as the TLS server name (SNI and certificate checks).
 */
export async function smtpTransport(c: ServerConfig, what = "outgoing mail server") {
  const addrs = await guardHost(c.host, what, undefined, c.port);
  return nodemailer.createTransport({
    host: addrs?.[0]?.address ?? c.host,
    ...(addrs && !net.isIP(c.host.replace(/^\[|\]$/g, "")) ? { servername: c.host } : {}),
    port: c.port,
    secure: c.security === "tls",
    requireTLS: c.security === "starttls",
    ignoreTLS: c.security === "none",
    auth: { user: c.username, pass: c.password },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
}

const msg = (e: unknown) => {
  if (isImapRefusal(e)) return describeImapError(e, "sign in");
  const x = e as { responseText?: string; message?: string };
  return x?.responseText || x?.message || String(e);
};

export async function testConnections(imap: ServerConfig, smtp: ServerConfig): Promise<TestResult> {
  const result: TestResult = { imap: { ok: false }, smtp: { ok: false } };
  // refused before anything is contacted (a blocked address, or unencrypted where encryption is required)
  requireTls(imap.security, "mail server"); requireTls(smtp.security, "outgoing mail server");
  const imapLookup = await guardedLookup(imap.host, "mail server", undefined, imap.port);
  const transport = await smtpTransport(smtp);

  const client = imapClient(imap, imapLookup);
  client.on("error", () => {});
  try {
    await client.connect();
    const caps = client.capabilities;
    result.imap = {
      ok: true,
      capabilities: {
        condstore: caps.has("CONDSTORE") || caps.has("QRESYNC"),
        qresync: caps.has("QRESYNC"),
        idle: caps.has("IDLE"),
        move: caps.has("MOVE"),
      },
    };
    await client.logout();
  } catch (e) {
    result.imap = { ok: false, error: msg(e) };
  }

  try {
    await transport.verify();
    result.smtp = { ok: true };
  } catch (e) {
    result.smtp = { ok: false, error: msg(e) };
  }
  return result;
}

/**
 * Like withImap, but when the connection turns out to be gone, run `fn` once more on a new one. Only for work that is safe to
 * repeat (syncing reads the server and writes the mirror idempotently); not for appends or sends.
 */
export async function withImapRetry<T>(cfg: ServerConfig, fn: (c: ImapFlow, lastTry: boolean) => Promise<T>): Promise<T> {
  try { return await withImap(cfg, (c) => fn(c, false)); }
  catch (e) {
    if (!isConnectionLost(e)) throw e;
    return withImap(cfg, (c) => fn(c, true), { fresh: true });
  }
}

/**
 * Run `fn` on a pooled IMAP connection. Opening a connection (TCP + TLS + login) is the slowest part of most
 * single actions, so up to MAX_IDLE are kept warm per server login for IDLE_MS. A connection that threw is closed, not reused.
 * Long-running work (the body indexer) simply holds one connection while others are created for concurrent actions.
 */
interface Idle { c: ImapFlow; timer: ReturnType<typeof setTimeout> }
const idlePool = new Map<string, Idle[]>();
let imapInUse = 0;
/** Pooled IMAP connections, for the metrics endpoint: in use right now, and waiting idle for the next request. */
export const imapPoolStats = () => ({ inUse: imapInUse, idle: [...idlePool.values()].reduce((n, l) => n + l.length, 0) });
const MAX_IDLE = 2;
const IDLE_MS = 60_000;
// A connection is replaced after this long even while it keeps being used: servers cache some things per session (for example
// which users shared folders with you), so a session that lives forever would never see them change.
const MAX_AGE_MS = () => Number(process.env.NCMAIL_IMAP_MAX_AGE_MS) || 120_000;
const born = new WeakMap<ImapFlow, number>();
const poolKey = (c: ServerConfig) => `${c.host}:${c.port}:${c.security}:${c.username}:${createHash("sha1").update(c.password).digest("hex").slice(0, 10)}`;
const closeQuietly = (c: ImapFlow) => c.logout().catch(() => c.close());

/** The connection itself is gone (dropped by the server, a firewall or the network): the work never reached the server. */
const LOST = new Set(["NoConnection", "EConnectionClosed", "StateLogout", "ECONNRESET", "EPIPE"]);
export const isConnectionLost = (e: any) => LOST.has(e?.code);

export async function withImap<T>(cfg: ServerConfig, fn: (c: ImapFlow) => Promise<T>, opts: { fresh?: boolean } = {}): Promise<T> {
  const key = poolKey(cfg);
  const idle = opts.fresh ? [] : idlePool.get(key) ?? [];
  let c: ImapFlow | undefined;
  for (let p = idle.pop(); p; p = idle.pop()) {
    clearTimeout(p.timer);
    if (!p.c.usable || Date.now() - (born.get(p.c) ?? 0) > MAX_AGE_MS()) { closeQuietly(p.c); continue; }
    try {
      // NOOP (about 1 ms) proves the connection still works: servers and firewalls drop quiet connections without telling
      // the client, and the next command would fail. With a mailbox open it also brings the session's view of it up to date
      // (the server only reports changes when a command runs, so a message added elsewhere would be unknown to it).
      await p.c.noop();
      if (!p.c.usable) throw new Error("closed");
      c = p.c;
      break;
    } catch { p.c.close(); }
  }
  if (!c) {
    c = imapClient(cfg, await guardedLookup(cfg.host, "mail server", undefined, cfg.port));
    c.on("error", () => {});
    await c.connect();
    born.set(c, Date.now());
  }
  let healthy = true;
  imapInUse++;
  try {
    return await fn(c);
  } catch (e) {
    healthy = false;
    throw e;
  } finally {
    imapInUse--;
    const list = idlePool.get(key) ?? [];
    if (healthy && c.usable && list.length < MAX_IDLE) {
      const entry: Idle = { c, timer: setTimeout(() => { list.splice(list.indexOf(entry), 1); closeQuietly(entry.c); }, IDLE_MS) };
      entry.timer.unref();
      c.once("close", () => { clearTimeout(entry.timer); const i = list.indexOf(entry); if (i >= 0) list.splice(i, 1); });
      list.push(entry);
      idlePool.set(key, list);
    } else {
      closeQuietly(c);
    }
  }
}

/** The raw message with this UID in the selected mailbox. A message that is no longer on the server is "not found". */
/** The raw message. With `maxBytes`, stops and throws `tooBig()` as soon as it is larger, without keeping the rest. */
export async function downloadRaw(c: ImapFlow, uid: number | string, maxBytes?: number, tooBig?: () => Error): Promise<Buffer> {
  const dl = await c.download(String(uid), undefined, { uid: true });
  if (!dl.content) throw Object.assign(new Error("The message is no longer on the mail server"), { statusCode: 404 });
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const ch of dl.content) {
    n += ch.length;
    if (maxBytes !== undefined && n > maxBytes) { (dl.content as any).destroy?.(); throw tooBig ? tooBig() : Object.assign(new Error("The message is too large"), { statusCode: 413 }); }
    chunks.push(Buffer.from(ch));
  }
  return Buffer.concat(chunks);
}
