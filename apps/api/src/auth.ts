import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { pool } from "./db.ts";
import { verifyHandoff } from "./handoff.ts";

/**
 * Who is using the app. With NCMAIL_AUTH=nextcloud (and NEXTCLOUD_URL set) the app only works inside Nextcloud:
 *  - the Nextcloud app (integration/nextcloud-app) shows this service in a frame and hands the frame a short-lived token it has signed;
 *  - the token is exchanged here for a session (POST /api/auth/handoff). There is no password sign-in and no guessing from cookies;
 *  - a session lasts a few minutes and is renewed with a fresh token, which Nextcloud only hands out while the user's Nextcloud session lives,
 *    so Mail's session ends when the Nextcloud one does (and at once when Nextcloud tells us the user signed out).
 * Mail accounts belong to the Nextcloud user who added them; nobody else can see or use them.
 * Without NCMAIL_AUTH the app is single-user (this machine only) and every account has the empty owner ''.
 */

export const authOn = () => process.env.NCMAIL_AUTH === "nextcloud" && !!process.env.NEXTCLOUD_URL;

const isLoopbackHost = (h: string) => h === "localhost" || h === "::1" || h === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(h);
/** A socket address on this machine (IPv4 or IPv6 loopback, or IPv4 loopback mapped into IPv6). */
export const isLoopbackAddress = (a = "") => a === "::1" || /^(::ffff:)?127\.\d+\.\d+\.\d+$/i.test(a);

/**
 * Checks the sign-in settings at startup and refuses ones that would leave the API open by accident:
 * an unknown NCMAIL_AUTH, NCMAIL_AUTH=nextcloud without a usable NEXTCLOUD_URL, or single-user mode listening beyond this machine.
 */
export function checkAuthConfig(env: NodeJS.ProcessEnv = process.env): "nextcloud" | "off" | "single" {
  const mode = env.NCMAIL_AUTH ?? "";
  if (mode === "nextcloud") {
    let url: URL | null = null;
    try { url = new URL(env.NEXTCLOUD_URL ?? ""); } catch { /* reported below */ }
    if (!url || !["http:", "https:"].includes(url.protocol)) throw new Error("NCMAIL_AUTH=nextcloud needs NEXTCLOUD_URL, the address of your Nextcloud (for example https://cloud.example.com).");
    return "nextcloud";
  }
  if (mode === "off") return "off";
  if (mode !== "") throw new Error(`NCMAIL_AUTH=${mode} is not a known value. Use nextcloud (with NEXTCLOUD_URL), off, or leave it empty for single-user use on this machine.`);
  const host = env.API_HOST ?? "127.0.0.1";
  if (!isLoopbackHost(host)) throw new Error(`NCMAIL_AUTH is not set, so there is no sign-in and the service may only listen on this machine, not on API_HOST=${host}. Set NCMAIL_AUTH=nextcloud and NEXTCLOUD_URL, or API_HOST=127.0.0.1, or NCMAIL_AUTH=off to run without sign-in on a closed network.`);
  return "single";
}

/**
 * Access decisions use the route Fastify matched (its pattern, e.g. "/api/messages/:id"), never the raw request target,
 * so they always agree with the handler that runs. "" for requests that matched no route.
 */
export const matchedRoute = (req: FastifyRequest): string => req.routeOptions?.url ?? "";
export const isApiRoute = (req: FastifyRequest) => matchedRoute(req).startsWith("/api/");
/** The request path, percent-decoded with repeated slashes folded, in lower case; null when it cannot be decoded. */
function decodedPath(req: FastifyRequest): string | null {
  try { return decodeURIComponent(req.url.split("?")[0]!).replace(/\/{2,}/g, "/").toLowerCase(); } catch { return null; }
}
/** Addressed to the API, by the matched route or by how the path reads once decoded, so the API's rules apply. */
export function isApiRequest(req: FastifyRequest): boolean {
  if (isApiRoute(req)) return true;
  const p = decodedPath(req);
  return p === null || p === "/api" || p.startsWith("/api/");
}
/** Development only: lets the app be opened on its own (without Nextcloud's frame). Never in production. */
export const standaloneAllowed = () => process.env.NCMAIL_ALLOW_STANDALONE === "1";
const nc = () => (process.env.NEXTCLOUD_URL ?? "").replace(/\/+$/, "");
const COOKIE = "ncmail_session";
/** How long a session lasts without a fresh token from Nextcloud. */
const TTL_S = Math.max(2, Number(process.env.NCMAIL_SESSION_MINUTES ?? 15)) * 60;
const INTERNAL = randomUUID(); // lets the server call its own routes on behalf of an owner (never leaves this process)
export const internalHeaders = (owner: string) => ({ "x-ncmail-internal": INTERNAL, "x-ncmail-owner": Buffer.from(owner).toString("base64") });

