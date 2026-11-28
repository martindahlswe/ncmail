import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { pool } from "../db.ts";
import { encrypt, decrypt } from "../crypto.ts";

/**
 * The user's connection to their Nextcloud, used for Contacts (CardDAV) and Files (WebDAV).
 * It is made with Nextcloud's own "Login flow": the user approves in Nextcloud and we receive an app password
 * (never their real one). The server address comes only from NEXTCLOUD_URL, never from a request.
 */

export const ncBase = () => (process.env.NEXTCLOUD_URL ?? "").replace(/\/+$/, "");
export interface NcLink { owner: string; baseUrl: string; username: string; password: string }
export const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
export const xml = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false, attributeNamePrefix: "@_" });
export const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
/**
 * A text value for a vCard or iCalendar property: \ ; , escaped, every kind of line break written as \n, and other
 * control characters removed, so a value always stays on its own content line.
 */
export const escText = (s: string) =>
  s.replace(/[\\;,]/g, "\\$&").replace(/\r\n|[\r\n\u0085\u2028\u2029]/g, "\\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");

export async function getNcLink(owner: string): Promise<NcLink | null> {
  const { rows: [r] } = await pool.query("select * from nextcloud_links where owner = $1", [owner]);
  return r ? { owner, baseUrl: r.base_url, username: r.username, password: decrypt(r.password_enc) } : null;
}
export async function requireNcLink(owner: string): Promise<NcLink> {
  const l = await getNcLink(owner);
  if (!l) throw httpError(400, "Connect your Nextcloud first under Settings > Nextcloud.");
  return l;
}

/** A WebDAV/CardDAV request as the connected user. */
export async function davFetch(l: NcLink, url: string, init: { method: string; headers?: Record<string, string>; body?: string | Buffer } = { method: "GET" }) {
  const r = await fetch(url, {
    ...init, body: init.body as any, redirect: "manual", signal: AbortSignal.timeout(60000),
    headers: { authorization: `Basic ${Buffer.from(`${l.username}:${l.password}`).toString("base64")}`, ...init.headers },
  }).catch((e) => { throw httpError(502, `Could not reach Nextcloud (${e.cause?.code ?? e.message})`); });
  if (r.status === 401) throw httpError(400, "Nextcloud no longer accepts the saved connection. Connect again under Settings > Nextcloud.");
  return r;
}

const pending = new Map<string, { owner: string; token: string; endpoint: string; at: number }>();

