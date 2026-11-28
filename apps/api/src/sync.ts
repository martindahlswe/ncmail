import type { ImapFlow } from "imapflow";
import { bgPool as pool, retryOnDeadlock } from "./db.ts"; // background work: not bound by the request statement_timeout
import { loadAccount } from "./accounts.ts";
import { isConnectionLost, withImap, withImapRetry } from "./mail.ts";
import { describeImapError } from "./imapError.ts";
import { publish } from "./events.ts";
import { assignThreads } from "./threads.ts";
import { kickIndexer } from "./bodyindex.ts";
import { prefetchRecentBodies } from "./bodies.ts";
import { recordContacts } from "./contacts.ts";
import { queueInvites } from "./calendar/auto.ts";
import { isNoPerm, lacksRead, myRights, namespaceOf, supportsAcl } from "./acl.ts";

/**
 * IMAP -> Postgres mirror.
 *  - folder list + counts on every account sync
 *  - per folder: new UIDs (newest first, in chunks), flag changes (CHANGEDSINCE when the server
 *    supports CONDSTORE, otherwise a full flags pass), and deletions (count mismatch -> UID diff)
 *  - UIDVALIDITY change drops the folder's local copy
 */

/**
 * Never run two syncs of the same thing at once. A request that arrives while one is running is not dropped: the
 * running one cannot have seen what changed after it started, so it runs once more, and the caller's promise resolves
 * only after that final run (so "sync, then read" is always at least as fresh as the request).
 */
const running = new Map<string, { again: boolean; done: Promise<void> }>();
export const isSyncing = (key: string) => running.has(key);
function once(key: string, fn: () => Promise<void>): Promise<void> {
  const existing = running.get(key);
  if (existing) { existing.again = true; return existing.done; }
  const entry = { again: false, done: undefined as unknown as Promise<void> };
  entry.done = (async () => {
    try { do { entry.again = false; await fn(); } while (entry.again); }
    finally { running.delete(key); }
  })();
  running.set(key, entry);
  return entry.done;
}

/**
 * Big imports (thousands of new messages) are the only expensive thing the sync does. They take turns: at most
 * NCMAIL_MAX_HEAVY_SYNCS run at once, the rest wait their turn (and the folder says so), so fifty people connecting
 * at the same time do not hit the database and the mail server together.
 * Turns are fair between owners: while someone else waits, one owner holds at most one slot (a person adding five big
 * accounts does not make everybody else wait for all five). With nobody else waiting, one owner may use every slot.
 */
export class Gate {
  private held = new Map<string, number>(); // slots per owner
  private queue: { owner: string; go: () => void }[] = [];
  constructor(private max: () => number) {}
  peak = 0;
  get waiting() { return this.queue.length; }
  get running() { let n = 0; for (const v of this.held.values()) n += v; return n; }
  private take(owner: string) { this.held.set(owner, (this.held.get(owner) ?? 0) + 1); this.peak = Math.max(this.peak, this.running); }
  async acquire(owner = "") {
    const othersWaiting = this.queue.some((w) => w.owner !== owner);
    if (this.running < this.max() && (!othersWaiting || !this.held.get(owner))) { this.take(owner); return; }
    await new Promise<void>((go) => this.queue.push({ owner, go }));
  }
  release(owner = "") {
    const n = (this.held.get(owner) ?? 1) - 1;
    if (n > 0) this.held.set(owner, n); else this.held.delete(owner);
    // Hand free slots on: first to the longest-waiting owner who holds none, otherwise to whoever waited longest.
    while (this.queue.length && this.running < this.max()) {
      const i = Math.max(0, this.queue.findIndex((w) => !this.held.get(w.owner)));
      const [next] = this.queue.splice(i, 1);
      this.take(next!.owner);
      next!.go();
    }
  }
}
export const heavyGate = new Gate(() => Math.max(1, Number(process.env.NCMAIL_MAX_HEAVY_SYNCS) || 2));
const HEAVY_ROWS = Number(process.env.NCMAIL_HEAVY_ROWS) || 1000;
const queuedFolders = new Set<string>();
export const isQueued = (folderId: string) => queuedFolders.has(folderId);
async function heavy<T>(folderId: string, accountId: string, fn: () => Promise<T>): Promise<T> {
  queuedFolders.add(folderId);
  const owner = await pool.query("select owner from accounts where id = $1", [accountId]).then((r) => String(r.rows[0]?.owner ?? ""), () => "");
  try { await heavyGate.acquire(owner); } finally { queuedFolders.delete(folderId); }
  try { return await fn(); } finally { heavyGate.release(owner); }
}

