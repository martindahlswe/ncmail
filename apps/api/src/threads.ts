import { bgPool as pool } from "./db.ts"; // runs from sync and the startup backfill

/**
 * Conversation threading from Message-ID / In-Reply-To / References (the JWZ idea, set-based):
 * every header value is a "key"; messages sharing any key belong to one thread, and threads that a
 * new message bridges are merged. Keys are remembered in thread_keys so that replies whose parent
 * we never saw (or have not synced yet) still end up together.
 */

// keys too long to be real ids are ignored (they would also exceed the index entry limit of thread_keys)
const MAX_KEY_BYTES = 500;
const norm = (s?: string | null) => { const k = s ? s.trim().toLowerCase() : ""; return k && Buffer.byteLength(k) <= MAX_KEY_BYTES ? k : null; };

// ---- subject fallback, for mail without reply headers (some lists, older clients, forwarded tickets) ----
/** Reply and forward prefixes in common languages ("Re:", "AW:", "SV:", "Fwd:", "Re[2]:"...), repeated or not. */
const PREFIX = /^\s*(?:(?:re|aw|sv|vs|antw|antwort|ref|réf|rif|r|fw|fwd|wg|tr|rv|enc|odp|vá|ynt|vl)\s*(?:\[\d+\])?\s*:\s*)+/i;
export const hasReplyPrefix = (s: string) => PREFIX.test(s ?? "");
/** The same test for PostgreSQL (~*), on the start of the subject. */
const PREFIX_SQL = "^\\s*(re|aw|sv|vs|antw|antwort|ref|réf|rif|r|fw|fwd|wg|tr|rv|enc|odp|vá|ynt|vl)\\s*(\\[[0-9]+\\])?\\s*:";
/** The subject without reply and forward prefixes, spaces collapsed, lower case. */
export const baseSubject = (s: string) => (s ?? "").replace(PREFIX, "").replace(/\s+/g, " ").trim().toLowerCase();
/** Subjects too short or too common to say that two messages belong together. */
const GENERIC = new Set(["hello", "hi", "hej", "hallo", "hey", "question", "questions", "invoice", "meeting", "update", "test", "info",
  "information", "request", "thanks", "thank you", "report", "document", "documents", "file", "files", "photo", "photos", "fyi",
  "no subject", "(no subject)", "(kein betreff)", "(inget ämne)", "status", "reminder", "news", "newsletter", "agenda", "minutes"]);
export const usableSubject = (base: string) => base.length >= 6 && !GENERIC.has(base) && /[a-z\p{L}]/iu.test(base);
const WINDOW_DAYS = 60;

interface Meta { id: string; subject: string; date: Date; people: Set<string>; referenced: boolean; thread?: string | null }
const peopleOf = (r: any) => new Set<string>([r.from_addr, ...(r.to_addrs ?? []).map((a: any) => a?.address), ...(r.cc_addrs ?? []).map((a: any) => a?.address)]
  .map((a) => String(a ?? "").trim().toLowerCase()).filter((a) => a.includes("@")));

/**
 * Two messages belong together by subject: the new one has no reply headers, one of them is a reply or forward ("Re: …"),
 * the subjects match without those prefixes and are not generic, they are at most 60 days apart, and they share someone other
 * than the account's own addresses. (A reply that does carry reply headers is threaded by them; it is never matched here
 * as the reply side, so a real conversation is not joined to an unrelated one by subject.)
 */
export function sameConversation(a: Meta, b: Meta, own: Set<string>): boolean {
  const base = baseSubject(a.subject);
  if (!usableSubject(base) || baseSubject(b.subject) !== base) return false;
  if (!(hasReplyPrefix(a.subject) || (hasReplyPrefix(b.subject) && !b.referenced))) return false;
  if (Math.abs(a.date.getTime() - b.date.getTime()) > WINDOW_DAYS * 86_400_000) return false;
  for (const p of a.people) if (!own.has(p) && b.people.has(p)) return true;
  return false;
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let p = this.parent.get(x);
    if (p === undefined) { this.parent.set(x, x); return x; }
    if (p === x) return x;
    p = this.find(p);
    this.parent.set(x, p);
    return p;
  }
  union(a: string, b: string) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent.set(ra, rb); }
}

