import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { isIP } from "node:net";
import type { FastifyRequest } from "fastify";
import { pool } from "./db.ts";
import { isPrivateIp } from "./netguard.ts";

/**
 * Nextcloud vouches for who the user is. The Nextcloud app signs short-lived tokens (and server-to-server requests) with an
 * Ed25519 private key that never leaves Nextcloud; this service only holds the public key and can verify, never forge.
 *
 *   public key: NCMAIL_HANDOFF_PUBLIC_KEY (base64, 32 bytes) if set, otherwise fetched from <NEXTCLOUD_URL>/index.php/apps/ncmail/key
 *               (over plain http only from a loopback or private address, see keyFetchAllowed)
 *   token:      v1.<base64url JSON>.<base64url signature>, valid for at most 2 minutes, usable once
 */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex"); // wraps a raw 32-byte Ed25519 key
const b64u = (s: string) => Buffer.from(s, "base64url");
const nc = () => (process.env.NEXTCLOUD_URL ?? "").replace(/\/+$/, "");
const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/**
 * Whether the signing key may be fetched from this Nextcloud address. Over plain http anyone on the path could swap the key and
 * then sign in as anybody, so http is only used for a loopback or private address (development, a container network), a
 * single-label host name (a container's service name), or with NCMAIL_HANDOFF_KEY_HTTP=1.
 */
export function keyFetchAllowed(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === "https:") return true;
  if (u.protocol !== "http:") return false;
  if (env.NCMAIL_HANDOFF_KEY_HTTP === "1") return true;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(host)) return isPrivateIp(host);
  return host === "localhost" || host.endsWith(".localhost") || !host.includes(".");
}

let keys: { id: string; key: KeyObject }[] = [];
let fetchedAt = 0;
const toKey = (raw: Buffer) => createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });

async function loadKeys(force = false) {
  const pinned = (process.env.NCMAIL_HANDOFF_PUBLIC_KEY ?? "").trim();
  if (pinned) {
    if (!keys.length) keys = pinned.split(",").map((k) => k.trim()).filter(Boolean).map((k) => { const raw = Buffer.from(k, "base64"); if (raw.length !== 32) throw new Error("NCMAIL_HANDOFF_PUBLIC_KEY must be a base64 Ed25519 public key (32 bytes)"); return { id: "pinned", key: toKey(raw) }; });
    return;
  }
  if (!force && keys.length && Date.now() - fetchedAt < 10 * 60_000) return;
  if (Date.now() - fetchedAt < 30_000 && keys.length) return; // do not hammer Nextcloud when tokens keep failing
  fetchedAt = Date.now();
  if (!keyFetchAllowed(nc())) throw httpError(503, "Nextcloud's signing key is not fetched over plain http. Use an https NEXTCLOUD_URL or pin NCMAIL_HANDOFF_PUBLIC_KEY.");
  const r = await fetch(`${nc()}/index.php/apps/ncmail/key`, { headers: { "OCS-APIRequest": "true", accept: "application/json" }, signal: AbortSignal.timeout(8000) })
    .catch((e) => { throw httpError(503, `Could not reach Nextcloud to get its signing key (${e.cause?.code ?? e.message})`); });
  if (!r.ok) throw httpError(503, "Nextcloud has no Mail app signing key yet (is the Mail app enabled?)");
  const j: any = await r.json();
  const list: { kid: string; publicKey: string }[] = j.keys ?? [{ kid: j.kid, publicKey: j.publicKey }];
  keys = list.map((k) => ({ id: k.kid, key: toKey(Buffer.from(k.publicKey, "base64")) }));
}

async function check(message: string, sig: Buffer): Promise<boolean> {
  await loadKeys();
  if (keys.some((k) => verify(null, Buffer.from(message), k.key, sig))) return true;
  if (process.env.NCMAIL_HANDOFF_PUBLIC_KEY) return false;
  await loadKeys(true); // the key may have been rotated
  return keys.some((k) => verify(null, Buffer.from(message), k.key, sig));
}

export interface HandoffClaims { uid: string; name: string; email: string; lang: string; jti: string; iat: number; exp: number; aud: string }

/** An address in a comparable form: origin and path, without a trailing slash; "" when it is not an http(s) URL. */
export const normalUrl = (s: string) => {
  try { const u = new URL(s); return /^https?:$/.test(u.protocol) ? `${u.origin}${u.pathname.replace(/\/+$/, "")}` : ""; } catch { return ""; }
};

