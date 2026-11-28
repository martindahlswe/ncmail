import type { FastifyInstance } from "fastify";
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { pool } from "./db.ts";
import { discover, type Discovery } from "./discover.ts";

/**
 * Mail servers set up once for everybody, so users only enter their address and password. They come from two places, merged:
 *  - Nextcloud's admin settings (Administration > Additional > Mail), saved here through a signed call from the Nextcloud app;
 *  - NCMAIL_MAIL_CONFIG=/path/to/mail-servers.json, for deployments managed as files (re-read when the file changes):
 *
 *   { "allowCustom": true,
 *     "servers": [ { "id": "corp", "name": "Company mail", "domains": ["example.com"], "username": "email",
 *                    "imap": { "host": "imap.example.com", "port": 993, "security": "tls" },
 *                    "smtp": { "host": "smtp.example.com", "port": 465, "security": "tls" },
 *                    "sieve": { "host": "imap.example.com", "port": 4190, "security": "starttls" } } ] }
 *
 * username: "email" (the address), "local" (the part before @) or "uid" (the Nextcloud user id).
 * allowCustom: false locks users to the listed servers; true (the default) lets them enter their own when theirs is not listed.
 * When both places set it, the stricter one wins: either can lock users to the list.
 */
const host = z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9._:\-\[\]]+$/, "Enter a host name or address, without http:// or a path");
export const serverSchema = z.object({ host, port: z.number().int().min(1).max(65535), security: z.enum(["tls", "starttls", "none"]) });
const entry = z.object({
  id: z.string().min(1).max(64), name: z.string().trim().min(1).max(100),
  domains: z.array(z.string().trim().toLowerCase().max(253)).max(50).default([]).transform((d) => [...new Set(d.filter(Boolean).map((x) => x.replace(/^@/, "")))]),
  username: z.enum(["email", "local", "uid"]).default("email"),
  imap: serverSchema, smtp: serverSchema, sieve: serverSchema.optional(),
});
export const presetsSchema = z.object({ allowCustom: z.boolean().default(true), servers: z.array(entry).max(50).default([]) });
export type MailPresets = z.infer<typeof presetsSchema>;
export type MailServerPreset = MailPresets["servers"][number];
const EMPTY = (): MailPresets => ({ allowCustom: true, servers: [] });

// ---- the file ----
let cache: { file: string; mtime: number; value: MailPresets } | null = null;
export function filePresets(): MailPresets {
  const file = process.env.NCMAIL_MAIL_CONFIG;
  if (!file) return EMPTY();
  const mtime = statSync(file).mtimeMs;
  if (cache?.file === file && cache.mtime === mtime) return cache.value;
  const value = presetsSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  cache = { file, mtime, value };
  return value;
}
const safeFile = (): MailPresets => { try { return filePresets(); } catch (e: any) { console.error("NCMAIL_MAIL_CONFIG is not valid:", e.message); return EMPTY(); } };

// ---- Nextcloud's admin settings: kept in the database, read into memory (and re-read now and then, for other instances) ----
let admin: { value: MailPresets; updatedAt: string | null; updatedBy: string } = { value: EMPTY(), updatedAt: null, updatedBy: "" };
export async function loadAdminPresets() {
  const { rows: [r] } = await pool.query("select config, updated_at, updated_by from mail_server_config where id = 1");
  if (!r) { admin = { value: EMPTY(), updatedAt: null, updatedBy: "" }; return admin; }
  const parsed = presetsSchema.safeParse(r.config);
  if (!parsed.success) console.error("The mail servers saved in Nextcloud's admin settings are not valid:", parsed.error.message);
  admin = { value: parsed.success ? parsed.data : EMPTY(), updatedAt: r.updated_at.toISOString(), updatedBy: r.updated_by };
  return admin;
}
export const adminPresets = () => admin;
export async function saveAdminPresets(value: MailPresets, by: string) {
  await pool.query(
    `insert into mail_server_config (id, config, updated_at, updated_by) values (1, $1, now(), $2)
     on conflict (id) do update set config = excluded.config, updated_at = now(), updated_by = excluded.updated_by`, [JSON.stringify(value), by]);
  return loadAdminPresets();
}
export function startAdminPresetRefresh() {
  setInterval(() => { loadAdminPresets().catch(() => {}); }, 30_000).unref();
}

