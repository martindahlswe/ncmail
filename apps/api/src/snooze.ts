import { pool } from "./db.ts";
import { loadAccount } from "./accounts.ts";
import { withImap } from "./mail.ts";
import { syncFolder } from "./sync.ts";
import { publish } from "./events.ts";

/**
 * Snoozing moves a message to a "Snoozed" folder (on the mail server, so every client sees it there) and records when to bring it back.
 * When the time comes it returns to the folder it came from as unread, at the top.
 */
type Log = { warn: (...a: any[]) => void };

export async function wakeDue(log: Log) {
  const { rows } = await pool.query(
    `select id, account_id, dest_path, dest_folder_id, dest_uid, return_path from snoozes where until <= now() order by account_id, dest_path limit 500`);
  const by = new Map<string, typeof rows>();
  for (const r of rows) by.set(r.account_id, [...(by.get(r.account_id) ?? []), r]);
  for (const [accountId, list] of by) {
    try {
      const cfg = await loadAccount(accountId);
      const returned = new Set<string>();
      await withImap(cfg.imap, async (c) => {
        const groups = new Map<string, typeof rows>();
        for (const r of list) groups.set(`${r.dest_path}\u0000${r.return_path}`, [...(groups.get(`${r.dest_path}\u0000${r.return_path}`) ?? []), r]);
        for (const g of groups.values()) {
          const lock = await c.getMailboxLock(g[0]!.dest_path);
          try {
            const uids = g.map((r) => r.dest_uid).join(",");
            await c.messageFlagsRemove(uids, ["\\Seen"], { uid: true }).catch(() => {});
            await c.messageMove(uids, g[0]!.return_path, { uid: true }).catch(() => {}); // already gone (deleted by hand): nothing to return
            returned.add(g[0]!.return_path);
          } finally { lock.release(); }
        }
      });
      await pool.query("delete from snoozes where id = any($1::bigint[])", [list.map((r) => r.id)]);
      const { rows: fs } = await pool.query("select id from folders where account_id = $1 and (path = any($2::text[]) or id = any($3::bigint[]))", [accountId, [...returned], [...new Set(list.map((r) => r.dest_folder_id))]]);
      for (const f of fs) await syncFolder(String(f.id)).catch(() => {});
      publish({ type: "sync", accountId });
    } catch (e: any) { log.warn({ err: e.message, accountId }, "could not wake snoozed messages"); }
  }
}

export function startSnooze(log: Log) {
  let busy = false;
  const tick = () => { if (busy) return; busy = true; wakeDue(log).catch((e) => log.warn(e)).finally(() => { busy = false; }); };
  setInterval(tick, Number(process.env.NCMAIL_SNOOZE_TICK_MS ?? 20_000)).unref();
}