/** How far back the first sync of a folder goes. */
const DEFAULT_MONTHS = () => { const n = Number(process.env.NCMAIL_INITIAL_SYNC_MONTHS); return Number.isFinite(n) && process.env.NCMAIL_INITIAL_SYNC_MONTHS !== undefined && process.env.NCMAIL_INITIAL_SYNC_MONTHS !== "" ? n : 24; };
export const defaultSyncMonths = DEFAULT_MONTHS;
async function monthsFor(accountId: string): Promise<number> {
  const { rows: [a] } = await pool.query("select sync_months from accounts where id = $1", [accountId]);
  return a?.sync_months ?? DEFAULT_MONTHS();
}

const clean = (s: unknown) => String(s ?? "").replace(/\u0000/g, "");

/** Cut a string to at most `max` UTF-8 bytes, on a character boundary. */
export function capBytes(s: string, max: number): string {
  if (Buffer.byteLength(s) <= max) return s;
  let out = "", n = 0;
  for (const ch of s) { n += Buffer.byteLength(ch); if (n > max) break; out += ch; }
  return out;
}
// Indexed header values must stay well below Postgres' btree entry limit (about 2.7 kB, and lower() can grow a value).
const MAX_HEADER_BYTES = 1500;
/** Message-ID-like tokens longer than this are not real ids; they are left out of threading. */
export const MAX_MSGID_BYTES = 500;
const MAX_REFS = 100;
const msgId = (s: unknown) => { const v = clean(s); return v && Buffer.byteLength(v) <= MAX_MSGID_BYTES ? v : null; };

interface FolderRow {
  uidnext?: string | null;
  window_start?: Date | null;
  unsynced_older?: number;
  id: string;
  account_id?: string;
  special_use?: string | null;
  path: string;
  uidvalidity: string | null;
  highestmodseq: string | null;
}

function hasAttachment(node: any): boolean {
  if (!node) return false;
  if (node.disposition === "attachment") return true;
  return (node.childNodes ?? []).some(hasAttachment);
}

function hasInvite(node: any): boolean {
  if (!node) return false;
  const name = String(node.dispositionParameters?.filename ?? node.parameters?.name ?? "");
  if (/^(text\/calendar|application\/ics)$/i.test(node.type ?? "") || /\.ics$/i.test(name)) return true;
  return (node.childNodes ?? []).some(hasInvite);
}

export function toRow(m: any) {
  const env = m.envelope ?? {};
  const from = env.from?.[0] ?? {};
  const date = env.date instanceof Date && !isNaN(+env.date) ? env.date : m.internalDate;
  const refs: string[] = m.headers ? (m.headers.toString().match(/<[^>]+>/g) ?? []) : [];
  const addr = (l?: any[]) => (l ?? []).map((a) => ({ name: clean(a.name), address: clean(a.address) }));
  const header = (s: unknown) => capBytes(clean(s), MAX_HEADER_BYTES);
  return {
    uid: m.uid,
    message_id: msgId(env.messageId),
    in_reply_to: msgId(env.inReplyTo),
    refs: refs.map(msgId).filter((r): r is string => !!r).slice(-MAX_REFS),
    subject: header(env.subject),
    from_name: header(from.name),
    from_addr: header(from.address),
    to_addrs: addr(env.to),
    cc_addrs: addr(env.cc),
    date: (date ?? new Date()).toISOString(),
    flags: [...(m.flags ?? [])].map(clean),
    size: m.size ?? 0,
    has_attachments: hasAttachment(m.bodyStructure),
    invite: hasInvite(m.bodyStructure),
    search_text: capBytes([header(env.subject), header(from.name), header(from.address), // subject and sender first: from: and subject: search filter on this column
      ...addr(env.to).flatMap((a) => [a.name, a.address]), ...addr(env.cc).flatMap((a) => [a.name, a.address])]
      .filter(Boolean).join(" ").toLowerCase(), 16_000),
  };
}

/**
 * Refresh planner statistics. After a bulk load the table has none, and until autovacuum's analyzer catches up
 * (about a minute) Postgres picks poor plans: the conversation list took ~400 ms instead of ~3 ms.
 */
let analyzing: Promise<void> | null = null;
const analyzeTables = () => (analyzing ??= pool.query("analyze messages, thread_keys").then(() => {}).catch(() => {}).finally(() => { analyzing = null; }));