/**
 * Checks the claims of a correctly signed token: a user id, an id for single use, numeric times within a lifetime of at most
 * two minutes, and an audience. The Nextcloud app always sets aud to the address it frames (its "url" setting). It is compared
 * with NCMAIL_PUBLIC_URL when that is set; without it there is nothing reliable to compare with (the Host header is chosen by
 * whoever sends the request, and proxies often rewrite it), so then aud only has to be present and well formed.
 */
export function claimsProblem(c: any, now: number, publicUrl = process.env.NCMAIL_PUBLIC_URL ?? ""): "expired" | "invalid" | null {
  if (!c || typeof c !== "object" || !c.uid || typeof c.uid !== "string" || c.uid.length > 256 || !c.jti || typeof c.jti !== "string") return "invalid";
  if (typeof c.aud !== "string" || !normalUrl(c.aud)) return "invalid";
  if (publicUrl.trim() && normalUrl(c.aud) !== normalUrl(publicUrl.trim())) return "invalid";
  if (typeof c.iat !== "number" || typeof c.exp !== "number" || !Number.isFinite(c.iat) || !Number.isFinite(c.exp) || c.iat > c.exp) return "invalid";
  if (!(c.exp > now - 5) || c.iat > now + 30 || c.exp - c.iat > 120) return "expired";
  return null;
}

export async function verifyHandoff(token: string): Promise<HandoffClaims> {
  const bad = () => httpError(401, "This sign-in link is not valid. Open Mail from Nextcloud again.");
  const [v, payload, sig] = String(token).split(".");
  if (v !== "v1" || !payload || !sig || token.length > 4096) throw bad();
  if (!(await check(`ncmail-handoff-v1.${payload}`, b64u(sig)))) throw bad();
  let c: HandoffClaims;
  try { c = JSON.parse(b64u(payload).toString()); } catch { throw bad(); }
  const problem = claimsProblem(c, Math.floor(Date.now() / 1000));
  if (problem === "expired") throw httpError(401, "This sign-in link has expired. Open Mail from Nextcloud again.");
  if (problem) throw bad();
  // each token works once
  await pool.query("delete from handoff_used where exp < now()");
  const { rowCount } = await pool.query("insert into handoff_used (jti, exp) values ($1, now() + interval '5 minutes') on conflict do nothing", [c.jti]);
  if (!rowCount) throw bad();
  return c;
}

/** A host as a Host header names it: lower case, without the default port of either scheme. */
export const normalHost = (h: string) => h.trim().toLowerCase().replace(/:(80|443)$/, "");

/**
 * What a server-to-server call signs, including the host the request is addressed to, so a call signed for one mail service
 * cannot be replayed at another that trusts the same Nextcloud. ("v2": the format before it, without the host, is not accepted.)
 */
export function s2sMessage(o: { method: string; host: string; url: string; ts: number | string; nonce: string; body: string | Buffer }): string {
  return ["ncmail-s2s-v2", o.method, normalHost(o.host), o.url, String(o.ts), o.nonce, createHash("sha256").update(o.body).digest("hex")].join("\n");
}

/** Server-to-server calls from the Nextcloud app: signed over method, host, path, time, nonce and body. */
export async function verifySigned(req: FastifyRequest): Promise<void> {
  const bad = () => httpError(401, "Request not signed by Nextcloud");
  const ts = Number(req.headers["x-ncmail-ts"]), nonce = String(req.headers["x-ncmail-nonce"] ?? ""), sig = String(req.headers["x-ncmail-sig"] ?? "");
  if (!ts || !nonce || nonce.length > 64 || !sig || Math.abs(Date.now() / 1000 - ts) > 120 || req.headers["x-ncmail-sig-version"] !== "2") throw bad();
  // The Host header as received: the Nextcloud app signs the host of the address it sends to, so a proxy in between must keep it.
  const msg = s2sMessage({ method: req.method, host: String(req.headers.host ?? ""), url: req.url, ts, nonce, body: (req as any).rawBody ?? "" });
  if (!(await check(msg, b64u(sig)))) throw bad();
  const { rowCount } = await pool.query("insert into handoff_used (jti, exp) values ($1, now() + interval '5 minutes') on conflict do nothing", ["s2s:" + nonce]);
  if (!rowCount) throw bad();
}
