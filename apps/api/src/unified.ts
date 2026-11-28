import type { FastifyInstance } from "fastify";
import { pool } from "./db.ts";
import { listItem } from "./routes.ts";

/** One list of the INBOX of every account the user has, newest first. */
export async function unifiedRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { limit?: string; cursor?: string; filter?: string; sort?: string } }>("/api/unified/messages", async (req) => {
    const q = req.query;
    const limit = Math.min(Number(q.limit ?? 50), 300);
    const asc = q.sort === "date_asc";
    const { rows: boxes } = await pool.query(
      `select f.id, f.name, f.account_id, a.name as account_name from folders f join accounts a on a.id = f.account_id
       where a.owner = $1 and f.special_use = '\\Inbox' order by a.created_at`, [req.owner]);
    if (!boxes.length) return { items: [], next: null };
    const args: unknown[] = [limit + 1];
    let cur: { v: string; id: string } | null = null;
    if (q.cursor) { try { cur = JSON.parse(q.cursor); } catch { /* start from the top */ } }
    if (cur) args.push(cur.v, cur.id);
    const dir = asc ? "asc" : "desc";
    const filter = q.filter === "unread" ? "and not ('\\Seen' = any(m.flags))" : q.filter === "starred" ? "and '\\Flagged' = any(m.flags)" : q.filter === "attachments" ? "and m.has_attachments" : "";
    const cursor = cur ? `and (m.date, m.id) ${asc ? ">" : "<"} ($2::timestamptz, $3::bigint)` : "";
    // each inbox answers from its own (folder, date, id) index; the few results are then merged
    const parts = boxes.map((b) => `(select m.*, ${Number(b.id)}::bigint as fid from messages m where m.folder_id = ${Number(b.id)} ${filter} ${cursor} order by m.date ${dir}, m.id ${dir} limit $1)`);
    const { rows } = await pool.query(`select * from (${parts.join(" union all ")}) u order by date ${dir}, id ${dir} limit $1`, args);
    const page = rows.slice(0, limit);
    const by = new Map(boxes.map((b) => [String(b.id), b]));
    const items = page.map((r) => { const b = by.get(String(r.fid))!; return { ...listItem(r), folderId: String(r.fid), folderName: b.name, accountId: b.account_id, accountName: b.account_name }; });
    const last = rows[limit - 1];
    return { items, next: rows.length > limit ? { v: last.date.toISOString(), id: String(last.id), date: last.date.toISOString() } : null };
  });
}
