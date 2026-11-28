import type { FastifyInstance } from "fastify";
import { publish } from "../events.ts";
import { internalHeaders, ownerOf } from "../auth.ts";
import { getNcLink } from "../nextcloud/link.ts";
import { simpleParser, type ParsedMail } from "mailparser";
import { z } from "zod";
import { pool } from "../db.ts";
import { encrypt, decrypt } from "../crypto.ts";
import { loadAccount } from "../accounts.ts";
import { downloadRaw, withImap } from "../mail.ts";
import { loadMessage } from "../routes.ts";
import { discoverCalendars, getObject, getObjectTagged, homeUrl, normalizeBase, putObject, type DavCfg } from "./caldav.ts";
import { myAnswer, parseIcs, toCalendarObject, type IcsEvent } from "./ics.ts";

/**
 * Invitations that arrive by mail are put into the user's Nextcloud calendar as tentative entries, with the answer left open,
 * so the calendar app offers Accept / Tentative / Decline (and Nextcloud sends the reply to the organizer itself).
 */

export interface Link extends DavCfg { accountId: string; calendarUrl: string; calendarName: string; autoImport: boolean }
const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

export async function getLink(accountId: string): Promise<Link | null> {
  const { rows: [r] } = await pool.query("select * from calendar_links where account_id = $1", [accountId]);
  return r ? { accountId, baseUrl: r.base_url, username: r.username, password: decrypt(r.password_enc), calendarUrl: r.calendar_href, calendarName: r.calendar_name, autoImport: r.auto_import } : null;
}
const myEmails = async (accountId: string) => (await pool.query("select email from identities where account_id = $1", [accountId])).rows.map((r) => r.email.toLowerCase() as string);

export type ImportResult = { action: "added" | "updated" | "cancelled" | "skipped"; reason?: string; uid?: string };

/** The calendar parts (text/calendar or .ics attachments) of a message. */
export async function icsParts(raw: Buffer): Promise<string[]> {
  return icsPartsOf(await simpleParser(raw));
}
const icsPartsOf = (p: ParsedMail) =>
  p.attachments.filter((a) => /^(text\/calendar|application\/ics)/i.test(a.contentType) || /\.ics$/i.test(a.filename ?? "")).map((a) => a.content.toString("utf8"));

/**
 * Put one invitation (a whole .ics) into the calendar. `force` is for the manual button: it also re-adds what the user deleted and
 * accepts changes from anyone. `sender` is the message's From address: automatic changes to an event already in the calendar are
 * only applied when they come from that event's organizer (RFC 5546).
 */
