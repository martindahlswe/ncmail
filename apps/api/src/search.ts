import type { FastifyInstance } from "fastify";
import { bgPool, pool } from "./db.ts";
import { READABLE_SQL } from "./acl.ts";
import { loadAccount } from "./accounts.ts";
import { withImap } from "./mail.ts";
import { indexCounts } from "./bodyindex.ts";
import { importUids } from "./sync.ts";

/**
 * Search.
 *  - Local (default): a substring match over subject / sender / recipients using a trigram index on
 *    messages.search_text. Instant even on large mailboxes. Message bodies are not part of this index.
 *  - Server text (opt-in): asks the IMAP server to SEARCH TEXT (headers + body) in the folders in scope,
 *    maps the hits back to local rows, and applies the same operators on top.
 */

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const like = (s: string) => `%${escapeLike(s.toLowerCase())}%`;

/** Words of a search term as a tsquery with prefix matching ("invo" finds "invoice"); phrases use adjacency. */
function ftsQuery(text: string, phrase: boolean): string | null {
  const words = text.match(/[\p{L}\p{N}]+/gu);
  return words?.length ? words.map((w) => `${w}:*`).join(phrase ? " <-> " : " & ") : null;
}

export interface ParsedQuery {
  conds: string[];
  freeTerms: string[];
  hasIn: boolean;
  notes: string[];
}

/** Every term becomes its own condition (and IMAP SEARCH key): a bound keeps one query from turning into a huge statement. */
export const MAX_SEARCH_TERMS = 30;
export const MAX_SEARCH_CHARS = 1000;
const TERM_RE = /(-?)(?:([a-z]+):)?(?:"([^"]*)"|(\S+))/gi;

/** Refuses a query with too many terms or characters (400 with a message the search box shows). */
export function checkQuery(q: string) {
  const fail = (msg: string) => { throw Object.assign(new Error(msg), { statusCode: 400 }); };
  if (q.length > MAX_SEARCH_CHARS) fail(`The search is too long (at most ${MAX_SEARCH_CHARS} characters).`);
  if ([...q.matchAll(TERM_RE)].length > MAX_SEARCH_TERMS) fail(`The search has too many words or operators (at most ${MAX_SEARCH_TERMS}).`);
}

const SPECIAL_WORDS: Record<string, string> = {
  inbox: "\\Inbox", sent: "\\Sent", drafts: "\\Drafts", draft: "\\Drafts", trash: "\\Trash", junk: "\\Junk", spam: "\\Junk", archive: "\\Archive",
};

/** Turns `from:ada has:attachment "quarterly report" -newsletter after:2026-01-01` into SQL conditions. */
export function parseQuery(q: string, params: unknown[], opts: { skipFree?: boolean } = {}): ParsedQuery {
  const out: ParsedQuery = { conds: [], freeTerms: [], hasIn: false, notes: [] };
  const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const re = /(-?)(?:([a-z]+):)?(?:"([^"]*)"|(\S+))/gi;
  for (const m of q.matchAll(re)) {
    const neg = m[1] === "-";
    const op = m[2]?.toLowerCase();
    const raw = (m[3] ?? m[4] ?? "").trim();
    if (!raw && !op) continue;
    const wrap = (sql: string) => out.conds.push(neg ? `not (${sql})` : sql);

    const free = (text: string, phrase = false) => {
      if (!text) return;
      if (!neg) out.freeTerms.push(text);
      if (!neg && opts.skipFree) return; // the IMAP server answers positive free text in text mode
      // A header substring match OR a hit in the local body index (rows exist only when the account's index is on).
      // Written as `id IN (lookup UNION lookup)` so each side can use its own index: an `OR EXISTS(...)` here forces a
      // scan of the whole table (about 120 ms at 110k messages, versus about 3 ms this way).
      const fts = ftsQuery(text, phrase);
      wrap(fts
        ? `m.id in (select id from messages where search_text like ${add(like(text))} union select message_id from message_text where tsv @@ to_tsquery('simple', ${add(fts)}))`
        : `m.search_text like ${add(like(text))}`);
    };

    switch (op) {
      case undefined: free(raw, m[3] !== undefined); break;
      // search_text starts with the subject and the sender (lowercased), so it narrows these through its trigram index first:
      // without it, from: reads every message (about 1 s at 500,000 messages, 30 ms with it)
      case "from": { const p = add(like(raw)); wrap(`(${neg ? "" : `m.search_text like ${p} and `}(lower(m.from_name) like ${p} or lower(m.from_addr) like ${p}))`); break; }
      case "to": wrap(`lower(m.to_addrs::text) like ${add(like(raw))}`); break;
      case "cc": wrap(`lower(m.cc_addrs::text) like ${add(like(raw))}`); break;
      case "subject": { const p = add(like(raw)); wrap(neg ? `lower(m.subject) like ${p}` : `(m.search_text like ${p} and lower(m.subject) like ${p})`); break; }
      case "has":
        if (raw.toLowerCase().startsWith("attach")) wrap("m.has_attachments"); else out.notes.push(`Unknown has:${raw}`);
        break;
      case "is": {
        const v = raw.toLowerCase();
        if (v === "unread") wrap("not ('\\Seen' = any(m.flags))");
        else if (v === "read") wrap("'\\Seen' = any(m.flags)");
        else if (v === "starred" || v === "flagged") wrap("'\\Flagged' = any(m.flags)");
        else if (v === "answered" || v === "replied") wrap("'\\Answered' = any(m.flags)");
        else out.notes.push(`Unknown is:${raw}`);
        break;
      }
      case "label": case "tag": { // label:work  /  label:"Big client"
        const slug = raw.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        if (slug) wrap(`${add("$ncl_" + slug)} = any(m.flags)`); else out.notes.push("label: needs a label name");
        break;
      }
      case "before": case "after": {
        if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) wrap(`m.date ${op === "before" ? "<" : ">="} ${add(raw)}::date`);
        else out.notes.push(`${op}: needs a date like 2026-01-31`);
        break;
      }
      case "in": case "folder": {
        out.hasIn = true;
        const special = SPECIAL_WORDS[raw.toLowerCase()];
        const p = add(like(raw));
        wrap(special ? `(f.special_use = ${add(special)} or lower(f.name) like ${p})` : `(lower(f.name) like ${p} or lower(f.path) like ${p})`);
        break;
      }
      default: free(m[0].replace(/^-/, "")); // not an operator we know: search for the literal text
    }
  }
  return out;
}

