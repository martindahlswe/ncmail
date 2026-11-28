import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "./db.ts";
import { loadAccount } from "./accounts.ts";
import { withImap } from "./mail.ts";
import { syncAccount, syncFolder, withAccountLock, withFolderFlags } from "./sync.ts";
import { LABEL_PREFIX } from "./labels.ts";
import { rememberUndo, type UndoEntry } from "./undo.ts";

/**
 * Bulk actions. One IMAP connection, and one command per folder per chunk of UIDs, instead of one per message.
 * Targets can be explicit message ids, whole conversations (their messages in the given folder), or everything in a folder.
 * Moves report where the messages landed, so they can be undone.
 */

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const MAX_ROWS = 20_000;
const CHUNK = 500; // UIDs per IMAP command

const bodySchema = z.object({
  action: z.enum(["read", "unread", "star", "unstar", "move", "copy", "delete", "spam", "notspam", "snooze", "label", "unlabel"]),
  /** snooze: when to bring the messages back (ISO time) */
  until: z.string().datetime().optional(),
  /** label / unlabel: the label's slug */
  label: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
  messageIds: z.array(z.string()).max(5000).default([]),
  threadIds: z.array(z.string()).max(5000).default([]),
  /** Context folder: where `threadIds` are resolved, and the target of scope "folder". */
  folderId: z.string().optional(),
  scope: z.enum(["selected", "folder"]).default("selected"),
  unreadOnly: z.boolean().optional(),
  targetFolderId: z.string().optional(),
});

const chunks = <T>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const uidSet = (rows: { uid: string }[]) => rows.map((r) => r.uid).join(",");