type Row = ReturnType<typeof toRow>;
/** A row reduced to what cannot fail to store, for a message whose headers the database refused. */
const minimalRow = (r: Row): Row => ({ ...r, message_id: null, in_reply_to: null, refs: [], subject: capBytes(r.subject, 200), from_name: "", from_addr: capBytes(r.from_addr, 200), to_addrs: [], cc_addrs: [], search_text: capBytes(r.search_text, 200) + " " + capBytes(r.from_addr, 200).toLowerCase() });
/** Errors caused by the values themselves (data exception, program limit exceeded), not by the connection or a conflict. */
const isDataError = (e: any) => typeof e?.code === "string" && (e.code.startsWith("22") || e.code.startsWith("54"));

/**
 * Store a chunk in one statement. If the database refuses the values, store the rows one by one, so a single message
 * with unstorable headers is kept in reduced form (or, failing that, skipped) instead of blocking the folder's sync.
 */
async function storeRows(folderId: string, rows: Row[]): Promise<{ id: string; thread_id: string | null; uid: string; inserted: boolean }[]> {
  try { return await storeChunk(folderId, rows); }
  catch (e) { if (!isDataError(e) || rows.length === 1) throw e; }
  const out = [];
  for (const r of rows) {
    try { out.push(...await storeChunk(folderId, [r])); continue; } catch (e) { if (!isDataError(e)) throw e; }
    try { out.push(...await storeChunk(folderId, [minimalRow(r)])); }
    catch (e) { if (!isDataError(e)) throw e; console.warn(`sync: skipped message uid ${r.uid} in folder ${folderId}: ${(e as Error).message}`); }
  }
  return out;
}

async function insertRows(folderId: string, accountId: string, rows: Row[], inSent = false): Promise<number> {
  if (!rows.length) return 0;
  const inserted = await storeRows(folderId, rows);
  const unthreaded = inserted.filter((r) => r.thread_id == null).map((r) => String(r.id));
  // threading problems must not stop the sync; unthreaded rows are picked up again at the next start (backfillThreads)
  await assignThreads(accountId, unthreaded).catch((e) => console.warn(`sync: threading failed for account ${accountId}: ${e?.message ?? e}`));
  const fresh = new Set(inserted.filter((r) => r.inserted).map((r) => Number(r.uid)));
  const invites = rows.filter((r) => r.invite && fresh.has(Number(r.uid))).map((r) => Number(r.uid));
  if (invites.length) queueInvites(accountId, folderId, invites, console);
  if (fresh.size) await recordContacts(accountId, inSent, rows.filter((r) => fresh.has(Number(r.uid)))).catch(() => {});
  return rows.length;
}

async function storeChunk(folderId: string, rows: Row[]) {
  const { rows: inserted } = await pool.query(
    `insert into messages (folder_id, uid, message_id, in_reply_to, refs, subject, from_name, from_addr,
                           to_addrs, cc_addrs, date, flags, size, has_attachments, search_text)
     select $1, t.uid, t.message_id, t.in_reply_to, array(select jsonb_array_elements_text(t.refs)),
            t.subject, t.from_name, t.from_addr, t.to_addrs, t.cc_addrs, t.date,
            array(select jsonb_array_elements_text(t.flags)), t.size, t.has_attachments, t.search_text
     from jsonb_to_recordset($2::jsonb) as t(uid bigint, message_id text, in_reply_to text, refs jsonb,
            subject text, from_name text, from_addr text, to_addrs jsonb, cc_addrs jsonb, date timestamptz,
            flags jsonb, size int, has_attachments boolean, search_text text)
     on conflict (folder_id, uid) do update set flags = excluded.flags
     returning id, thread_id, uid, (xmax = 0) as inserted`,
    [folderId, JSON.stringify(rows)],
  );
  return inserted;
}

async function recordArrivals(folderId: string, afterUid: number) {
  await pool.query(
    `insert into new_mail (message_id, owner)
     select m.id, a.owner from messages m join folders f on f.id = m.folder_id join accounts a on a.id = f.account_id
       left join user_prefs p on p.owner = a.owner
      where m.folder_id = $1 and m.uid > $2 and not ('\\Seen' = any(m.flags)) and m.date > now() - interval '3 days'
        and a.owner <> '' and coalesce(p.notify_new_mail, true)
     on conflict do nothing`, [folderId, afterUid]);
}