export async function importIcs(link: Link, text: string, mine: string[], messageId: string | null, force = false, sender = ""): Promise<ImportResult> {
  const parsed = parseIcs(text);
  const method = parsed.method || "PUBLISH";
  const ev = parsed.events[0];
  if (!ev) return { action: "skipped", reason: "no event" };
  if (!["REQUEST", "PUBLISH", "CANCEL"].includes(method)) return { action: "skipped", reason: `${method.toLowerCase()} messages are not added`, uid: ev.uid };
  if (ev.organizer && mine.includes(ev.organizer.email)) return { action: "skipped", reason: "you organized this", uid: ev.uid };
  const seq = Math.max(...parsed.events.map((e: IcsEvent) => e.sequence));
  const url = new URL(`${encodeURIComponent(ev.uid)}.ics`, link.calendarUrl.endsWith("/") ? link.calendarUrl : link.calendarUrl + "/").toString();
  const { rows: [prior] } = await pool.query("select sequence from calendar_imports where account_id = $1 and uid = $2 and recurrence_id = ''", [link.accountId, ev.uid]);
  if (!force && prior && (method === "CANCEL" ? seq < prior.sequence : seq <= prior.sequence)) return { action: "skipped", reason: "already added", uid: ev.uid };

  const tagged = await getObjectTagged(link, url);
  const existing = tagged?.ics ?? null;
  if (!existing && prior && !force) return { action: "skipped", reason: "you removed it from your calendar", uid: ev.uid };
  if (!existing && method === "CANCEL") return { action: "skipped", reason: "cancelled, and it was never in your calendar", uid: ev.uid };
  const keep = existing ? myAnswer(existing, mine) : undefined;
  if (existing && !force) {
    const org = parseIcs(existing).events[0]?.organizer?.email ?? "";
    if (!org || ev.organizer?.email !== org || sender.toLowerCase() !== org) return { action: "skipped", reason: "not sent by the organizer; use Add to calendar to apply it", uid: ev.uid };
    if (method === "CANCEL" ? keep!.sequence > seq : keep!.sequence >= seq) return { action: "skipped", reason: "your calendar already has this version", uid: ev.uid };
  }

  const obj = toCalendarObject(text, mine, { cancel: method === "CANCEL", keep });
  const r = await putObject(link, url, obj, !existing, tagged?.etag || undefined);
  if (r === "exists") return { action: "skipped", reason: "already in your calendar", uid: ev.uid };
  if (r === "changed") return { action: "skipped", reason: "the calendar entry changed meanwhile", uid: ev.uid };
  await pool.query(
    `insert into calendar_imports (account_id, uid, recurrence_id, sequence, href, status, message_id) values ($1,$2,'',$3,$4,$5,$6)
     on conflict (account_id, uid, recurrence_id) do update set sequence = excluded.sequence, status = excluded.status, imported_at = now(), message_id = excluded.message_id,
       answer = case when calendar_imports.answer = 'removed' then '' else calendar_imports.answer end`,
    [link.accountId, ev.uid, seq, url, method === "CANCEL" ? "cancelled" : "tentative", messageId]);
  return { action: method === "CANCEL" ? "cancelled" : existing ? "updated" : "added", uid: ev.uid };
}

export async function importMessage(link: Link, raw: Buffer, messageId: string | null, force = false): Promise<ImportResult[]> {
  const mine = await myEmails(link.accountId);
  const p = await simpleParser(raw);
  const sender = p.from?.value[0]?.address ?? "";
  const out: ImportResult[] = [];
  for (const t of icsPartsOf(p)) out.push(await importIcs(link, t, mine, messageId, force, sender));
  return out;
}

// ---- your answer in the calendar, carried back to the mail ----
const ANSWER: Record<string, string> = { ACCEPTED: "accepted", DECLINED: "declined", TENTATIVE: "tentative" };
interface ImportRow { uid: string; href: string; answer: string; message_id: string | null }

/**
 * Look at the calendar's copy of an event to see how you answered. The first answer marks the invitation mail as read;
 * declining also files it in Archive (it is still there, and a decline is undone by answering again in the calendar).
 */
export async function syncAnswer(app: FastifyInstance, link: Link, row: ImportRow, mine: string[]): Promise<string> {
  const obj = await getObject(link, row.href);
  const answer = obj === null ? "removed" : ANSWER[myAnswer(obj, mine).partstat ?? ""] ?? "";
  if (answer === row.answer) return answer;
  await pool.query("update calendar_imports set answer = $3 where account_id = $1 and uid = $2 and recurrence_id = ''", [link.accountId, row.uid, answer]);
  if (row.message_id && answer && answer !== "removed") {
    const { rows: [m] } = await pool.query("select m.id, f.special_use, (select id from folders where account_id = f.account_id and special_use = '\\Archive') as archive from messages m join folders f on f.id = m.folder_id where m.id = $1", [row.message_id]);
    if (m) {
      await app.inject({ method: "POST", url: "/api/messages/bulk", headers: internalHeaders(await ownerOf(link.accountId)), payload: { action: "read", messageIds: [String(m.id)] } });
      if (answer === "declined" && m.archive && m.special_use === "\\Inbox") await app.inject({ method: "POST", url: "/api/messages/bulk", headers: internalHeaders(await ownerOf(link.accountId)), payload: { action: "move", messageIds: [String(m.id)], targetFolderId: String(m.archive) } });
    }
    publish({ type: "sync", accountId: link.accountId });
  }
  return answer;
}