export async function backfillSearchText(log: { info: (...a: any[]) => void }) {
  let total = 0;
  for (;;) {
    const { rowCount } = await bgPool.query(
      `update messages m set search_text = lower(m.subject || ' ' || m.from_name || ' ' || m.from_addr || ' ' ||
         coalesce((select string_agg(coalesce(e->>'name','') || ' ' || coalesce(e->>'address',''), ' ')
                   from jsonb_array_elements(m.to_addrs || m.cc_addrs) e), ''))
       where m.id in (select id from messages where search_text is null limit 5000)`);
    if (!rowCount) break;
    total += rowCount;
  }
  if (total) log.info({ total }, "built search index for existing messages");
}

/**
 * Search covers ALL mail, not just what is mirrored. The first sync only mirrors recent mail, so for folders that still
 * have older mail on the server, the query is also run there (IMAP SEARCH over the unmirrored UIDs) and the newest matches
 * are added to the mirror; the normal local search then runs over everything, so results look and behave like any other.
 */
const PULL_PER_FOLDER = 40;
const PULL_TOTAL = 100;          // at most this many older messages are added by one search
const PULL_BUDGET_MS = 10_000;
/** The mail server answers older-mail searches for everybody; a few at a time keeps one busy day from slowing it down. */
let pullers = 0; const pullQueue: (() => void)[] = [];
const pullEnter = async () => { if (pullers < (Number(process.env.NCMAIL_MAX_OLDER_SEARCHES) || 4)) { pullers++; return; } await new Promise<void>((r) => pullQueue.push(r)); };
const pullLeave = () => { const n = pullQueue.shift(); if (n) n(); else pullers--; };
interface Crit { base: Record<string, unknown>; free: string[]; inFolders: string[]; hasAttachment: boolean }

function imapCriteria(q: string): Crit {
  const out: Crit = { base: {}, free: [], inFolders: [], hasAttachment: false };
  const re = /(-?)(?:([a-z]+):)?(?:"([^"]*)"|(\S+))/gi;
  const slug = (v: string) => v.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  for (const m of q.matchAll(re)) {
    const neg = m[1] === "-", op = m[2]?.toLowerCase(), raw = (m[3] ?? m[4] ?? "").trim();
    if (!raw && !op) continue;
    const put = (k: string, v: unknown) => { if (neg) { if (!("not" in out.base)) out.base.not = { [k]: v }; } else if (!(k in out.base)) out.base[k] = v; };
    switch (op) {
      case undefined: if (!neg) out.free.push(raw); break;
      case "from": case "to": case "cc": case "subject": put(op, raw); break;
      case "has": if (raw.toLowerCase().startsWith("attach") && !neg) out.hasAttachment = true; break;
      case "is": { const v = raw.toLowerCase(); if (v === "unread") put("seen", false); else if (v === "read") put("seen", true); else if (v === "starred" || v === "flagged") put("flagged", true); else if (v === "answered" || v === "replied") put("answered", true); break; }
      case "label": case "tag": { const sl = slug(raw); if (sl) put("keyword", `$ncl_${sl}`); break; }
      case "before": if (/^\d{4}-\d{2}-\d{2}$/.test(raw) && !neg) out.base.before = new Date(raw); break;
      case "after": if (/^\d{4}-\d{2}-\d{2}$/.test(raw) && !neg) out.base.since = new Date(raw); break;
      case "in": case "folder": out.inFolders.push(raw.toLowerCase()); break;
      default: if (!neg) out.free.push(m[0]);
    }
  }
  return out;
}