async function updateFlags(folderId: string, rows: { uid: number; flags: string[] }[]) {
  if (!rows.length) return;
  await pool.query(
    `update messages m set flags = array(select jsonb_array_elements_text(t.flags))
     from jsonb_to_recordset($2::jsonb) as t(uid bigint, flags jsonb)
     where m.folder_id = $1 and m.uid = t.uid`,
    [folderId, JSON.stringify(rows)],
  );
}

const CHUNK = 500;
const EARLY_ANALYZE = 2000;      // analyze once this many rows arrived during one sync...
const FINAL_ANALYZE = 1000;      // ...and again at the end of any sync that added at least this many

async function syncFolderWith(client: ImapFlow, f: FolderRow) {
  // A pooled connection may still have this mailbox selected from an earlier use. An idle IMAP connection is not told about
  // new mail until a command runs, so its cached counts (and Dovecot's STATUS for a selected mailbox) can be stale and new
  // mail would look like "nothing changed". Closing the mailbox first makes the SELECT below return the current numbers.
  if ((client.mailbox as any)?.path === f.path) await client.mailboxClose().catch(() => {});
  const lock = await client.getMailboxLock(f.path);
  try {
    const mb = client.mailbox as any;
    const uidValidity = String(mb.uidValidity);
    if (f.uidvalidity && f.uidvalidity !== uidValidity) {
      await pool.query("delete from messages where folder_id = $1", [f.id]);
      f.highestmodseq = null; f.window_start = null; f.unsynced_older = 0; f.uidnext = null;
    }
    const modseqNow: string | null = mb.highestModseq != null ? String(mb.highestModseq) : null;
    const { rows: [st] } = await pool.query(
      "select coalesce(max(uid),0)::bigint as maxuid, count(*)::int as n from messages where folder_id = $1", [f.id]);
    // New mail is everything from the UID the last sync ended at. (Not the highest mirrored UID: older mail that was left on
    // the server can have higher UIDs than recent mail, and must stay there.)
    const maxUid = f.uidnext ? Number(f.uidnext) - 1 : Number(st.maxuid);
    const hadMessages = st.n > 0;

    let inserted = 0, analyzedEarly = false;
    let windowStart: Date | null = f.window_start ?? null, older = f.unsynced_older ?? 0;
    // 1) New messages, newest first so the top of the list fills in immediately.
    //    The first sync of a big folder only takes the recent part (see monthsFor); older mail is loaded on demand.
    if (mb.exists > 0 && Number(mb.uidNext) > maxUid + 1) {
      let fresh: number[];
      if (!hadMessages) {
        const months = await monthsFor(f.account_id!);
        if (months > 0 && mb.exists > (Number(process.env.NCMAIL_CAP_MIN_MESSAGES) || 500)) {
          const since = new Date(); since.setMonth(since.getMonth() - months);
          const recent = ((await client.search({ since }, { uid: true })) || []).sort((a, b) => b - a);
          fresh = recent;
          older = Math.max(0, mb.exists - recent.length);
          windowStart = older > 0 ? since : null;
        } else { fresh = ((await client.search({ uid: `${maxUid + 1}:*` }, { uid: true })) || []).filter((u) => u > maxUid).sort((a, b) => b - a); windowStart = null; older = 0; }
      } else fresh = ((await client.search({ uid: `${maxUid + 1}:*` }, { uid: true })) || []).filter((u) => u > maxUid).sort((a, b) => b - a);
      const importAll = async () => {
        for (let i = 0; i < fresh.length; i += CHUNK) {
          const chunk = fresh.slice(i, i + CHUNK);
          const range = `${chunk[chunk.length - 1]}:${chunk[0]}`;
          const rows: ReturnType<typeof toRow>[] = [];
          for await (const m of client.fetch(
            range,
            { uid: true, flags: true, envelope: true, size: true, bodyStructure: true, internalDate: true, headers: ["references"] },
            { uid: true },
          )) rows.push(toRow(m));
          inserted += await insertRows(f.id, f.account_id!, rows, f.special_use === "\\Sent");
          if (inserted >= EARLY_ANALYZE && !analyzedEarly) { analyzedEarly = true; await analyzeTables(); } // so the list is fast while a big first sync is still running
        }
      };
      if (fresh.length > HEAVY_ROWS) await heavy(f.id, f.account_id!, importAll); else await importAll();
    }

    // 2) Flag changes on messages we already had.
    if (hadMessages) {
      const changes: { uid: number; flags: string[] }[] = [];
      const useModseq = modseqNow && f.highestmodseq;
      if (!useModseq || modseqNow !== f.highestmodseq) await withFolderFlags(f.id, async () => {
        const opts: any = { uid: true };
        if (useModseq) opts.changedSince = BigInt(f.highestmodseq!);
        for await (const m of client.fetch("1:*", { uid: true, flags: true }, opts)) {
          changes.push({ uid: m.uid, flags: [...(m.flags ?? [])].map(clean) });
          if (changes.length >= 1000) { await updateFlags(f.id, changes.splice(0)); }
        }
        await updateFlags(f.id, changes);
      });
    }

    // 3) Deletions: cheap count check, UID diff only when it disagrees. Mail older than the sync window is not mirrored, so it is not counted.
    const { rows: [after] } = await pool.query("select count(*)::int as n from messages where folder_id = $1", [f.id]);
    if (after.n !== mb.exists - older) {
      const all = (await client.search({ all: true }, { uid: true })) || [];
      await pool.query("delete from messages where folder_id = $1 and not (uid = any($2::bigint[]))", [f.id, all]);
      if (windowStart) { // what is still only on the server is whatever the mirror does not hold
        const { rows: [kept] } = await pool.query("select count(*)::int as n from messages where folder_id = $1", [f.id]);
        older = Math.max(0, all.length - kept.n);
        if (older === 0) windowStart = null;
      }
    }

    if (inserted >= FINAL_ANALYZE) await analyzeTables();
    // New mail for Nextcloud's notifications: only what arrived in an inbox that was synced before (never a first sync or
    // older mail loaded on demand), still unread, and recent.
    if (inserted > 0 && f.special_use === "\\Inbox" && f.uidnext && hadMessages) await recordArrivals(f.id, maxUid);
    await pool.query(
      `update folders set uidvalidity = $2, uidnext = $3, highestmodseq = $4, last_synced_at = now(), sync_error = null,
         total = $5, window_start = $6, unsynced_older = $7,
         unseen = (select count(*) from messages where folder_id = $1 and not ('\\Seen' = any(flags)))
       where id = $1`,
      [f.id, uidValidity, String(mb.uidNext), modseqNow, mb.exists, windowStart, older],
    );
  } finally {
    lock.release();
  }
}

