import { dropUploadsOf } from "./uploads.ts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { endSessionsOf } from "./auth.ts";
import { verifySigned } from "./handoff.ts";
import { bgPool, pool, retryOnDeadlock } from "./db.ts";
import { encrypt } from "./crypto.ts";
import { reconcileIdle } from "./idle.ts";
import { READABLE_SQL } from "./acl.ts";
import { dropNcLink, ncBase } from "./nextcloud/link.ts";
import { adminPresets, filePart, presetsSchema, saveAdminPresets, serverSchema } from "./presets.ts";
import { check, probe } from "./mailprobe.ts";
import { checkAll, checkServer, recheck, statuses } from "./serverchecks.ts";
import { discover } from "./discover.ts";
import { MIN_APP_VERSION, SERVICE_VERSION, lastAppVersion, noteAppVersion } from "./compat.ts";
import { otherInstances } from "./instances.ts";

/**
 * Calls from the Nextcloud app to this service (not from browsers). Every one is signed by Nextcloud's private key
 * (see handoff.ts): the menu badge, global search, "the user signed out", and handing over an app password for Files and Contacts.
 */
const uidOf = z.string().min(1).max(256);

export async function internalRoutes(app: FastifyInstance) {
  // This plugin is encapsulated (not wrapped in fastify-plugin), so the hook covers exactly the routes below, whatever the path's spelling.
  app.addHook("preHandler", async (req) => { await verifySigned(req); noteAppVersion(req.headers["x-ncmail-app-version"], req.log); });

  // Both versions, for the admin Mail page (the app compares them with what it needs).
  app.get("/api/internal/version", async () => ({ version: SERVICE_VERSION, minAppVersion: MIN_APP_VERSION, appVersionSeen: lastAppVersion, otherInstances: await otherInstances() }));

  // The user signed out of Nextcloud: end every Mail session at once.
  app.post("/api/internal/logout", async (req) => {
    const { uid } = z.object({ uid: uidOf }).parse(req.body);
    await endSessionsOf(uid);
    return { ok: true };
  });

  // The user was removed from Nextcloud: remove everything kept for that user id, so a later user who is given the
  // same id starts empty.
  app.post("/api/internal/user-deleted", async (req) => {
    const { uid } = z.object({ uid: uidOf }).parse(req.body);
    await endSessionsOf(uid);
    const link = dropNcLink(uid);
    await link.removed; // the app password is taken back in the background; the user is usually gone at Nextcloud already
    // folders, messages, bodies, identities, outbox, keys, calendar links cascade; may collide with a running sync
    await retryOnDeadlock(() => bgPool.query("delete from accounts where owner = $1", [uid]));
    await reconcileIdle(app.log); // stop their IDLE connections now (background sync only visits accounts that exist)
    for (const table of ["templates", "user_prefs", "new_mail", "image_senders"]) await pool.query(`delete from ${table} where owner = $1`, [uid]);
    dropUploadsOf(uid);
    return { ok: true };
  });

  // ---- mail servers set up in Nextcloud's admin settings (only administrators reach these through Nextcloud) ----
  const adminView = async () => {
    const a = adminPresets();
    return { file: filePart(), admin: a.value, updatedAt: a.updatedAt, updatedBy: a.updatedBy, status: await statuses() };
  };
  app.get("/api/internal/mail-servers", async () => adminView());

  app.post("/api/internal/mail-servers", async (req) => {
    const b = z.object({ uid: z.string().max(256).default(""), config: presetsSchema }).parse(req.body);
    const ids = new Set<string>();
    const fileIds = new Set(filePart().servers.map((s) => s.id));
    for (const s of b.config.servers) {
      if (ids.has(s.id)) throw Object.assign(new Error(`Two servers have the id ${s.id}.`), { statusCode: 400 });
      if (fileIds.has(s.id)) throw Object.assign(new Error(`The id ${s.id} is already used in the configuration file.`), { statusCode: 400 });
      ids.add(s.id);
    }
    const before = new Map(adminPresets().value.servers.map((s) => [s.id, JSON.stringify(s)]));
    await saveAdminPresets(b.config, b.uid);
    // new and changed servers are checked right away, so their state shows on the page
    recheck(b.config.servers.filter((s) => before.get(s.id) !== JSON.stringify(s)));
    app.log.info({ by: b.uid, servers: b.config.servers.length, allowCustom: b.config.allowCustom }, "mail servers changed in Nextcloud's admin settings");
    return adminView();
  });

  // Does each server answer (and is its certificate valid)? No login is tried. A failing one comes with a port that works, if any.
  app.post("/api/internal/mail-servers/check", async (req) => {
    const b = z.object({ imap: serverSchema, smtp: serverSchema, sieve: serverSchema.nullish() }).parse(req.body);
    return checkServer({ imap: b.imap, smtp: b.smtp, sieve: b.sieve ?? undefined });
  });

  // Check every listed server now, and store the results for the page.
  app.post("/api/internal/mail-servers/check-all", async () => ({ status: await checkAll() }));

  // Find a domain's servers (autoconfig, DNS, Thunderbird's list) and check them.
  app.post("/api/internal/mail-servers/discover", async (req) => {
    const { domain } = z.object({ domain: z.string().max(253) }).parse(req.body);
    const found = await discover(domain);
    if (!found) return { found: null };
    // filters are rarely published: try the usual place, next to the IMAP server
    const sieve = found.sieve ?? { host: found.imap.host, port: 4190, security: "starttls" as const };
    // these servers come from the domain's own answers, not from the administrator: the address policy applies to them
    const [imap, smtp, sv] = await Promise.all([check("imap", found.imap, undefined, true), check("smtp", found.smtp, undefined, true), found.sieve ? check("sieve", sieve, undefined, true) : probe("sieve", sieve, 3000, true)]);
    return { found: { ...found, sieve: sv.ok ? sieve : undefined }, status: { imap, smtp, sieve: sv.ok ? sv : null } };
  });

  // Unread mail in the inboxes (for the badge on Mail's menu entry).
  app.get<{ Querystring: { uid?: string } }>("/api/internal/unread", async (req) => {
    const uid = uidOf.parse(req.query.uid);
    const { rows: [r] } = await pool.query(
      `select coalesce(sum(f.unseen), 0)::int as n from folders f join accounts a on a.id = f.account_id where a.owner = $1 and f.special_use = '\\Inbox'`, [uid]);
    return { unread: r.n };
  });

  // Nextcloud's global search: mail already mirrored here (no server round trips, so it answers fast).
  app.get<{ Querystring: { uid?: string; q?: string; limit?: string } }>("/api/internal/search", async (req) => {
    const uid = uidOf.parse(req.query.uid);
    const q = String(req.query.q ?? "").trim().slice(0, 200);
    if (!q) return { items: [] };
    const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    const { rows } = await pool.query(
      `select m.id, m.subject, m.from_name, m.from_addr, m.date, f.account_id, f.id as folder_id
         from messages m join folders f on f.id = m.folder_id join accounts a on a.id = f.account_id
        where a.owner = $1 and (f.special_use is null or f.special_use not in ('\\Trash', '\\Junk')) and ${READABLE_SQL}
          and (m.subject ilike $2 or m.from_name ilike $2 or m.from_addr ilike $2)
        order by m.date desc limit $3`, [uid, like, Math.min(Number(req.query.limit) || 10, 25)]);
    return { items: rows.map((r) => ({ id: String(r.id), accountId: r.account_id, folderId: String(r.folder_id), subject: r.subject, from: r.from_name || r.from_addr, date: r.date })) };
  });

  // New mail for Nextcloud's notifications. Nextcloud's background job asks about once a minute; each message is handed
  // out once ("new"), and once it is read, moved or deleted it is reported back ("done") so the notification goes away.
  app.post("/api/internal/notifications", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      // nothing piles up while Nextcloud's background jobs are not running, and old announcements are let go
      await client.query("delete from new_mail where (delivered_at is null and created_at < now() - interval '1 day') or delivered_at < now() - interval '14 days'");
      const { rows: fresh } = await client.query(
        `with picked as (
           select n.message_id from new_mail n where n.delivered_at is null order by n.message_id limit 200 for update skip locked)
         update new_mail n set delivered_at = now() from picked where n.message_id = picked.message_id
         returning n.message_id, n.owner`);
      const ids = fresh.map((r) => r.message_id);
      const { rows: info } = ids.length ? await client.query(
        `select m.id, m.subject, m.from_name, m.from_addr, m.date, a.name as account, ('\\Seen' = any(m.flags)) as seen,
                coalesce(p.notify_new_mail, true) as wanted
           from messages m join folders f on f.id = m.folder_id join accounts a on a.id = f.account_id
           left join user_prefs p on p.owner = a.owner
          where m.id = any($1::bigint[])`, [ids]) : { rows: [] as any[] };
      const byId = new Map(info.map((r) => [String(r.id), r]));
      const items = fresh.flatMap((n) => {
        const m = byId.get(String(n.message_id));
        // read, moved or deleted before Nextcloud got to it, or notifications switched off: nothing to announce
        if (!m || m.seen || !m.wanted) return [];
        return [{ uid: n.owner, id: String(m.id), subject: m.subject, from: m.from_name || m.from_addr, fromAddr: m.from_addr, account: m.account, date: m.date }];
      });
      const announced = new Set(items.map((i) => i.id));
      const skipped = ids.filter((id) => !announced.has(String(id)));
      if (skipped.length) await client.query("delete from new_mail where message_id = any($1::bigint[])", [skipped]);
      // announced earlier and since read, moved out of the inbox or deleted (or notifications switched off): take them back
      const { rows: done } = await client.query(
        `delete from new_mail n
          where n.delivered_at is not null and not (n.message_id = any($1::bigint[])) and (
            not exists (select 1 from messages m join folders f on f.id = m.folder_id
                         where m.id = n.message_id and f.special_use = '\\Inbox' and not ('\\Seen' = any(m.flags)))
            or exists (select 1 from user_prefs p where p.owner = n.owner and not p.notify_new_mail))
          returning n.message_id, n.owner`, [ids]);
      await client.query("commit");
      return { new: items, done: done.map((r) => ({ uid: r.owner, id: String(r.message_id) })) };
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  });

  // Nextcloud created an app password for this user: keep it, so Files and Contacts work without a separate sign-in.
  app.post("/api/internal/link", async (req) => {
    const b = z.object({ uid: uidOf, loginName: z.string().min(1).max(256), appPassword: z.string().min(8).max(512) }).parse(req.body);
    await pool.query(
      `insert into nextcloud_links (owner, base_url, username, password_enc) values ($1,$2,$3,$4)
       on conflict (owner) do update set base_url = excluded.base_url, username = excluded.username, password_enc = excluded.password_enc`,
      [b.uid, ncBase(), b.loginName, encrypt(b.appPassword)]);
    return { ok: true };
  });
}