export async function ncRoutes(app: FastifyInstance) {
  app.get("/api/nextcloud", async (req) => {
    const l = await getNcLink(req.owner);
    return { available: !!ncBase(), connected: !!l, user: l?.username ?? "", baseUrl: ncBase() };
  });

  // ---- connect with Nextcloud's login flow (v2): approve in Nextcloud, receive an app password ----
  app.post("/api/nextcloud/connect", async (req) => {
    if (!ncBase()) throw httpError(400, "No Nextcloud is configured (NEXTCLOUD_URL).");
    const r = await fetch(`${ncBase()}/index.php/login/v2`, { method: "POST", headers: { "user-agent": "Mail" }, signal: AbortSignal.timeout(10000) })
      .catch((e) => { throw httpError(502, `Could not reach Nextcloud (${e.cause?.code ?? e.message})`); });
    if (!r.ok) throw httpError(502, `Nextcloud answered ${r.status} to the sign-in request`);
    const j: any = await r.json();
    // the addresses Nextcloud hands back must be on the Nextcloud we are configured for (a compromised answer must not send the user elsewhere)
    for (const u of [j?.login, j?.poll?.endpoint]) { try { if (new URL(String(u)).host !== new URL(ncBase()).host) throw 0; } catch { throw httpError(502, "Nextcloud answered with an address that is not its own, so the sign-in was stopped."); } }
    const id = randomUUID();
    for (const [k, v] of pending) if (Date.now() - v.at > 20 * 60_000) pending.delete(k);
    pending.set(id, { owner: req.owner, token: j.poll.token, endpoint: j.poll.endpoint, at: Date.now() });
    return { id, loginUrl: j.login };
  });

  app.post("/api/nextcloud/connect/poll", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.body);
    const p = pending.get(id);
    if (!p || p.owner !== req.owner) throw httpError(404, "That sign-in has expired. Start again.");
    const r = await fetch(p.endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `token=${encodeURIComponent(p.token)}`, signal: AbortSignal.timeout(10000) });
    if (r.status === 404) return { connected: false };
    if (!r.ok) throw httpError(502, `Nextcloud answered ${r.status}`);
    const j: any = await r.json();
    pending.delete(id);
    if (req.owner && j.loginName !== req.owner) {
      await revokeAppPassword(String(j.loginName ?? ""), String(j.appPassword ?? "")); // minted for the wrong user: do not leave it behind
      throw httpError(400, `You approved the connection as "${j.loginName}", but you are signed in as "${req.owner}". Approve it with your own Nextcloud user.`);
    }
    await save(req.owner, j.loginName, j.appPassword);
    return { connected: true, user: j.loginName };
  });

  // ---- or paste an app password (servers without the login flow) ----
  app.post("/api/nextcloud/connect-password", async (req) => {
    const b = z.object({ username: z.string().min(1), password: z.string().min(1) }).parse(req.body);
    if (!ncBase()) throw httpError(400, "No Nextcloud is configured (NEXTCLOUD_URL).");
    if (req.owner && b.username !== req.owner) throw httpError(400, `Use your own Nextcloud user (${req.owner}).`);
    const r = await fetch(`${ncBase()}/ocs/v2.php/cloud/user?format=json`, { headers: { "OCS-APIRequest": "true", authorization: `Basic ${Buffer.from(`${b.username}:${b.password}`).toString("base64")}` }, signal: AbortSignal.timeout(10000) })
      .catch((e) => { throw httpError(502, `Could not reach Nextcloud (${e.cause?.code ?? e.message})`); });
    if (!r.ok) throw httpError(400, "Nextcloud did not accept that user name and password.");
    await save(req.owner, b.username, b.password);
    return { connected: true, user: b.username };
  });

  app.delete("/api/nextcloud", async (req, reply) => {
    const d = dropNcLink(req.owner);
    await d.removed;
    await d.revoked;
    reply.code(204);
  });
}

/**
 * Forget the user's Nextcloud connection and its contact mirror. The app password is taken back at Nextcloud too, so
 * disconnecting really ends the access (best effort; `revoked` settles when that call is done).
 */
export function dropNcLink(owner: string) {
  const link = getNcLink(owner).catch(() => null);
  const removed = link.then(async () => {
    await pool.query("delete from nextcloud_links where owner = $1", [owner]);
    await pool.query("delete from nc_contacts where owner = $1", [owner]);
  });
  const revoked = removed.then(async () => {
    const l = await link;
    if (l) await revokeAppPassword(l.username, l.password);
  }).catch(() => {});
  return { removed, revoked };
}

/** Takes an app password back at Nextcloud (it revokes the one it is called with). Best effort: never throws. */
export async function revokeAppPassword(username: string, password: string): Promise<void> {
  if (!ncBase() || !username || !password) return;
  await fetch(`${ncBase()}/ocs/v2.php/core/apppassword`, { method: "DELETE", headers: { "OCS-APIRequest": "true", authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }, signal: AbortSignal.timeout(8000) })
    .catch(() => {});
}

async function save(owner: string, username: string, password: string) {
  await pool.query(
    `insert into nextcloud_links (owner, base_url, username, password_enc) values ($1,$2,$3,$4)
     on conflict (owner) do update set base_url = excluded.base_url, username = excluded.username, password_enc = excluded.password_enc`,
    [owner, ncBase(), username, encrypt(password)]);
}