/**
 * Someone else's folders (shared with you, or public) that the server lists but will not open. Some servers keep listing a
 * share after the mailbox behind it was renamed or broke, and every attempt to open it fails. Such a folder is marked and,
 * while it holds no mirrored mail, left out of the folder list (other mail apps hide it too); it is checked again on every
 * folder-list sync and comes back as soon as it opens.
 */
const PROBE_BUDGET = 20; // STATUS commands per folder-list sync for these checks
async function markAvailable(folderId: string) {
  await pool.query("update folders set unavailable_at = null where id = $1 and unavailable_at is not null", [folderId]);
}
async function markUnavailable(folderId: string) {
  await pool.query("update folders set unavailable_at = coalesce(unavailable_at, now()) where id = $1", [folderId]);
}
/** The server refused (a NO or BAD answer), as opposed to a lost connection or a timeout. */
const refused = (e: any) => !isConnectionLost(e) && (!!e?.responseStatus || !!e?.serverResponseCode || /Command failed/i.test(String(e?.message ?? "")));
async function probeShared(client: ImapFlow, folders: { id: string; path: string }[]) {
  for (const f of folders.slice(0, PROBE_BUDGET)) {
    try {
      // imapflow answers a refused STATUS with false (it throws only for a folder that is gone or a lost connection)
      const st = await client.status(f.path, { messages: true });
      if (st) await markAvailable(f.id);
      else if (client.usable) await markUnavailable(f.id);
    } catch (e) {
      if (isConnectionLost(e)) throw e;
      if (refused(e)) await markUnavailable(f.id);
    }
  }
}

/** Servers without LIST-STATUS (RFC 5819) need one STATUS command per folder, so those are refreshed in a bounded, tiered way. */
const STATUS_BUDGET = Number(process.env.NCMAIL_STATUS_BUDGET) || 60; // at most this many STATUS commands per sync cycle
const STATUS_RECHECK_MIN = 15;            // quiet folders are re-checked at most this often (minutes)
const hasListStatus = (client: ImapFlow) => client.capabilities.has("LIST-STATUS") && !process.env.NCMAIL_NO_LIST_STATUS;

