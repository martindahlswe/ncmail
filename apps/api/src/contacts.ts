import type { FastifyInstance } from "fastify";
import { bgPool, pool } from "./db.ts";
import { searchNcContacts } from "./nextcloud/contacts.ts";

/**
 * Recipient suggestions come from your own mail: people who wrote to you (weighted once) and people you wrote to
 * (weighted three times), kept in a small table that sync updates, so suggestions are instant on any mailbox size.
 */

interface RowLike { uid: number; from_name: string; from_addr: string; to_addrs: { name: string; address: string }[]; cc_addrs: { name: string; address: string }[]; date: string }

export async function recordContacts(accountId: string, inSent: boolean, rows: RowLike[]) {
  const map = new Map<string, { email: string; name: string; f: number; t: number; d: string }>();
  const bump = (email: string, name: string, kind: "f" | "t", d: string) => {
    email = email.trim().toLowerCase();
    if (!email.includes("@")) return;
    const c = map.get(email) ?? { email, name: "", f: 0, t: 0, d };
    c[kind]++; if (!c.name && name) c.name = name; if (d > c.d) c.d = d;
    map.set(email, c);
  };
  for (const r of rows) {
    if (inSent) for (const a of [...r.to_addrs, ...r.cc_addrs]) bump(a.address, a.name, "t", r.date);
    else bump(r.from_addr, r.from_name, "f", r.date);
  }
  if (!map.size) return;
  await bgPool.query(
    `insert into contacts (account_id, email, name, from_count, to_count, last_date)
     select $1, t.email, t.name, t.f, t.t, t.d from jsonb_to_recordset($2::jsonb) as t(email text, name text, f int, t int, d timestamptz)
     on conflict (account_id, email) do update set
       from_count = contacts.from_count + excluded.from_count, to_count = contacts.to_count + excluded.to_count,
       last_date = greatest(contacts.last_date, excluded.last_date),
       name = case when contacts.name = '' then excluded.name else contacts.name end`,
    [accountId, JSON.stringify([...map.values()])]);
}

/** Build the table for mailboxes that were synced before it existed. */
export async function backfillContacts(log: { info: (...a: any[]) => void }) {
  const { rowCount } = await bgPool.query(
    `insert into contacts (account_id, email, name, from_count, to_count, last_date)
     select account_id, email, max(name), sum(f)::int, sum(t)::int, max(d) from (
       select f.account_id, lower(m.from_addr) as email, m.from_name as name, 1 as f, 0 as t, m.date as d
         from messages m join folders f on f.id = m.folder_id
         where coalesce(f.special_use, '') <> '\\Sent' and m.from_addr like '%@%'
       union all
       select f.account_id, lower(e->>'address'), coalesce(e->>'name', ''), 0, 1, m.date
         from messages m join folders f on f.id = m.folder_id cross join lateral jsonb_array_elements(m.to_addrs || m.cc_addrs) e
         where f.special_use = '\\Sent' and (e->>'address') like '%@%'
     ) x
     where not exists (select 1 from contacts c where c.account_id = x.account_id)
     group by account_id, email
     on conflict do nothing`);
  if (rowCount) log.info({ contacts: rowCount }, "built contact suggestions from existing mail");
}

export async function contactRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q?: string; limit?: string; accountId?: string } }>("/api/contacts", async (req) => {
    const q = (req.query.q ?? "").trim().toLowerCase();
    if (!q) return [];
    const limit = Math.min(Number(req.query.limit ?? 8), 20);
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const { rows } = await pool.query(
      `select email, name, to_count, from_count from contacts c
       where lower(c.name || ' ' || c.email) like $1 and ($2::uuid is null or c.account_id = $2)
         and exists (select 1 from accounts ac where ac.id = c.account_id and ac.owner = $5)
         and not exists (select 1 from identities i join accounts ia on ia.id = i.account_id where ia.owner = $5 and lower(i.email) = c.email)
       order by (c.email like $3 or lower(c.name) like $3) desc, (c.to_count * 3 + c.from_count) desc, c.last_date desc nulls last
       limit $4`, [like, req.query.accountId ?? null, `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, limit, req.owner]);
    // People from Nextcloud Contacts come first, then the people you have written to; the same person appears once.
    const nc = await searchNcContacts(req.owner, q, limit).catch(() => []);
    const seen = new Set<string>();
    const all = [...nc.map((c) => ({ email: c.email, name: c.name, sentTo: 0, source: "nextcloud" })), ...rows.map((r) => ({ email: r.email, name: r.name, sentTo: r.to_count, source: "mail" }))];
    return all.filter((r) => !seen.has(r.email) && seen.add(r.email)).slice(0, limit);
  });
}
