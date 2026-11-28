import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db.ts";
import { loadAccount } from "../accounts.ts";
import { decrypt, encrypt } from "../crypto.ts";
import { safePresets } from "../presets.ts";
import { withSieve, type SieveConn } from "./managesieve.ts";
import { MAX_ACTION_VALUE, SCRIPT_NAME, buildScript, configSchema, emptyConfig, readConfig } from "./script.ts";

/** Filters and the out-of-office reply, kept as a Sieve script on the mail server (so they work while this app is closed). */

/** Where and how to reach the Sieve service: the IMAP login by default, or a separate login when one is saved. */
async function conn(accountId: string, owner: string): Promise<SieveConn & { custom: boolean; separate: boolean }> {
  const cfg = await loadAccount(accountId, owner);
  const { rows: [s] } = await pool.query("select host, port, security, username, password_enc from sieve_settings where account_id = $1", [accountId]);
  const separate = !!(s?.username && s?.password_enc);
  // an administrator's mail-server list can say where Sieve is for these servers
  const listed = s ? undefined : safePresets().servers.find((x) => x.imap.host.toLowerCase() === cfg.imap.host.toLowerCase() && x.sieve)?.sieve;
  return {
    host: s?.host || listed?.host || cfg.imap.host, port: s?.port ?? listed?.port ?? 4190,
    security: s?.security ?? listed?.security ?? (cfg.imap.security === "none" ? "none" : "starttls"),
    username: separate ? s.username : cfg.imap.username, password: separate ? decrypt(s.password_enc) : cfg.imap.password, custom: !!s, separate,
  };
}
const ownAddresses = async (accountId: string) => (await pool.query("select email from identities where account_id = $1", [accountId])).rows.map((r) => r.email as string);

/**
 * Changes to one account's filter script, one at a time: saving filters and pointing them at a renamed folder each read,
 * change and write the whole script, so two at once would lose one of the changes.
 */
const sieveQueue = new Map<string, Promise<unknown>>();
function oneAtATime<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const run = (sieveQueue.get(accountId) ?? Promise.resolve()).catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  sieveQueue.set(accountId, tail);
  void tail.then(() => { if (sieveQueue.get(accountId) === tail) sieveQueue.delete(accountId); });
  return run;
}

export async function sieveRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/api/accounts/:id/sieve", async (req) => {
    const c = await conn(req.params.id, req.owner);
    const connection = { host: c.host, port: c.port, security: c.security, separate: c.separate, username: c.separate ? c.username : "" };
    try {
      return await withSieve(c, async (s) => {
        const scripts = await s.list();
        const ours = scripts.find((x) => x.name === SCRIPT_NAME);
        const active = scripts.find((x) => x.active)?.name ?? "";
        const stored = ours ? readConfig(await s.get(SCRIPT_NAME)) : null;
        return { available: true, connection, config: stored ?? emptyConfig(), active, oursActive: active === SCRIPT_NAME, hasOurs: !!ours, otherActive: active && active !== SCRIPT_NAME ? active : "", ownAddresses: await ownAddresses(req.params.id) };
      });
    } catch (e: any) { return { available: false, error: e.message, connection }; }
  });

  // Upload and switch on. The server checks the script first, so a mistake is reported instead of silently breaking mail delivery.
  app.put<{ Params: { id: string } }>("/api/accounts/:id/sieve", async (req) => {
    const cfg = configSchema.parse(req.body);
    const script = buildScript(cfg, await ownAddresses(req.params.id));
    const c = await conn(req.params.id, req.owner);
    await oneAtATime(req.params.id, () => withSieve(c, async (s) => { await s.check(script); await s.put(SCRIPT_NAME, script); await s.setActive(SCRIPT_NAME); }));
    return { ok: true, script };
  });

  app.post<{ Params: { id: string } }>("/api/accounts/:id/sieve/disable", async (req) => {
    await withSieve(await conn(req.params.id, req.owner), (s) => s.setActive(""));
    return { ok: true };
  });

  app.put<{ Params: { id: string } }>("/api/accounts/:id/sieve/connection", async (req) => {
    const b = z.object({
      host: z.string().default(""), port: z.number().int().min(1).max(65535), security: z.enum(["none", "starttls", "tls"]),
      /** true: log in to Sieve with the mail (IMAP) login. false: with `username` and `password` (a blank password keeps the saved one). */
      useImapLogin: z.boolean().default(true), username: z.string().default(""), password: z.string().optional(),
    }).parse(req.body);
    const { rows: [old] } = await pool.query("select username, password_enc from sieve_settings where account_id = $1", [req.params.id]);
    let user = "", pw: string | null = null;
    if (!b.useImapLogin) {
      if (!b.username.trim()) throw Object.assign(new Error("Enter the user name for the Sieve service."), { statusCode: 400 });
      user = b.username.trim();
      pw = b.password ? encrypt(b.password) : old?.username === user ? old.password_enc : null;
      if (!pw) throw Object.assign(new Error("Enter the password for the Sieve service."), { statusCode: 400 });
    }
    await pool.query(
      `insert into sieve_settings (account_id, host, port, security, username, password_enc) values ($1,$2,$3,$4,$5,$6)
       on conflict (account_id) do update set host = excluded.host, port = excluded.port, security = excluded.security, username = excluded.username, password_enc = excluded.password_enc`,
      [req.params.id, b.host, b.port, b.security, user, pw]);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/accounts/:id/sieve/script", async (req) => {
    const cfg = readConfig(await withSieve(await conn(req.params.id, req.owner), (s) => s.get(SCRIPT_NAME)));
    return { script: cfg ? buildScript(cfg, await ownAddresses(req.params.id)) : "" };
  });
}