// ---- sessions: random ids kept in the database, so signing out (or removing a user) really ends them ----
const sessionCache = new Map<string, { owner: string; exp: number; checked: number }>();
async function createSession(owner: string, who: { name?: string; email?: string; lang?: string }): Promise<string> {
  const id = randomBytes(32).toString("base64url");
  await pool.query("insert into sessions (id, owner, name, email, lang, expires_at) values ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))", [id, owner, who.name ?? "", who.email ?? "", who.lang ?? "", TTL_S]);
  return id;
}
async function sessionOwner(id?: string): Promise<string | null> {
  if (!id || !/^[A-Za-z0-9_-]{40,64}$/.test(id)) return null;
  const c = sessionCache.get(id);
  if (c && c.checked > Date.now() - 15_000) return c.exp > Date.now() ? c.owner : null;
  const { rows: [r] } = await pool.query("select owner, extract(epoch from expires_at) * 1000 as exp from sessions where id = $1 and expires_at > now()", [id]);
  if (!r) { sessionCache.delete(id); return null; }
  sessionCache.set(id, { owner: r.owner, exp: Number(r.exp), checked: Date.now() });
  return r.owner;
}
async function endSession(id?: string) { if (!id) return; sessionCache.delete(id); await pool.query("delete from sessions where id = $1", [id]); }
/** Ends every session of a user (Nextcloud says they signed out or were removed). */
export async function endSessionsOf(owner: string) { for (const [k, v] of sessionCache) if (v.owner === owner) sessionCache.delete(k); await pool.query("delete from sessions where owner = $1", [owner]); }

const cookies = (h?: string) => Object.fromEntries((h ?? "").split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf("="); return [c.slice(0, i), safeDecode(c.slice(i + 1))]; }));
const safeDecode = (v: string) => { try { return decodeURIComponent(v); } catch { return v; } };
const isSecure = (req: FastifyRequest) => process.env.NCMAIL_COOKIE_SECURE === "1" || req.protocol === "https";
/** Framed by Nextcloud on another site, the cookie must be SameSite=None (and Secure, so HTTPS) and partitioned to that site. Same-site development keeps Lax. */
const setCookie = (req: FastifyRequest, id: string | null) =>
  `${COOKIE}=${id ?? ""}; Path=/; HttpOnly; Max-Age=${id ? TTL_S : 0}; ${isSecure(req) ? "SameSite=None; Secure; Partitioned" : "SameSite=Lax"}`;

// ---- failed sign-ins are limited per address ----
const failures = new Map<string, { n: number; reset: number }>();
const WINDOW_MS = 10 * 60_000;
const tooMany = (key: string, max: number) => { const f = failures.get(key); return f && f.reset > Date.now() && f.n >= max ? Math.ceil((f.reset - Date.now()) / 1000) : 0; };
const noteFailure = (key: string) => { const now = Date.now(); const f = failures.get(key); failures.set(key, !f || f.reset <= now ? { n: 1, reset: now + WINDOW_MS } : { n: f.n + 1, reset: f.reset }); };

/**
 * NCMAIL_TRUST_PROXY as Fastify's trustProxy: a number of proxy hops in front of the service ("1": one reverse proxy, whose
 * X-Forwarded-* entry is believed and nothing a client added before it), or a comma-separated list of proxy addresses or ranges.
 */
export function trustProxySetting(v = process.env.NCMAIL_TRUST_PROXY ?? ""): false | string | ((addr: string, hop: number) => boolean) {
  const s = v.trim();
  if (s === "" || s === "0") return false;
  if (/^\d+$/.test(s)) { const hops = Number(s); return (_addr, hop) => hop < hops; } // Fastify's own numeric setting trusts no hop at all
  return s;
}

const hostOf = (u: string) => { try { return new URL(u).host; } catch { return ""; } };
/** Came straight from this machine, not through a proxy (tools and tests on the server itself). */
const directLocal = (req: FastifyRequest) =>
  isLoopbackAddress(req.socket.remoteAddress) && !(req.headers["x-forwarded-for"] || req.headers["x-forwarded-host"] || req.headers.forwarded);
/** A request that is not from this app's own pages (another site, or another app on the same site). */
function crossOrigin(req: FastifyRequest): boolean {
  const sfs = req.headers["sec-fetch-site"];
  if (sfs && sfs !== "same-origin" && sfs !== "none") return true;
  const o = req.headers.origin;
  if (o === "null") return true;
  // Browsers send at least one of the two with every request that changes something; a session cookie without either is not
  // trusted to come from the app.
  if (!sfs && !o) return authOn() && !!cookies(req.headers.cookie)[COOKIE] && !directLocal(req);
  return !!o && hostOf(String(o)) !== req.host; // req.host follows X-Forwarded-Host only from a trusted proxy
}