async function refreshStatusTiered(client: ImapFlow, accountId: string) {
  // Hot folders (special-use, or opened/synced in the last day) every cycle; the rest oldest-first within the budget.
  const { rows } = await pool.query(
    `select id, path, namespace from folders
     where account_id = $1 and selectable
       and (special_use is not null or last_synced_at > now() - interval '1 day'
            or status_checked_at is null or status_checked_at < now() - make_interval(mins => ${STATUS_RECHECK_MIN}))
     order by coalesce(special_use is not null or last_synced_at > now() - interval '1 day', false) desc,  -- coalesce: NULL would sort first
              status_checked_at asc nulls first
     limit ${STATUS_BUDGET}`, [accountId]);
  for (const f of rows) {
    try {
      const st = await client.status(f.path, { messages: true, unseen: true });
      if (!st) { // the server refused (imapflow answers false); the next list tries again
        if (f.namespace !== "personal" && client.usable) await markUnavailable(f.id);
        continue;
      }
      await pool.query("update folders set total = $2, unseen = $3, status_checked_at = now() where id = $1", [f.id, st.messages ?? 0, st.unseen ?? 0]);
      if (f.namespace !== "personal") await markAvailable(f.id);
    } catch (e) {
      // a folder that vanished is picked up by the next list; someone else's that will not open is marked (see probeShared)
      if (f.namespace !== "personal" && refused(e)) await markUnavailable(f.id);
    }
  }
}

/**
 * One change to an account's folder list or counters at a time. A folder-list sync reads the server's list and counts, then
 * writes them: a rename, delete or bulk change landing in between would otherwise be undone by those older values.
 * Not re-entrant: code holding the lock calls syncFolderListNow, not syncFolderList.
 */
const accountLocks = new Map<string, Promise<unknown>>();
export function withAccountLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const prev = accountLocks.get(accountId) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  accountLocks.set(accountId, tail);
  void tail.then(() => { if (accountLocks.get(accountId) === tail) accountLocks.delete(accountId); });
  return run;
}

/**
 * One flag change to a folder's mirror at a time. A sync reads flags from the server and then writes them; a star or a
 * mark-as-read from the app changes the server and then the mirror, on another connection. Without this, a sync that read
 * just before such a change and wrote just after it puts the old flags back (seen in CI as a star that came back).
 */
const flagLocks = new Map<string, Promise<unknown>>();
export function withFolderFlags<T>(folderId: string, fn: () => Promise<T>): Promise<T> {
  const key = String(folderId);
  const prev = flagLocks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  flagLocks.set(key, tail);
  void tail.then(() => { if (flagLocks.get(key) === tail) flagLocks.delete(key); });
  return run;
}

/** Mirror the server's folder list (names, special use, rights, counts) and drop folders that are gone. */
export function syncFolderList(client: ImapFlow, accountId: string) {
  return withAccountLock(accountId, () => syncFolderListNow(client, accountId));
}

/** syncFolderList for code that already holds the account's lock. */
export async function syncFolderListNow(client: ImapFlow, accountId: string) {
  const inline = hasListStatus(client); // one LIST command that also returns every folder's counts
  // A pooled connection may still have a mailbox selected, and the server's STATUS for a selected mailbox can be stale (it is
  // only brought up to date when a command runs on it): close it first, or old counts would overwrite fresh ones.
  if (inline && client.mailbox) await client.mailboxClose().catch(() => {});
  const list = await client.list(inline
    ? { statusQuery: { messages: true, unseen: true, uidNext: true, uidValidity: true, highestModseq: true } }
    : {});
  const paths: string[] = [];
  const probe: { id: string; path: string }[] = []; // someone else's folders to check can be opened
  const acl = supportsAcl(client);
  await pool.query("update accounts set supports_acl = $2 where id = $1", [accountId, acl]);
  for (const e of list) {
    paths.push(e.path);
    const selectable = !e.flags.has("\\Noselect") && !e.flags.has("\\NonExistent");
    const ns = namespaceOf(client, e.path);
    // someone else's folders never act as your Inbox, Sent, Trash...
    const special = ns.kind !== "personal" ? null : e.path.toUpperCase() === "INBOX" ? "\\Inbox" : (e.specialUse ?? null);
    // what you may do there (personal folders: everything)
    const rights = ns.kind !== "personal" && selectable && acl ? await myRights(client, e.path) : null;
    const { rows: [saved] } = await pool.query(
      `insert into folders (account_id, path, name, delimiter, special_use, selectable, total, unseen, status_checked_at, namespace, shared_owner, rights)
       values ($1,$2,$3,$4,$5,$6,coalesce($7,0),coalesce($8,0), case when $7::int is null then null else now() end, $9, $10, $11)
       on conflict (account_id, path) do update set name = excluded.name, delimiter = excluded.delimiter,
         special_use = excluded.special_use, selectable = excluded.selectable,
         total = coalesce($7, folders.total), unseen = coalesce($8, folders.unseen),
         status_checked_at = case when $7::int is null then folders.status_checked_at else now() end,
         namespace = excluded.namespace, shared_owner = excluded.shared_owner, rights = excluded.rights
       returning id`,
      [accountId, e.path, e.name, e.delimiter, special, selectable, e.status?.messages ?? null, e.status?.unseen ?? null, ns.kind, ns.owner, rights],
    );
    // still listed, but no longer readable: the mirror must not keep what the owner took back
    if (ns.kind !== "personal" && lacksRead(rights)) await forgetFolderMail(saved.id);
    if (ns.kind !== "personal" && selectable && !lacksRead(rights)) {
      // with LIST-STATUS a folder the server gave no counts for is checked here; without it, refreshStatusTiered checks them
      if (inline && e.status) await markAvailable(saved.id);
      else if (inline) probe.push({ id: saved.id, path: e.path });
    }
  }
  await probeShared(client, probe);
  await pool.query("delete from folders where account_id = $1 and not (path = any($2::text[]))", [accountId, paths]);
  if (!inline) await refreshStatusTiered(client, accountId);
}