/** Everything that applies: the file's servers, then the admin settings' (a file entry wins over one with the same id). */
export const safePresets = (): MailPresets => {
  const f = safeFile();
  const a = admin.value;
  const ids = new Set(f.servers.map((s) => s.id));
  return { allowCustom: f.allowCustom && a.allowCustom, servers: [...f.servers, ...a.servers.filter((s) => !ids.has(s.id))] };
};
/** The file's part on its own, for the admin page (shown read-only there). */
export const filePart = () => ({ configured: !!process.env.NCMAIL_MAIL_CONFIG, ...safeFile() });

/**
 * The mail servers the administrator chose, as "host:port": a mail connection (IMAP, SMTP, ManageSieve) to exactly one of
 * these may use a private address. Nothing else is trusted for them: not other ports, and not HTTP (calendars,
 * unsubscribe links), so listing an internal mail server does not open the rest of that machine to every user.
 */
export const presetEndpoints = (): Set<string> => new Set(safePresets().servers.flatMap((s) => [s.imap, s.smtp, ...(s.sieve ? [s.sieve] : [])])
  .map((x) => `${x.host.toLowerCase().replace(/^\[|\]$/g, "")}:${x.port}`));

/** With allowCustom off, an account may only use the listed servers. */
export function checkAgainstPresets(imap: { host: string; port: number; security: string }, smtp: { host: string; port: number; security: string }) {
  const p = safePresets();
  if (p.allowCustom || !p.servers.length) return;
  const same = (a: any, b: any) => a.host.toLowerCase() === b.host.toLowerCase() && a.port === b.port && a.security === b.security;
  if (!p.servers.some((s) => same(s.imap, imap) && same(s.smtp, smtp))) throw Object.assign(new Error("Your administrator only allows the mail servers set up for this service."), { statusCode: 400 });
}

/** Lookups people start from the add-account form: a few per person, and each domain's answer kept for an hour. */
const LOOKUPS_PER_USER = 20, LOOKUP_WINDOW_MS = 10 * 60_000, CACHE_MS = 60 * 60_000;
const lookups = new Map<string, number[]>();
const found = new Map<string, { at: number; value: Discovery | null }>();

export async function presetRoutes(app: FastifyInstance) {
  // The servers for the domain of an address someone is adding, when no listed server applies (the same lookup as the admin
  // page: the domain's autoconfig file, its DNS records, Thunderbird's list). Not offered when people are locked to the list.
  app.get<{ Querystring: { email?: string } }>("/api/mail-presets/lookup", async (req, reply) => {
    if (!safePresets().allowCustom) return reply.code(403).send({ error: "Your administrator only allows the mail servers set up for this service." });
    const email = String(req.query.email ?? "").trim().toLowerCase();
    const domain = email.includes("@") ? email.split("@").pop()! : "";
    if (!domain) return reply.code(400).send({ error: "Enter your email address first." });
    const now = Date.now();
    const recent = (lookups.get(req.owner) ?? []).filter((t) => now - t < LOOKUP_WINDOW_MS);
    const hit = found.get(domain);
    if (!hit || now - hit.at > CACHE_MS) {
      if (recent.length >= LOOKUPS_PER_USER) return reply.code(429).send({ error: "Too many lookups. Try again in a few minutes, or enter the servers yourself." });
      lookups.set(req.owner, [...recent, now]);
      found.set(domain, { at: now, value: await discover(domain) });
      if (found.size > 5000) found.delete(found.keys().next().value!);
    }
    return { domain, found: found.get(domain)!.value };
  });

  app.get("/api/mail-presets", async (req) => {
    const p = safePresets();
    const me = await app.inject({ url: "/api/auth/me", headers: { cookie: req.headers.cookie ?? "" } }).then((r) => r.json() as any).catch(() => ({}));
    const email: string = me.email ?? "";
    const domain = email.split("@")[1]?.toLowerCase() ?? "";
    const matching = p.servers.filter((s) => s.domains.some((d) => d.toLowerCase() === domain));
    return {
      allowCustom: p.allowCustom, servers: p.servers,
      suggested: (matching[0] ?? (p.servers.length === 1 ? p.servers[0] : undefined))?.id ?? null,
      user: { uid: req.owner, email, name: me.name ?? "" },
    };
  });
}