async function pullOlder(accountId: string, q: string, onlyFolder?: string, bodies = false): Promise<{ pulled: number; capped: boolean; partial: boolean }> {
  const res = { pulled: 0, capped: false, partial: false };
  const crit = imapCriteria(q);
  const { rows } = await pool.query(
    `select id, path, name, special_use, account_id, window_start, unsynced_older from folders where account_id = $1 and selectable and window_start is not null ${onlyFolder ? "and id = $2" : ""}`,
    onlyFolder ? [accountId, onlyFolder] : [accountId]);
  const folders = rows.filter((f) => {
    if (crit.inFolders.length) return crit.inFolders.some((w) => (SPECIAL_WORDS[w] && f.special_use === SPECIAL_WORDS[w]) || f.name.toLowerCase().includes(w) || f.path.toLowerCase().includes(w));
    return !onlyFolder ? !(f.special_use === "\\Trash" || f.special_use === "\\Junk") : true;
  });
  if (!folders.length || (!Object.keys(crit.base).length && !crit.free.length)) return res; // nothing the server could narrow down
  const cfg = await loadAccount(accountId);
  const started = Date.now();
  await pullEnter();
  try { await withImap(cfg.imap, async (c) => {
    for (const f of folders.sort((a, b) => (b.unsynced_older ?? 0) - (a.unsynced_older ?? 0))) {
      if (res.pulled >= PULL_TOTAL) { res.capped = true; break; }
      if (Date.now() - started > PULL_BUDGET_MS) { res.partial = true; break; }
      const lock = await c.getMailboxLock(f.path, { readOnly: true });
      try {
        const wb = f.window_start as Date; // unmirrored mail is older than the window; a before: in the query can only narrow that
        const before = crit.base.before instanceof Date && crit.base.before < wb ? crit.base.before : wb;
        let hits: number[] | undefined;
        for (const term of crit.free.length ? crit.free.slice(0, 4) : [null]) {
          // plain words match the same things the local search does (subject, sender, recipients); the message text only when asked for
          const word = term ? (bodies ? { text: term } : { or: [{ subject: term }, { from: term }, { to: term }, { cc: term }] }) : {};
          const found = new Set((await c.search({ ...crit.base, ...word, before } as any, { uid: true })) || []);
          hits = hits ? hits.filter((u) => found.has(u)) : [...found];
          if (!hits.length) break;
        }
        if (!hits?.length) continue;
        const have = new Set((await pool.query("select uid from messages where folder_id = $1 and date < $2", [f.id, f.window_start])).rows.map((r) => Number(r.uid)));
        const fresh = hits.filter((u) => !have.has(u)).sort((a, b) => b - a);
        if (fresh.length > PULL_PER_FOLDER) res.capped = true;
        const take = fresh.slice(0, Math.min(PULL_PER_FOLDER, PULL_TOTAL - res.pulled));
        if (!take.length) continue;
        const added = await importUids(c, f, take);
        res.pulled += added;
        await pool.query("update folders set unsynced_older = greatest(unsynced_older - $2, 0), window_start = case when unsynced_older - $2 <= 0 then null else window_start end where id = $1", [f.id, added]);
      } finally { lock.release(); }
    }
  }); } finally { pullLeave(); }
  return res;
}

const TEXT_BUDGET_MS = 20_000;
const TEXT_RESULT_CAP = 300;