/** Folder list + INBOX. Other folders sync when opened. */
export function syncAccount(accountId: string) {
  return once(`a:${accountId}`, async () => {
    const cfg = await loadAccount(accountId);
    await withImapRetry(cfg.imap, async (client, lastTry) => {
      await syncFolderList(client, accountId);
      const { rows } = await pool.query(
        "select id, path, account_id, special_use, uidvalidity, highestmodseq, uidnext, window_start, unsynced_older from folders where account_id = $1 and special_use = '\\Inbox'", [accountId]);
      if (rows[0]) await syncFolderSafe(client, rows[0], lastTry);
      publish({ type: "sync", accountId, folderId: rows[0]?.id });
      kickIndexer(accountId);
      prefetchRecentBodies(accountId);
    });
  });
}

export function syncFolder(folderId: string) {
  return once(`f:${folderId}`, async () => {
    const { rows } = await pool.query("select id, path, account_id, special_use, uidvalidity, highestmodseq, uidnext, window_start, unsynced_older from folders where id = $1", [folderId]);
    const f = rows[0];
    if (!f) return;
    const cfg = await loadAccount(f.account_id);
    await withImapRetry(cfg.imap, (client, lastTry) => syncFolderSafe(client, f, lastTry));
    publish({ type: "sync", accountId: f.account_id, folderId: String(f.id) });
    kickIndexer(f.account_id);
    prefetchRecentBodies(f.account_id);
  });
}

/** `lastTry` false: a lost connection is not recorded as the folder's error, because the sync is about to run again. */
async function syncFolderSafe(client: ImapFlow, f: FolderRow, lastTry = true) {
  try {
    await syncFolderWith(client, f);
    await markAvailable(f.id);
  } catch (e: any) {
    if (refused(e) && (await pool.query("select 1 from folders where id = $1 and namespace <> 'personal'", [f.id])).rowCount) await markUnavailable(f.id);
    if (!lastTry && isConnectionLost(e)) throw e;
    await pool.query("update folders set sync_error = $2 where id = $1", [f.id, describeImapError(e, "open this folder")]);
    // someone else's folder we may no longer open: drop its mirrored mail
    if (isNoPerm(e)) await forgetFolderMail(f.id, true);
    throw e;
  }
}

/**
 * Remove a folder's mirrored mail (headers, cached bodies and body index cascade) and its sync position, so it is
 * mirrored afresh if access comes back. `sharedOnly` limits this to folders outside your personal namespace.
 */
async function forgetFolderMail(folderId: string, sharedOnly = false) {
  const { rowCount } = await pool.query(
    `update folders set uidvalidity = null, uidnext = null, highestmodseq = null, window_start = null, unsynced_older = 0, unseen = 0
      where id = $1 ${sharedOnly ? "and namespace <> 'personal'" : ""}`, [folderId]);
  if (rowCount) await retryOnDeadlock(() => pool.query("delete from messages where folder_id = $1", [folderId]));
}

