import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { simpleParser } from "mailparser";
import { convert } from "html-to-text";
import { bgPool, pool } from "./db.ts";
import { READABLE_SQL } from "./acl.ts";
import { loadAccount } from "./accounts.ts";
import { withImap } from "./mail.ts";

/**
 * Optional local index of message text, so search can look inside bodies without asking the server.
 *  - Off by default; enabled per account (it downloads every message once).
 *  - Read-only: messages are fetched with BODY.PEEK semantics, so nothing is marked as read.
 *  - Newest first, folder by folder, small throttled batches. Junk and Trash are skipped.
 *  - Stores a Postgres tsvector ('simple' config: no stemming, works for any language) plus a short preview.
 */

type Log = { error: (...a: any[]) => void; info: (...a: any[]) => void };
let log: Log = { error: console.error, info: () => {} };

const BATCH = 50;
const MAX_FETCH_BYTES = 15 * 1024 * 1024; // bigger messages are not downloaded for indexing
const MAX_TEXT_CHARS = 200_000;
const SLICE_MS = 5 * 60_000;              // yield after a while; the next tick continues
const PAUSE_MS = 150;                     // be gentle with the server

const running = new Set<string>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SCOPE = `f.selectable and (f.special_use is null or f.special_use not in ('\\Trash', '\\Junk')) and ${READABLE_SQL}`;

export async function indexCounts(accountId: string) {
  const { rows: [r] } = await pool.query(
    `select count(*)::int as total, count(t.message_id)::int as indexed
     from messages m join folders f on f.id = m.folder_id left join message_text t on t.message_id = m.id
     where f.account_id = $1 and ${SCOPE}`, [accountId]);
  return r as { total: number; indexed: number };
}

async function put(messageId: string, text: string) {
  const clipped = text.slice(0, MAX_TEXT_CHARS);
  await bgPool.query(
    `insert into message_text (message_id, tsv, preview) values ($1, to_tsvector('simple', $2), $3)
     on conflict (message_id) do update set tsv = excluded.tsv, preview = excluded.preview`,
    [messageId, clipped.replace(/\u0000/g, ""), clipped.replace(/\s+/g, " ").trim().slice(0, 160)]);
}

async function indexOne(messageId: string, source: Buffer) {
  try {
    const p = await simpleParser(source);
    const body = p.text?.trim() || (typeof p.html === "string" ? convert(p.html, { wordwrap: false, selectors: [{ selector: "img", format: "skip" }, { selector: "a", options: { ignoreHref: true } }] }) : "");
    const names = p.attachments.map((a) => a.filename).filter(Boolean).join(" ");
    await put(messageId, `${body} ${names}`);
  } catch {
    await put(messageId, ""); // unparseable: mark as done so we do not retry forever
  }
}

async function runIndex(accountId: string) {
  const enabled = async () => !!(await bgPool.query("select 1 from accounts where id = $1 and index_bodies", [accountId])).rowCount;
  if (!(await enabled())) return;
  const cfg = await loadAccount(accountId);
  const { rows: folders } = await bgPool.query(
    `select f.id, f.path from folders f where f.account_id = $1 and ${SCOPE}
     order by (f.special_use = '\\Inbox') desc nulls last, f.name`, [accountId]);

  await withImap(cfg.imap, async (client) => {
    const started = Date.now();
    for (const f of folders) {
      let cursor: { date: string; id: string } | null = null;
      for (;;) {
        if (Date.now() - started > SLICE_MS || !(await enabled())) return;
        const params: unknown[] = [f.id];
        let after = "";
        if (cursor) { params.push(cursor.date, cursor.id); after = "and (m.date, m.id) < ($2::timestamptz, $3::bigint)"; }
        const { rows } = await bgPool.query(
          `select m.id, m.uid, m.size, m.date from messages m
           where m.folder_id = $1 ${after} and not exists (select 1 from message_text t where t.message_id = m.id)
           order by m.date desc, m.id desc limit ${BATCH}`, params);
        if (!rows.length) break;
        cursor = { date: rows[rows.length - 1].date.toISOString(), id: String(rows[rows.length - 1].id) };

        const small = rows.filter((r) => r.size <= MAX_FETCH_BYTES);
        for (const r of rows.filter((r) => r.size > MAX_FETCH_BYTES)) await put(String(r.id), "");
        if (small.length) {
          const lock = await client.getMailboxLock(f.path, { readOnly: true });
          try {
            const byUid = new Map(small.map((r) => [Number(r.uid), r]));
            const seen = new Set<number>();
            for await (const msg of client.fetch([...byUid.keys()].join(","), { uid: true, source: true }, { uid: true })) {
              seen.add(msg.uid);
              if (msg.source) await indexOne(String(byUid.get(msg.uid)!.id), msg.source);
            }
            for (const [uid, r] of byUid) if (!seen.has(uid)) await put(String(r.id), ""); // gone from the server since the last sync
          } finally { lock.release(); }
        }
        await sleep(PAUSE_MS);
      }
    }
  });
}

/** Start indexing an account if it is enabled and has work left. Safe to call often. */
export function kickIndexer(accountId: string) {
  if (running.has(accountId)) return;
  running.add(accountId);
  (async () => {
    try {
      const { rows } = await bgPool.query("select index_bodies from accounts where id = $1", [accountId]);
      if (!rows[0]?.index_bodies) return;
      const c = await indexCounts(accountId);
      if (c.indexed >= c.total) return;
      await runIndex(accountId);
    } catch (e) { log.error(e, "body indexing failed"); }
    finally { running.delete(accountId); }
  })();
}

export function startBodyIndexer(l: Log) {
  log = l;
  const tick = async () => {
    const { rows } = await bgPool.query("select id from accounts where index_bodies");
    for (const r of rows) kickIndexer(r.id);
  };
  tick().catch(() => {});
  setInterval(() => tick().catch(() => {}), 30_000).unref();
}

export async function indexRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/api/accounts/:id/index", async (req) => {
    const { rows } = await pool.query("select index_bodies from accounts where id = $1", [req.params.id]);
    if (!rows[0]) throw Object.assign(new Error("Account not found"), { statusCode: 404 });
    const c = await indexCounts(req.params.id);
    return { enabled: !!rows[0].index_bodies, ...c, running: running.has(req.params.id) };
  });

  // Turning it off also deletes the stored index (it can be rebuilt by turning it on again).
  app.patch<{ Params: { id: string } }>("/api/accounts/:id/index", async (req) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const { rowCount } = await pool.query("update accounts set index_bodies = $2 where id = $1", [req.params.id, enabled]);
    if (!rowCount) throw Object.assign(new Error("Account not found"), { statusCode: 404 });
    if (enabled) kickIndexer(req.params.id);
    else await bgPool.query( // can be a large delete
      `delete from message_text where message_id in (select m.id from messages m join folders f on f.id = m.folder_id where f.account_id = $1)`, [req.params.id]);
    const c = await indexCounts(req.params.id);
    return { enabled, ...c, running: running.has(req.params.id) };
  });
}