declare module "fastify" { interface FastifyRequest { owner: string } }

const PUBLIC = [/^\/api\/auth\//, /^\/api\/theme/, /^\/api\/health$/, /^\/api\/internal\//]; // internal: signed by Nextcloud, checked in the route

export function installAuth(app: FastifyInstance) {
  app.decorateRequest("owner", "");
  if (authOn() && standaloneAllowed() && process.env.NODE_ENV === "production") throw new Error("NCMAIL_ALLOW_STANDALONE=1 is for development only and cannot be used with NODE_ENV=production");

  setInterval(() => { pool.query("delete from sessions where expires_at < now()").catch(() => {}); pool.query("delete from handoff_used where exp < now()").catch(() => {}); for (const [k, f] of failures) if (f.reset < Date.now()) failures.delete(k); }, 600_000).unref();

  app.addHook("onRequest", async (req, reply) => {
    // The page itself is only served into Nextcloud's frame (a visit to the address in a browser tab gets a pointer to Nextcloud).
    if (!isApiRequest(req)) {
      if (authOn() && !standaloneAllowed() && req.method === "GET" && ["document", "frame"].includes(String(req.headers["sec-fetch-dest"] ?? ""))) {
        return reply.code(403).type("text/html; charset=utf-8").send(openFromNextcloud());
      }
      return;
    }
    // A path that reads as the API but is none of its routes (another spelling, stray slashes, undecodable) is not served.
    if (!isApiRoute(req)) return reply.code(404).send({ error: "Not found" });
    const route = matchedRoute(req);
    const internal = req.headers["x-ncmail-internal"];
    if (internal === INTERNAL) { req.owner = authOn() ? Buffer.from(String(req.headers["x-ncmail-owner"] ?? ""), "base64").toString() : ""; return; }
    // Other websites (and other apps on this site) must not drive the API through the user's browser.
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && crossOrigin(req)) return reply.code(403).send({ error: "This request did not come from the app", code: "origin" });
    if (!authOn()) {
      req.owner = "";
      // Without sign-in the app is only for the machine it runs on: the connection must come from this machine, and a proxy or
      // another host name (also what a DNS-rebinding page looks like) is refused.
      if (process.env.NCMAIL_AUTH !== "off") {
        const host = String(req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
        const proxied = req.headers["x-forwarded-for"] || req.headers["x-forwarded-host"] || req.headers.forwarded;
        if (proxied || !isLoopbackAddress(req.socket.remoteAddress) || !["localhost", "127.0.0.1", "::1"].includes(host)) return reply.code(403).send({ error: "Sign-in is not set up. Set NCMAIL_AUTH=nextcloud before making this reachable from other machines (or NCMAIL_AUTH=off to accept the risk).", code: "no-auth" });
      }
      return;
    }
    const uid = await sessionOwner(cookies(req.headers.cookie)[COOKIE]);
    if (uid) { req.owner = uid; return; }
    if (PUBLIC.some((p) => p.test(route))) return;
    reply.code(401).send({ error: "Please sign in", code: "auth" });
  });

  // Nextcloud's token for this visit -> a session. Called by the app inside the frame, first thing and then before the session runs out.
  app.post("/api/auth/handoff", async (req, reply) => {
    if (!authOn()) return { authRequired: false, user: null };
    const wait = tooMany(`ip:${req.ip}`, 30);
    if (wait) return reply.code(429).header("retry-after", String(wait)).send({ error: "Too many attempts. Try again in a few minutes." });
    const { token } = z.object({ token: z.string().min(10).max(4096) }).parse(req.body);
    let c;
    try { c = await verifyHandoff(token); } catch (e) { noteFailure(`ip:${req.ip}`); throw e; }
    await endSession(cookies(req.headers.cookie)[COOKIE]); // the old session is replaced, not extended
    const id = await createSession(c.uid, c);
    reply.header("set-cookie", setCookie(req, id));
    return { authRequired: true, user: c.uid, name: c.name, email: c.email, lang: c.lang, expiresInSeconds: TTL_S };
  });
  app.post("/api/auth/logout", async (req, reply) => { await endSession(cookies(req.headers.cookie)[COOKIE]); reply.header("set-cookie", setCookie(req, null)); return { ok: true }; });
  app.get("/api/auth/me", async (req) => {
    if (!authOn()) return { authRequired: false, user: null };
    const id = cookies(req.headers.cookie)[COOKIE];
    const uid = await sessionOwner(id);
    const base = { authRequired: true, nextcloud: nc(), nextcloudOrigin: new URL(nc()).origin, standalone: standaloneAllowed(), sessionSeconds: TTL_S };
    if (!uid) return { ...base, user: null };
    const { rows: [r] } = await pool.query("select name, email, lang, extract(epoch from expires_at - now())::int as left from sessions where id = $1", [id]);
    return { ...base, user: uid, name: r?.name ?? "", email: r?.email ?? "", lang: r?.lang ?? "", expiresInSeconds: r?.left ?? 0 };
  });

  // ---- ownership: every id in the request must belong to the caller ----
  // Dispatched on the matched route pattern; ids come from the parsed params, query and body.
  app.addHook("preHandler", async (req) => {
    if (!authOn()) return; // single-user: everything has the empty owner
    const route = matchedRoute(req);
    if (!route.startsWith("/api/") || PUBLIC.some((p) => p.test(route))) return;
    const p = (req.params ?? {}) as Record<string, string>;
    const q = (req.query ?? {}) as Record<string, string>;
    const body = (req.body ?? {}) as Record<string, any>;
    const under = (prefix: string) => route === prefix || route.startsWith(prefix + "/");
    if (route === "/api/accounts/test") { if (body.accountId) await need(req, "account", [String(body.accountId)]); }
    else if (under("/api/accounts/:id")) await need(req, "account", [String(p.id)]);
    else if (under("/api/folders/:id")) await need(req, "folder", [String(p.id)]);
    else if (route === "/api/messages/bulk") {
      await need(req, "message", (body.messageIds ?? []).map(String));
      await need(req, "folder", [body.folderId, body.targetFolderId].filter(Boolean).map(String));
    } else if (under("/api/messages/:id")) await need(req, "message", [String(p.id)]);
    else if (route === "/api/threads/:threadId") await need(req, "folder", [q.folderId].filter(Boolean).map(String));
    else if (under("/api/keys/:id")) await need(req, "key", [String(p.id)]);
    else if (under("/api/outbox/:id")) await need(req, "outbox", [String(p.id)]);
    else if (under("/api/templates/:id")) await need(req, "template", [String(p.id)]);
    else if (route === "/api/contacts" && q.accountId) await need(req, "account", [String(q.accountId)]);
  });
}

const SQL: Record<string, string> = {
  account: "select count(*)::int n from accounts a where a.id = any($1::uuid[]) and a.owner = $2",
  folder: "select count(*)::int n from folders f join accounts a on a.id = f.account_id where f.id = any($1::bigint[]) and a.owner = $2",
  message: "select count(*)::int n from messages m join folders f on f.id = m.folder_id join accounts a on a.id = f.account_id where m.id = any($1::bigint[]) and a.owner = $2",
  key: "select count(*)::int n from crypto_keys k join accounts a on a.id = k.account_id where k.id = any($1::uuid[]) and a.owner = $2",
  outbox: "select count(*)::int n from outbox o join accounts a on a.id = o.account_id where o.id = any($1::bigint[]) and a.owner = $2",
  template: "select count(*)::int n from templates t where t.id = any($1::uuid[]) and t.owner = $2",
};
const IDTYPE: Record<string, RegExp> = { account: /^[0-9a-f-]{36}$/i, key: /^[0-9a-f-]{36}$/i, template: /^[0-9a-f-]{36}$/i, folder: /^\d+$/, message: /^\d+$/, outbox: /^\d+$/ };

async function need(req: FastifyRequest, kind: keyof typeof SQL, ids: string[]) {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return;
  const notFound = () => Object.assign(new Error("Not found"), { statusCode: 404 });
  if (uniq.some((i) => !IDTYPE[kind]!.test(i))) throw notFound();
  const { rows: [r] } = await pool.query(SQL[kind]!, [uniq, req.owner]);
  if (r.n !== uniq.length) throw notFound(); // not yours looks exactly like not there
}

/** The owner of an account (for server-side lookups on its behalf). */
export async function ownerOf(accountId: string): Promise<string> {
  const { rows: [r] } = await pool.query("select owner from accounts where id = $1", [accountId]);
  return r?.owner ?? "";
}

/** What a browser tab gets when it opens the service directly instead of through Nextcloud. */
function openFromNextcloud(): string {
  const href = `${nc()}/index.php/apps/ncmail/`;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mail</title>
<style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f5f5f5;color:#222}
main{max-width:28rem;padding:2rem;background:#fff;border-radius:12px;box-shadow:0 2px 12px #0002}a{color:#0b6dc2}h1{font-size:1.3rem;margin:0 0 .5rem}</style>
<main><h1>Open Mail from Nextcloud</h1><p>This mail app runs inside Nextcloud. Sign in to Nextcloud and choose <b>Mail</b> in its menu.</p><p><a href="${href.replace(/"/g, "")}">Go to Nextcloud</a></p></main>`;
}