/** How often the background refresh runs per account: rarely while IDLE is healthy (it already delivers INBOX changes), often otherwise. */
export interface BgConfig { tickMs: number; healthyMs: number; degradedMs: number }
export const bgConfig = (): BgConfig => {
  const n = (v: string | undefined, d: number) => (v && Number(v) > 0 ? Number(v) : d);
  return { tickMs: n(process.env.NCMAIL_BG_TICK_MS, 30_000), healthyMs: n(process.env.NCMAIL_BG_HEALTHY_MS, 180_000), degradedMs: n(process.env.NCMAIL_BG_DEGRADED_MS, 60_000) };
};
export const bgDue = (healthy: boolean, lastRunAt: number | undefined, now: number, cfg: BgConfig) =>
  lastRunAt === undefined || now - lastRunAt >= (healthy ? cfg.healthyMs : cfg.degradedMs);

/**
 * Background refresh: folder list + counts + INBOX, then Sent and Drafts (IDLE only watches the INBOX).
 * `isHealthy(accountId)` says whether that account's IDLE connection is up.
 */
export function startBackgroundSync(log: { error: (...a: any[]) => void }, opts: { isHealthy?: (accountId: string) => boolean } = {}) {
  const cfg = bgConfig();
  const last = new Map<string, number>();
  setInterval(async () => {
    const { rows } = await pool.query("select id from accounts");
    for (const r of rows) {
      if (!bgDue(!!opts.isHealthy?.(r.id), last.get(r.id), Date.now(), cfg)) continue;
      last.set(r.id, Date.now());
      syncAccount(r.id)
        .then(async () => {
          const { rows: special } = await pool.query("select id from folders where account_id = $1 and special_use in ('\\Sent', '\\Drafts')", [r.id]);
          for (const f of special) await syncFolder(String(f.id));
        })
        .catch((e) => log.error(e, "background sync failed"));
    }
  }, cfg.tickMs).unref();
}

/** Fetch these messages (already selected in `client`) and add them to the mirror. Returns how many were new. */
export async function importUids(client: ImapFlow, f: { id: string; account_id: string; special_use: string | null }, uids: number[]): Promise<number> {
  let added = 0;
  for (let i = 0; i < uids.length; i += CHUNK) {
    const chunk = uids.slice(i, i + CHUNK);
    const rows: ReturnType<typeof toRow>[] = [];
    for await (const m of client.fetch(chunk.join(","), { uid: true, flags: true, envelope: true, size: true, bodyStructure: true, internalDate: true, headers: ["references"] }, { uid: true })) rows.push(toRow(m));
    added += await insertRows(f.id, f.account_id, rows, f.special_use === "\\Sent");
  }
  return added;
}

/**
 * Bring older mail of a folder into the mirror: the next `count` messages below what is already there (or everything).
 * Returns how many were added.
 */
export function loadOlder(folderId: string, count: number | "all" = 5000): Promise<number> {
  let added = 0;
  return once(`o:${folderId}`, async () => {
    const { rows: [f] } = await pool.query("select id, path, account_id, special_use, window_start, unsynced_older from folders where id = $1", [folderId]);
    if (!f?.window_start) return;
    const cfg = await loadAccount(f.account_id);
    await withImapRetry(cfg.imap, async (client) => {
      const lock = await client.getMailboxLock(f.path);
      try {
        const have = new Set((await pool.query("select uid from messages where folder_id = $1", [f.id])).rows.map((r) => Number(r.uid)));
        const below = ((await client.search({ before: f.window_start }, { uid: true })) || []).filter((u) => !have.has(u)).sort((a, b) => b - a);
        const take = count === "all" ? below : below.slice(0, count);
        const run = async () => { added += await importUids(client, f, take); };
        if (take.length > HEAVY_ROWS) await heavy(f.id, f.account_id, run); else await run();
        const remaining = below.length - take.length;
        await pool.query("update folders set window_start = case when $2 > 0 then window_start else null end, unsynced_older = $2 where id = $1", [f.id, remaining]);
        if (added >= FINAL_ANALYZE) await analyzeTables();
      } finally { lock.release(); }
    });
    publish({ type: "sync", accountId: f.account_id, folderId: String(f.id) });
    kickIndexer(f.account_id);
  }).then(() => added);
}

/** Heavy-sync gate numbers, for the status endpoint and tests. */
export const syncStatus = () => ({ limit: Math.max(1, Number(process.env.NCMAIL_MAX_HEAVY_SYNCS) || 2), running: heavyGate.running, waiting: heavyGate.waiting, peak: heavyGate.peak });