/** Check every recent invitation that was put in a calendar. Run regularly and on demand. */
export async function pollAnswers(app: FastifyInstance, accountId?: string) {
  const { rows } = await pool.query(
    `select i.account_id, i.uid, i.href, i.answer, i.message_id from calendar_imports i
     where i.status = 'tentative' and i.answer <> 'removed' and i.imported_at > now() - interval '45 days' and ($1::uuid is null or i.account_id = $1)
     order by i.imported_at desc limit 200`, [accountId ?? null]);
  const byAccount = new Map<string, any[]>();
  for (const r of rows) byAccount.set(r.account_id, [...(byAccount.get(r.account_id) ?? []), r]);
  const checkAccount = async (acc: string, list: any[]) => {
    const link = await getLink(acc);
    if (!link) return;
    const mine = await myEmails(acc);
    for (const r of list) { try { await syncAnswer(app, link, r, mine); } catch (e: any) { app.log.warn({ err: e.message }, "calendar answer check failed"); break; } }
  };
  // a few accounts at a time, each on its own, so one slow calendar server only delays its own account
  const queue = [...byAccount];
  const failed: unknown[] = [];
  const worker = async () => { for (let next = queue.shift(); next; next = queue.shift()) await checkAccount(...next).catch((e) => failed.push(e)); };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  if (failed.length) throw failed[0];
}

export function startCalendarSync(app: FastifyInstance) {
  let busy = false;
  setInterval(() => { if (busy) return; busy = true; pollAnswers(app).catch((e) => app.log.warn({ err: e.message }, "calendar poll failed")).finally(() => { busy = false; }); }, Number(process.env.NCMAIL_CALENDAR_POLL_MS ?? 60_000)).unref();
}

// ---- new mail: called from sync with the UIDs of messages that carry a calendar part ----
const DAY = 86400_000;
export function queueInvites(accountId: string, folderId: string, uids: number[], log: { warn: (...a: any[]) => void; info: (...a: any[]) => void }) {
  void (async () => {
    const link = await getLink(accountId);
    if (!link?.autoImport) return;
    const { rows: [f] } = await pool.query("select path, special_use from folders where id = $1", [folderId]);
    if (f?.special_use !== "\\Inbox") return;
    const { rows } = await pool.query("select id, uid from messages where folder_id = $1 and uid = any($2::bigint[]) and date > now() - interval '14 days' order by date desc limit 25", [folderId, uids]);
    if (!rows.length) return;
    const cfg = await loadAccount(accountId);
    await withImap(cfg.imap, async (c) => {
      const lock = await c.getMailboxLock(f.path, { readOnly: true });
      try {
        for (const m of rows) {
          try {
            for (const r of await importMessage(link, await downloadRaw(c, m.uid), String(m.id))) {
              if (r.action === "skipped" && r.reason?.startsWith("not sent by the organizer")) log.info({ uid: r.uid, messageId: m.id, reason: r.reason }, "calendar update not applied automatically");
            }
          } catch (e: any) { log.warn({ err: e.message, uid: m.uid }, "could not add an invitation to the calendar"); }
        }
      } finally { lock.release(); }
    });
  })().catch((e) => log.warn({ err: e.message }, "invitation import failed"));
}
void DAY;

// ---- routes ----
const cfgBody = z.object({ baseUrl: z.string().default(""), username: z.string().default(""), password: z.string().optional(), useConnection: z.boolean().optional() });
const saveBody = cfgBody.extend({ calendarUrl: z.string().min(1), calendarName: z.string().default(""), autoImport: z.boolean().default(true) });