export async function bulkRoutes(app: FastifyInstance) {
  app.post("/api/messages/bulk", async (req) => {
    const b = bodySchema.parse(req.body);

    // ---- resolve the target rows ----
    let rows: { id: string; uid: string; folder_id: string; flags: string[]; path: string; account_id: string; special_use: string | null }[];
    const cols = `m.id, m.uid, m.folder_id, m.flags, f.path, f.account_id, f.special_use`;
    if (b.scope === "folder") {
      if (!b.folderId) throw httpError(400, "folderId is required for scope=folder");
      ({ rows } = await pool.query(
        `select ${cols} from messages m join folders f on f.id = m.folder_id
         where m.folder_id = $1 ${b.unreadOnly ? "and not ('\\Seen' = any(m.flags))" : ""} limit ${MAX_ROWS + 1}`, [b.folderId]));
    } else {
      if (b.threadIds.length && !b.folderId) throw httpError(400, "folderId is required with threadIds");
      ({ rows } = await pool.query(
        `select ${cols} from messages m join folders f on f.id = m.folder_id
         where m.id = any($1::bigint[]) or (m.folder_id = $2 and m.thread_id = any($3::bigint[])) limit ${MAX_ROWS + 1}`,
        [b.messageIds, b.folderId ?? null, b.threadIds]));
    }
    if (rows.length > MAX_ROWS) throw httpError(400, `Too many messages at once (limit ${MAX_ROWS})`);
    if (!rows.length) return { affected: 0 };
    const accountId = rows[0]!.account_id;
    if (rows.some((r) => r.account_id !== accountId)) throw httpError(400, "All messages must belong to the same account");
    const cfg = await loadAccount(accountId);

    // ---- destination for move / copy / delete / spam ----
    const folderBy = async (sql: string, args: unknown[]) => {
      const { rows: [d] } = await pool.query(sql, args);
      return d ? { id: String(d.id), path: d.path as string } : null;
    };
    let dest: { id: string; path: string } | null = null;
    if (b.action === "move" || b.action === "copy") {
      if (!b.targetFolderId) throw httpError(400, "targetFolderId is required");
      dest = await folderBy("select id, path from folders where id = $1 and account_id = $2", [b.targetFolderId, accountId]);
      if (!dest) throw httpError(400, "Bad destination folder");
    } else if (b.action === "delete") {
      dest = await folderBy("select id, path from folders where account_id = $1 and special_use = '\\Trash'", [accountId]); // moved to Trash unless already there
    } else if (b.action === "spam") {
      dest = await folderBy("select id, path from folders where account_id = $1 and special_use = '\\Junk'", [accountId]);
      if (!dest) throw httpError(400, "This account has no Junk folder");
    } else if (b.action === "notspam") {
      dest = await folderBy("select id, path from folders where account_id = $1 and special_use = '\\Inbox'", [accountId]);
    } else if (b.action === "snooze") {
      if (!b.until || new Date(b.until) <= new Date()) throw httpError(400, "Choose a time in the future");
      const find = () => folderBy("select id, path from folders where account_id = $1 and special_use is null and lower(path) = 'snoozed'", [accountId]);
      dest = await find();
      if (!dest) { // first time: make the folder on the server, then learn about it
        await withImap(cfg.imap, (c) => c.mailboxCreate("Snoozed")).catch(() => {});
        await syncAccount(accountId).catch(() => {});
        dest = await find();
        if (!dest) throw httpError(502, "Could not create the Snoozed folder on the mail server");
      }
    }
    if ((b.action === "label" || b.action === "unlabel") && !b.label) throw httpError(400, "label is required");

    const byFolder = new Map<string, typeof rows>();
    for (const r of rows) byFolder.set(String(r.folder_id), [...(byFolder.get(String(r.folder_id)) ?? []), r]);

    const touched = new Set<string>();
    const undo: UndoEntry[] = [];
    await withImap(cfg.imap, async (c) => {
      for (const [folderId, list] of byFolder) {
        const path = list[0]!.path;
        const inTrash = list[0]!.special_use === "\\Trash";
        const lock = await c.getMailboxLock(path);
        try {
          for (const part of chunks(list, CHUNK)) {
            const uids = uidSet(part);
            const ids = part.map((r) => r.id);
            if (b.action === "read" || b.action === "unread" || b.action === "star" || b.action === "unstar" || b.action === "label" || b.action === "unlabel") {
              const flag = b.action === "read" || b.action === "unread" ? "\\Seen" : b.action === "label" || b.action === "unlabel" ? `${LABEL_PREFIX}${b.label}` : "\\Flagged";
              const add = b.action === "read" || b.action === "star" || b.action === "label";
              await withFolderFlags(folderId, async () => { // see withFolderFlags: a sync must not put the old flags back
                if (add) await c.messageFlagsAdd(uids, [flag], { uid: true });
                else await c.messageFlagsRemove(uids, [flag], { uid: true });
                await pool.query(
                  add
                    ? "update messages set flags = array_append(array_remove(flags, $2), $2) where id = any($1::bigint[])"
                    : "update messages set flags = array_remove(flags, $2) where id = any($1::bigint[])",
                  [ids, flag]);
              });
            } else if (b.action === "copy") {
              if (dest!.id !== folderId) { await c.messageCopy(uids, dest!.path, { uid: true }); touched.add(dest!.id); }
            } else if (b.action === "snooze" && dest && dest.id === folderId) {
              // already in Snoozed: just change when it comes back
              await pool.query("update snoozes set until = $3 where account_id = $1 and dest_uid = any($2::bigint[])", [accountId, part.map((r) => Number(r.uid)), b.until]);
            } else if (b.action === "move" || b.action === "spam" || b.action === "notspam" || b.action === "snooze" || (b.action === "delete" && dest && !inTrash)) {
              if (dest && dest.id !== folderId) {
                if (b.action === "spam") await c.messageFlagsAdd(uids, ["$Junk"], { uid: true });
                if (b.action === "notspam") { await c.messageFlagsRemove(uids, ["$Junk"], { uid: true }); await c.messageFlagsAdd(uids, ["$NotJunk"], { uid: true }); }
                const res: any = await c.messageMove(uids, dest.path, { uid: true });
                await pool.query("delete from messages where id = any($1::bigint[])", [ids]);
                touched.add(dest.id);
                const destUids: number[] = res?.uidMap ? [...(res.uidMap as Map<number, number>).values()] : [];
                undo.push({ srcFolderId: folderId, srcPath: path, destFolderId: dest.id, destPath: dest.path, destUids, unflag: b.action === "spam" ? ["$Junk"] : undefined, unsnooze: b.action === "snooze" });
                if (b.action === "snooze") for (const du of destUids) await pool.query("insert into snoozes (account_id, dest_folder_id, dest_path, dest_uid, return_path, until) values ($1,$2,$3,$4,$5,$6)", [accountId, dest.id, dest.path, du, inTrash ? "INBOX" : path, b.until]);
              }
            } else { // delete, and there is no Trash or we are already in it: expunge (cannot be undone)
              await c.messageDelete(uids, { uid: true });
              await pool.query("delete from messages where id = any($1::bigint[])", [ids]);
            }
          }
          touched.add(folderId);
        } finally { lock.release(); }
      }
    });

    // keep folder counters honest, and pick up moved/copied messages in their new folder
    const folderIds = [...touched];
    // under the account's lock, so a folder-list sync that read the counts before this change cannot write them back after it
    await withAccountLock(accountId, () => pool.query(
      `update folders f set total = (select count(*) from messages where folder_id = f.id),
         unseen = (select count(*) from messages where folder_id = f.id and not ('\\Seen' = any(flags)))
       where id = any($1::bigint[])`, [folderIds]));
    if (dest) syncFolder(dest.id).catch(() => {});
    const token = undo.length ? rememberUndo(accountId, undo) : null;
    return { affected: rows.length, undo: token };
  });
}