/** True when `value` is the folder `path` or one inside it. */
const within = (value: string, path: string, delim: string) => value === path || (!!delim && value.startsWith(path + delim));

/**
 * After a folder was renamed or moved, point the filters that file mail into it (or into its subfolders) at the new place.
 * Filters use `fileinto :create`, so a stale rule would quietly bring the old folder back. Returns how many rules changed;
 * 0 when the account has no filters or the Sieve service cannot be reached (the rename itself has already happened).
 */
export async function renameInFilters(accountId: string, owner: string, from: string, to: string, delim: string): Promise<{ updated: number; skipped: number }> {
  const none = { updated: 0, skipped: 0 };
  try {
    const c = await conn(accountId, owner);
    return await oneAtATime(accountId, () => withSieve(c, async (s) => {
      if (!(await s.list()).some((x) => x.name === SCRIPT_NAME)) return none;
      const cfg = readConfig(await s.get(SCRIPT_NAME));
      if (!cfg) return none;
      let updated = 0, skipped = 0;
      for (const r of cfg.rules) for (const a of r.actions) {
        if (a.type !== "move" || !within(a.value, from, delim)) continue;
        const next = to + a.value.slice(from.length);
        // a folder path longer than a filter may hold would make the saved filters unreadable: leave that rule as it is
        if (next.length > MAX_ACTION_VALUE) { skipped++; continue; }
        a.value = next; updated++;
      }
      if (updated) { const script = buildScript(cfg, await ownAddresses(accountId)); await s.check(script); await s.put(SCRIPT_NAME, script); }
      return { updated, skipped };
    }));
  } catch { return none; }
}

/** How many filter rules file mail into `path` or a folder inside it (0 when the Sieve service cannot be reached). */
export async function filtersUsing(accountId: string, owner: string, path: string, delim: string): Promise<number> {
  try {
    return await withSieve(await conn(accountId, owner), async (s) => {
      if (!(await s.list()).some((x) => x.name === SCRIPT_NAME)) return 0;
      const cfg = readConfig(await s.get(SCRIPT_NAME));
      return (cfg?.rules ?? []).filter((r) => r.enabled && r.actions.some((a) => a.type === "move" && within(a.value, path, delim))).length;
    });
  } catch { return 0; }
}