export async function assignThreads(accountId: string, messageIds: string[]) {
  if (!messageIds.length) return;
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`threads:${accountId}`]); // one threader per account

    const { rows } = await client.query(
      "select id, message_id, in_reply_to, refs, subject, date, from_addr, to_addrs, cc_addrs from messages where id = any($1::bigint[])", [messageIds]);
    const msgs = rows.map((r) => ({
      id: String(r.id),
      keys: [...new Set([norm(r.message_id), norm(r.in_reply_to), ...(r.refs as string[]).map(norm)].filter((k): k is string => !!k))],
      meta: { id: String(r.id), subject: String(r.subject ?? ""), date: new Date(r.date), people: peopleOf(r), referenced: !!r.in_reply_to || (r.refs as string[]).length > 0 } as Meta,
    }));
    // the account's own addresses never count as "someone in common"
    const { rows: ownRows } = await client.query(
      "select lower(email) as e from identities where account_id = $1 union select lower(email) from accounts where id = $1", [accountId]);
    const own = new Set<string>(ownRows.map((r) => r.e));

    const allKeys = [...new Set(msgs.flatMap((m) => m.keys))];
    const known = new Map<string, string>(); // key -> existing thread id
    if (allKeys.length) {
      const { rows: kr } = await client.query(
        "select msgid, thread_id from thread_keys where account_id = $1 and msgid = any($2::text[])", [accountId, allKeys]);
      for (const k of kr) known.set(k.msgid, String(k.thread_id));
    }

    // Connect messages, keys and already-existing threads into components.
    const uf = new UnionFind();
    for (const m of msgs) {
      uf.find(`m:${m.id}`);
      for (const k of m.keys) {
        uf.union(`m:${m.id}`, `k:${k}`);
        const t = known.get(k);
        if (t) uf.union(`k:${k}`, `t:${t}`);
      }
    }
    // Subject fallback within this batch: messages without reply headers that clearly belong together. Only messages with the
    // same subject are compared (grouped first), so a big batch stays cheap.
    const bases = new Map(msgs.map((m) => [m.id, baseSubject(m.meta.subject)]));
    const loose = msgs.filter((m) => !m.meta.referenced && usableSubject(bases.get(m.id)!));
    // remember their subject without prefixes (indexed), so later mail finds them without scanning
    if (loose.length) await client.query(
      "update messages m set base_subject = t.b from jsonb_to_recordset($1::jsonb) as t(id text, b text) where m.id = t.id::bigint",
      [JSON.stringify(loose.map((m) => ({ id: m.id, b: bases.get(m.id) })))]);
    const bySubject = new Map<string, typeof msgs>();
    for (const m of msgs) { const b = bases.get(m.id)!; if (usableSubject(b)) bySubject.set(b, [...(bySubject.get(b) ?? []), m]); }
    for (const a of loose) for (const b of bySubject.get(bases.get(a.id)!) ?? []) {
      if (a !== b && sameConversation(a.meta, b.meta, own)) uf.union(`m:${a.id}`, `m:${b.id}`);
    }

    const comps = new Map<string, { msgIds: string[]; keys: Set<string>; threads: Set<string> }>();
    const comp = (root: string) => { let c = comps.get(root); if (!c) { c = { msgIds: [], keys: new Set(), threads: new Set() }; comps.set(root, c); } return c; };
    for (const m of msgs) { const c = comp(uf.find(`m:${m.id}`)); c.msgIds.push(m.id); m.keys.forEach((k) => c.keys.add(k)); }
    for (const [k, t] of known) comp(uf.find(`k:${k}`)).threads.add(t);

    // Subject fallback against earlier mail: a conversation that would start fresh may belong to one already here. One query
    // for the whole batch (indexed on base_subject), then matched here.
    const byId = new Map(msgs.map((m) => [m.id, m]));
    const fresh0 = [...comps.values()].filter((c) => !c.threads.size);
    const looking = fresh0.flatMap((c) => c.msgIds.map((id) => byId.get(id)!)).filter((m) => !m.meta.referenced && usableSubject(bases.get(m.id)!));
    // a reply may join any earlier message with its subject; a first message only an earlier reply (sameConversation), so for
    // those only messages with a reply prefix are fetched: recurring subjects (newsletters, weekly mails) then cost nothing
    const anyFor = [...new Set(looking.filter((m) => hasReplyPrefix(m.meta.subject)).map((m) => bases.get(m.id)!))];
    const repliesFor = [...new Set(looking.filter((m) => !hasReplyPrefix(m.meta.subject)).map((m) => bases.get(m.id)!))].filter((b) => !anyFor.includes(b));
    if (anyFor.length || repliesFor.length) {
      const { rows: cand } = await client.query(
        `select m.thread_id, m.subject, m.date, m.from_addr, m.to_addrs, m.cc_addrs, m.base_subject
           from messages m join folders f on f.id = m.folder_id
          where (m.base_subject = any($2::text[]) or (m.base_subject = any($7::text[]) and m.subject ~* $8))
            and f.account_id = $1 and m.thread_id is not null and not (m.id = any($3::bigint[]))
            and m.date between $4::timestamptz - make_interval(days => $6) and $5::timestamptz + make_interval(days => $6)
          limit 5000`,
        [accountId, anyFor, msgs.map((m) => m.id),
          new Date(Math.min(...msgs.map((m) => m.meta.date.getTime()))).toISOString(), new Date(Math.max(...msgs.map((m) => m.meta.date.getTime()))).toISOString(), WINDOW_DAYS,
          repliesFor, PREFIX_SQL]);
      const earlier = new Map<string, Meta[]>();
      for (const r of cand) earlier.set(r.base_subject, [...(earlier.get(r.base_subject) ?? []),
        { id: "", subject: r.subject, date: new Date(r.date), people: peopleOf(r), referenced: false, thread: String(r.thread_id) }]);
      for (const c of fresh0) {
        for (const id of c.msgIds) {
          const m = byId.get(id)!;
          if (m.meta.referenced) continue;
          const hit = (earlier.get(bases.get(id)!) ?? []).find((e) => sameConversation(m.meta, e, own));
          if (hit) { c.threads.add(hit.thread!); break; }
        }
      }
    }

    const needNew = [...comps.values()].filter((c) => c.threads.size === 0).length;
    const fresh: string[] = needNew
      ? (await client.query("select nextval('thread_seq')::text as id from generate_series(1, $1)", [needNew])).rows.map((r) => r.id)
      : [];

    const msgThread: { id: string; thread: string }[] = [];
    const keyThread: { msgid: string; thread: string }[] = [];
    for (const c of comps.values()) {
      const ids = [...c.threads].sort((a, b) => Number(a) - Number(b));
      const canon = ids[0] ?? fresh.pop()!;
      if (ids.length > 1) { // this batch bridges separate threads: merge them into the oldest
        const others = ids.slice(1);
        await client.query("update messages set thread_id = $1 where thread_id = any($2::bigint[])", [canon, others]);
        await client.query("update thread_keys set thread_id = $1 where account_id = $3 and thread_id = any($2::bigint[])", [canon, others, accountId]);
      }
      c.msgIds.forEach((id) => msgThread.push({ id, thread: canon }));
      c.keys.forEach((k) => keyThread.push({ msgid: k, thread: canon }));
    }

    await client.query(
      "update messages m set thread_id = t.thread::bigint from jsonb_to_recordset($1::jsonb) as t(id text, thread text) where m.id = t.id::bigint",
      [JSON.stringify(msgThread)]);
    if (keyThread.length) {
      await client.query(
        `insert into thread_keys (account_id, msgid, thread_id)
         select $1, t.msgid, t.thread::bigint from jsonb_to_recordset($2::jsonb) as t(msgid text, thread text)
         on conflict (account_id, msgid) do update set thread_id = excluded.thread_id`,
        [accountId, JSON.stringify(keyThread)]);
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/** Thread everything that has no thread yet (existing mailboxes, or rows left over from an interrupted sync). */
export async function backfillThreads(log: { info: (...a: any[]) => void; error: (...a: any[]) => void }) {
  const { rows: accounts } = await pool.query("select id from accounts");
  for (const a of accounts) {
    let total = 0;
    try { // one account's trouble must not keep the others unthreaded
      for (;;) {
        const { rows } = await pool.query(
          `select m.id from messages m join folders f on f.id = m.folder_id
           where f.account_id = $1 and m.thread_id is null order by m.id limit 1000`, [a.id]);
        if (!rows.length) break;
        await assignThreads(a.id, rows.map((r) => String(r.id)));
        total += rows.length;
      }
    } catch (e) {
      log.error(e, `thread backfill failed for account ${a.id}`);
    }
    if (total) log.info({ accountId: a.id, total }, "threaded existing messages");
  }
}