export async function searchRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { q?: string; scope?: string; folderId?: string; text?: string; limit?: string; beforeDate?: string; beforeId?: string } }>(
    "/api/accounts/:id/search", async (req) => {
      const q = (req.query.q ?? "").trim();
      if (!q) return { items: [], next: null, total: 0, partial: false, notes: [] };
      checkQuery(q);
      const limit = Math.min(Number(req.query.limit ?? 50), 200);
      const params: unknown[] = [req.params.id];
      const parsed = parseQuery(q, params, { skipFree: req.query.text === "1" });
      const add = (v: unknown) => { params.push(v); return `$${params.length}`; };

      const where: string[] = ["f.account_id = $1", READABLE_SQL, ...parsed.conds];
      if (req.query.scope === "folder" && req.query.folderId) where.push(`m.folder_id = ${add(req.query.folderId)}`);
      else if (!parsed.hasIn) where.push("(f.special_use is null or f.special_use not in ('\\Trash', '\\Junk'))");

      // ---- older mail that is not mirrored yet: search the server and bring the newest matches in ----
      let partial = false;
      const notes = [...parsed.notes];
      if (!req.query.beforeDate) {
        try {
          const older = await pullOlder(req.params.id, q, req.query.scope === "folder" ? req.query.folderId : undefined, req.query.text === "1");
          if (older.capped) notes.push(`Older mail matches too. The newest ${PULL_TOTAL} were added to your results: narrow the search (a sender, a date) to see the rest.`);
          if (older.partial) { partial = true; notes.push("Searched part of the older mail on the server before the time limit. Narrow the search with in: or a date."); }
        } catch (e: any) { notes.push(`Could not search older mail on the server (${e.message}). Results cover the mail already loaded.`); }
      }
      const useServer = req.query.text === "1" && parsed.freeTerms.length > 0;
      let serverPaging = false;
      if (useServer) {
        // Free terms are answered by the server (it sees bodies), so no local header-only conditions were generated.
        const scopeFolders = (await pool.query(
          `select f.id, f.path from folders f where f.account_id = $1 and f.selectable and ${READABLE_SQL}
             ${req.query.scope === "folder" && req.query.folderId ? "and f.id = $2" : "and (f.special_use is null or f.special_use not in ('\\Trash','\\Junk'))"}`,
          req.query.scope === "folder" && req.query.folderId ? [req.params.id, req.query.folderId] : [req.params.id])).rows;
        const cfg = await loadAccount(req.params.id, req.owner);
        const started = Date.now();
        const folderIds: string[] = [], uids: number[] = [];
        await withImap(cfg.imap, async (c) => {
          for (const f of scopeFolders) {
            if (Date.now() - started > TEXT_BUDGET_MS) { partial = true; break; }
            const lock = await c.getMailboxLock(f.path, { readOnly: true });
            try {
              let hits: number[] | undefined;
              for (const term of parsed.freeTerms.slice(0, 4)) {
                const found = new Set<number>((await c.search({ text: term }, { uid: true })) || []);
                const prev: number[] | undefined = hits;
                hits = prev ? prev.filter((u) => found.has(u)) : [...found];
                if (!hits.length) break;
              }
              for (const u of hits ?? []) { folderIds.push(String(f.id)); uids.push(u); }
            } finally { lock.release(); }
          }
        });
        if (partial) notes.push("Searched part of the mailbox before the time limit. Narrow it with in: or this-folder scope.");
        where.push(`(m.folder_id, m.uid) in (select * from unnest(${add(folderIds)}::bigint[], ${add(uids)}::bigint[]))`);
        serverPaging = true;
      }

      // ---- count (capped) + page ----
      const base = `from messages m join folders f on f.id = m.folder_id where ${where.join(" and ")}`;
      const { rows: [{ n }] } = await pool.query(`select count(*)::int as n from (select 1 ${base} limit 1001) x`, params);

      const pageWhere = [...where];
      const pageParams = [...params];
      if (!serverPaging && req.query.beforeDate && req.query.beforeId) {
        pageParams.push(req.query.beforeDate, req.query.beforeId);
        pageWhere.push(`(m.date, m.id) < ($${pageParams.length - 1}::timestamptz, $${pageParams.length}::bigint)`);
      }
      pageParams.push(serverPaging ? TEXT_RESULT_CAP : limit + 1);
      const { rows } = await pool.query(
        `select m.*, f.id as fid, f.name as fname from messages m join folders f on f.id = m.folder_id
         where ${pageWhere.join(" and ")} order by m.date desc, m.id desc limit $${pageParams.length}`, pageParams);

      const page = serverPaging ? rows : rows.slice(0, limit);
      const items = page.map((r) => ({
        id: r.id, uid: r.uid, subject: r.subject, fromName: r.from_name, fromAddr: r.from_addr,
        date: r.date.toISOString(), seen: r.flags.includes("\\Seen"), flagged: r.flags.includes("\\Flagged"),
        answered: r.flags.includes("\\Answered"), hasAttachments: r.has_attachments, size: r.size,
        folderId: String(r.fid), folderName: r.fname,
      }));
      const last = rows[limit - 1];
      return {
        items,
        next: !serverPaging && rows.length > limit ? { date: last.date.toISOString(), id: last.id } : null,
        total: n, capped: n > 1000, partial, notes,
        index: await (async () => {
          const { rows: [a] } = await pool.query("select index_bodies from accounts where id = $1", [req.params.id]);
          if (!a?.index_bodies) return { enabled: false, indexed: 0, total: 0 };
          return { enabled: true, ...(await indexCounts(req.params.id)) };
        })(),
      };
    });
}