export async function calendarRoutes(app: FastifyInstance) {
  const cred = async (accountId: string, b: z.infer<typeof cfgBody>, owner: string): Promise<DavCfg> => {
    if (b.useConnection) { // the user's connection to Nextcloud (Settings > Nextcloud) already holds the credentials
      const nl = await getNcLink(owner);
      if (!nl) throw httpError(400, "Connect your Nextcloud first under Settings > Nextcloud.");
      return { baseUrl: nl.baseUrl, username: nl.username, password: nl.password };
    }
    if (!b.baseUrl || !b.username) throw httpError(400, "Enter the Nextcloud address and user name.");
    const old = (await ownerOf(accountId)) === owner ? await getLink(accountId) : null; // a stored password is only reused for its owner
    const password = b.password || (old && old.username === b.username ? old.password : "");
    if (!password) throw httpError(400, "Enter the password (an app password if you use two-factor sign-in).");
    return { baseUrl: normalizeBase(b.baseUrl), username: b.username, password };
  };

  app.get<{ Params: { id: string } }>("/api/accounts/:id/calendar", async (req) => {
    const l = await getLink(req.params.id);
    return { linked: !!l, baseUrl: l?.baseUrl ?? "", username: l?.username ?? "", calendarUrl: l?.calendarUrl ?? "", calendarName: l?.calendarName ?? "", autoImport: l?.autoImport ?? true, suggestedUrl: process.env.NEXTCLOUD_URL ?? "" };
  });

  app.post<{ Params: { id: string } }>("/api/accounts/:id/calendar/discover", async (req) => {
    const c = await cred(req.params.id, cfgBody.parse(req.body), req.owner);
    return { calendars: (await discoverCalendars(c)).map((x) => ({ url: x.url, name: x.name })) };
  });

  app.put<{ Params: { id: string } }>("/api/accounts/:id/calendar", async (req) => {
    const b = saveBody.parse(req.body);
    const c = await cred(req.params.id, b, req.owner);
    if (!(await discoverCalendars(c)).some((x) => x.url === b.calendarUrl)) throw httpError(400, "That calendar was not found on the server.");
    await pool.query(
      `insert into calendar_links (account_id, base_url, username, password_enc, calendar_href, calendar_name, auto_import) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (account_id) do update set base_url = excluded.base_url, username = excluded.username, password_enc = excluded.password_enc,
         calendar_href = excluded.calendar_href, calendar_name = excluded.calendar_name, auto_import = excluded.auto_import`,
      [req.params.id, c.baseUrl, c.username, encrypt(c.password), b.calendarUrl, b.calendarName, b.autoImport]);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/accounts/:id/calendar", async (req, reply) => {
    await pool.query("delete from calendar_links where account_id = $1", [req.params.id]);
    await pool.query("delete from calendar_imports where account_id = $1", [req.params.id]);
    reply.code(204);
  });

  app.post<{ Params: { id: string } }>("/api/accounts/:id/calendar/sync", async (req) => { await pollAnswers(app, req.params.id); return { ok: true }; });

  // ---- one message's invitation ----
  const raw = async (m: any) => {
    const cfg = await loadAccount(m.account_id);
    return withImap(cfg.imap, async (c) => {
      const lock = await c.getMailboxLock(m.folder_path);
      try { return await downloadRaw(c, m.uid); }
      finally { lock.release(); }
    });
  };
  app.get<{ Params: { id: string } }>("/api/messages/:id/invite", async (req) => {
    const m = await loadMessage(req.params.id, req.owner);
    const parts = await icsParts(await raw(m));
    const parsed = parts.map(parseIcs).find((p) => p.events.length);
    if (!parsed) return null;
    const e = parsed.events[0]!;
    const link = await getLink(m.account_id);
    let { rows: [imp] } = await pool.query("select uid, href, status, sequence, answer, message_id from calendar_imports where account_id = $1 and uid = $2 and recurrence_id = ''", [m.account_id, e.uid]);
    if (imp && link) { try { imp.answer = await syncAnswer(app, link, imp, await myEmails(m.account_id)); } catch { /* the calendar is unreachable: show what we last knew */ } }
    return {
      method: parsed.method || "PUBLISH", summary: e.summary, start: e.start, end: e.end, allDay: e.allDay, location: e.location,
      organizer: e.organizer, attendees: e.attendees.length, status: e.status,
      linked: !!link, calendarName: link?.calendarName ?? "", imported: imp?.status ?? null, answer: imp?.answer ?? "",
      calendarAppUrl: link ? `${link.baseUrl}/apps/calendar/` : null,
    };
  });
  app.post<{ Params: { id: string } }>("/api/messages/:id/invite/add", async (req) => {
    const m = await loadMessage(req.params.id, req.owner);
    const link = await getLink(m.account_id);
    if (!link) throw httpError(400, "Connect your calendar first under Settings > Calendar.");
    const r = await importMessage(link, await raw(m), String(m.id), true);
    return { results: r };
  });
}
void homeUrl;
