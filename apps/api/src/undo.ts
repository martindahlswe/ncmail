import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { loadAccount } from "./accounts.ts";
import { withImap } from "./mail.ts";
import { syncFolder } from "./sync.ts";
import { ownerOf } from "./auth.ts";
import { pool } from "./db.ts";

/**
 * Undo for moves (including delete-to-Trash, archive and spam). The server remembers where the moved copies landed
 * (from the COPYUID response), so "undo" is just moving exactly those messages back. Entries expire after 5 minutes.
 */

export interface UndoEntry { srcFolderId: string; srcPath: string; destFolderId: string; destPath: string; destUids: number[]; unflag?: string[]; unsnooze?: boolean }
interface Pending { accountId: string; entries: UndoEntry[]; created: number }
const pending = new Map<string, Pending>();
const TTL_MS = 5 * 60_000;

export function rememberUndo(accountId: string, entries: UndoEntry[]): string | null {
  const usable = entries.filter((e) => e.destUids.length);
  if (!usable.length) return null; // server did not say where the copies went (no UIDPLUS): cannot undo reliably
  const token = randomUUID();
  pending.set(token, { accountId, entries: usable, created: Date.now() });
  for (const [t, p] of pending) if (Date.now() - p.created > TTL_MS) pending.delete(t);
  return token;
}

export async function undoRoutes(app: FastifyInstance) {
  app.post<{ Params: { token: string } }>("/api/undo/:token", async (req) => {
    const p = pending.get(req.params.token);
    if (!p || Date.now() - p.created > TTL_MS) throw Object.assign(new Error("This can no longer be undone"), { statusCode: 410 });
    if ((await ownerOf(p.accountId)) !== req.owner) throw Object.assign(new Error("This can no longer be undone"), { statusCode: 410 });
    pending.delete(req.params.token);
    const cfg = await loadAccount(p.accountId);
    let restored = 0;
    await withImap(cfg.imap, async (c) => {
      for (const e of p.entries) {
        const lock = await c.getMailboxLock(e.destPath);
        try {
          const uids = e.destUids.join(",");
          if (e.unflag?.length) await c.messageFlagsRemove(uids, e.unflag, { uid: true });
          await c.messageMove(uids, e.srcPath, { uid: true });
          if (e.unsnooze) await pool.query("delete from snoozes where account_id = $1 and dest_uid = any($2::bigint[])", [p.accountId, e.destUids]);
          restored += e.destUids.length;
        } finally { lock.release(); }
      }
    });
    for (const e of p.entries) { syncFolder(e.srcFolderId).catch(() => {}); syncFolder(e.destFolderId).catch(() => {}); }
    return { restored };
  });
}
