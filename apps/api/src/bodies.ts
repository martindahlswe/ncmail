import { pool } from "./db.ts";
import { loadAccount } from "./accounts.ts";
import { withImap } from "./mail.ts";
import { parseSource } from "./content.ts";

/** Cache a parsed message body (what the reader shows), so opening the message later is a database read. */
export async function storeBody(messageId: string, cache: Awaited<ReturnType<typeof parseSource>>["cache"]) {
  await pool.query(
    `insert into message_bodies (message_id, html, text, attachments, headers) values ($1,$2,$3,$4,$5)
     on conflict (message_id) do nothing`,
    [messageId, cache.html, cache.text, JSON.stringify(cache.attachments), JSON.stringify(cache.headers)]);
}

const MAX_BYTES = 3 * 1024 * 1024;
const running = new Set<string>();

/**
 * Keep the newest INBOX messages' bodies cached, so the mail you are most likely to open next opens instantly.
 * One IMAP command for the whole batch; read-only (does not mark anything as read).
 */
export function prefetchRecentBodies(accountId: string, limit = 30) {
  if (running.has(accountId)) return;
  running.add(accountId);
  (async () => {
    try {
      const { rows } = await pool.query(
        `select m.id, m.uid, f.path from messages m join folders f on f.id = m.folder_id
         where f.account_id = $1 and f.special_use = '\\Inbox' and m.size < $3
           and not exists (select 1 from message_bodies b where b.message_id = m.id)
         order by m.date desc, m.id desc limit $2`, [accountId, limit, MAX_BYTES]);
      if (!rows.length) return;
      const cfg = await loadAccount(accountId);
      await withImap(cfg.imap, async (c) => {
        const lock = await c.getMailboxLock(rows[0].path, { readOnly: true });
        try {
          const byUid = new Map(rows.map((r) => [Number(r.uid), String(r.id)]));
          for await (const msg of c.fetch([...byUid.keys()].join(","), { uid: true, source: true }, { uid: true })) {
            if (!msg.source) continue;
            try { await storeBody(byUid.get(msg.uid)!, (await parseSource(msg.source)).cache); } catch { /* unparseable: it will be fetched on demand */ }
          }
        } finally { lock.release(); }
      });
    } catch { /* best effort */ }
    finally { running.delete(accountId); }
  })();
}
