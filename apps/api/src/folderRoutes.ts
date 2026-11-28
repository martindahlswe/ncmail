import { describeImapError, serverText } from "./imapError.ts";
import type { FastifyInstance } from "fastify";
import type { ImapFlow } from "imapflow";
import { z } from "zod";
import { pool, retryOnDeadlock } from "./db.ts";
import { loadAccount } from "./accounts.ts";
import { withImap } from "./mail.ts";
import { syncFolderListNow as syncFolderList, withAccountLock } from "./sync.ts";
import { publish } from "./events.ts";
import { filtersUsing, renameInFilters } from "./sieve/routes.ts";

/** Creating, renaming and deleting folders on the mail server. The mirror follows right away, so the sidebar does not wait for a sync. */

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

interface FolderRow { id: string; account_id: string; path: string; name: string; delimiter: string | null; special_use: string | null; namespace: string | null; rights: string | null; selectable: boolean }

async function loadFolder(id: string, owner: string): Promise<FolderRow> {
  const { rows: [f] } = await pool.query(
    "select f.id, f.account_id, f.path, f.name, f.delimiter, f.special_use, f.namespace, f.rights, f.selectable from folders f join accounts a on a.id = f.account_id where f.id = $1 and a.owner = $2", [id, owner]);
  if (!f) throw httpError(404, "Folder not found");
  return f;
}

const personal = (f: FolderRow) => (f.namespace ?? "personal") === "personal";
const isInbox = (f: FolderRow) => f.path.toUpperCase() === "INBOX" || f.special_use === "\\Inbox";
/** Subfolders may be made here: anywhere of your own, or where the server grants "k" (RFC 4314). */
const mayCreateIn = (f: FolderRow) => personal(f) || String(f.rights ?? "").includes("k");
/** The folder itself may be renamed or deleted: not Inbox or another special folder, and your own or one where the server grants "x". */
function assertManageable(f: FolderRow, what: "rename" | "delete") {
  if (isInbox(f) || f.special_use) throw httpError(400, `${isInbox(f) ? "Inbox" : f.name} is a special folder and cannot be ${what === "rename" ? "renamed" : "deleted"}.`);
  if (!personal(f) && !String(f.rights ?? "").includes("x")) throw httpError(403, `You may not ${what} this folder.`);
}

/** Inbox and special folders (Sent, Trash...) inside `f` go wherever `f` goes: refuse to move, rename or delete such a folder. */
async function assertNoSpecialInside(f: FolderRow, what: "rename" | "delete") {
  const delim = f.delimiter ?? "";
  if (!delim) return;
  const { rows: [inner] } = await pool.query(
    `select name, path from folders where account_id = $1 and left(path, length($2) + length($3)) = $2 || $3
       and (special_use is not null or upper(path) = 'INBOX') limit 1`, [f.account_id, f.path, delim]);
  if (inner) throw httpError(400, `${f.name} contains ${inner.path.toUpperCase() === "INBOX" ? "Inbox" : inner.name}, a special folder, so it cannot be ${what === "rename" ? "renamed or moved" : "deleted"}.`);
}

/** A folder name as typed: one level (no separator), no IMAP wildcards or control characters. */
function checkName(raw: string, delim: string): string {
  const name = raw.trim();
  if (!name) throw httpError(400, "Enter a name for the folder.");
  if (name.length > 200) throw httpError(400, "That name is too long.");
  if (name === "." || name === "..") throw httpError(400, "Choose another name.");
  if (/[\u0000-\u001f\u007f*%]/.test(name)) throw httpError(400, "A folder name cannot contain * or %.");
  if (delim && name.includes(delim)) throw httpError(400, `A folder name cannot contain "${delim}". Create the folder inside another one instead.`);
  if (name.toUpperCase() === "INBOX") throw httpError(400, "That name is reserved for the Inbox.");
  return name;
}

const parentOf = (path: string, delim: string) => { const i = delim ? path.lastIndexOf(delim) : -1; return i < 0 ? null : path.slice(0, i); };
const within = (path: string, root: string, delim: string) => path === root || (!!delim && path.startsWith(root + delim));

/** Translate the server's refusals into something a person can act on. */
function serverError(e: any, fallback: string): Error {
  const code = String(e?.serverResponseCode ?? e?.responseCode ?? "").toUpperCase();
  const text = serverText(e);
  if (code === "ALREADYEXISTS") return httpError(409, "A folder with that name already exists there.");
  if (code === "NONEXISTENT") return httpError(404, "The folder is no longer on the mail server.");
  if (code === "NOPERM") return httpError(403, "The mail server does not allow this.");
  if (code === "LIMIT" || code === "OVERQUOTA") return httpError(400, "The mail server refused: a limit was reached.");
  if (code && !e?.statusCode) return httpError(502, `${fallback}. ${describeImapError(e)}`);
  return httpError(e?.statusCode ?? 502, text ? `${fallback}: ${text}` : fallback);
}

/** A pooled connection may have the folder (or one inside it) selected; most servers refuse to rename or delete it then. */
async function release(client: ImapFlow, root: string, delim: string) {
  const sel = (client.mailbox as any)?.path as string | undefined;
  if (sel && within(sel, root, delim)) await client.mailboxClose().catch(() => {});
}

/**
 * Rename (or move) a folder on the server, then move the mirror along: rows keep their ids, so mirrored mail, open views and
 * undo tokens survive. Subfolders follow on the server and in the mirror.
 */
async function renameFolder(client: ImapFlow, f: FolderRow, to: string) {
  const delim = f.delimiter ?? "";
  await release(client, f.path, delim);
  try { await client.mailboxRename(f.path, to); } catch (e) { throw serverError(e, "The mail server could not rename the folder"); }
  await retryOnDeadlock(async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      // a sync that ran in between may already have listed the new name as an empty folder: the moved rows take its place
      await c.query(`delete from folders where account_id = $1 and (path = $2 or ($3 <> '' and left(path, length($2) + length($3)) = $2 || $3))
                       and not (path = $4 or ($3 <> '' and left(path, length($4) + length($3)) = $4 || $3))`,
        [f.account_id, to, delim, f.path]);
      await c.query(`update folders set path = $3 || substr(path, length($2) + 1) where account_id = $1 and (path = $2 or ($4 <> '' and left(path, length($2) + length($4)) = $2 || $4))`,
        [f.account_id, f.path, to, delim]);
      await c.query("commit");
    } catch (e) { await c.query("rollback").catch(() => {}); throw e; } finally { c.release(); }
  });
  await syncFolderList(client, f.account_id);
}

/** Delete a folder and everything inside it on the server, deepest first (servers keep a parent whose children remain). */
async function deleteFolderTree(client: ImapFlow, f: FolderRow) {
  const delim = f.delimiter ?? "";
  await release(client, f.path, delim);
  const below = delim ? (await client.list()).map((e) => e.path).filter((p) => p !== f.path && within(p, f.path, delim)) : [];
  below.sort((a, b) => b.length - a.length);
  try {
    for (const p of below) await client.mailboxDelete(p);
    await client.mailboxDelete(f.path);
  } catch (e) { throw serverError(e, "The mail server could not delete the folder"); }
  await retryOnDeadlock(() => pool.query(
    `delete from folders where account_id = $1 and (path = $2 or ($3 <> '' and left(path, length($2) + length($3)) = $2 || $3))`, [f.account_id, f.path, delim]));
  await syncFolderList(client, f.account_id);
}

/** Filters live on a separate Sieve service, which may be slow or missing: never hold up the folder change for long. */
const atMost = <T,>(p: Promise<T>, ms: number, fallback: T) => Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms).unref())]);
const FILTER_WAIT_MS = 3000;

/** "Name", or "Name 2", "Name 3"... when that is taken among `taken`. */
function freeName(name: string, taken: Set<string>, pathFor: (n: string) => string) {
  if (!taken.has(pathFor(name))) return name;
  for (let i = 2; i < 1000; i++) if (!taken.has(pathFor(`${name} ${i}`))) return `${name} ${i}`;
  return `${name} ${Date.now()}`;
}

export async function folderRoutes(app: FastifyInstance) {
  // New folder: at the top of the account, or inside `parentId`.
  app.post<{ Params: { id: string } }>("/api/accounts/:id/folders", async (req, reply) => {
    const b = z.object({ name: z.string().max(400), parentId: z.string().regex(/^\d{1,18}$/).nullish() }).parse(req.body);
    const accountId = req.params.id;
    const parent = b.parentId ? await loadFolder(b.parentId, req.owner) : null;
    if (parent && parent.account_id !== accountId) throw httpError(400, "That folder belongs to another account.");
    if (parent && !mayCreateIn(parent)) throw httpError(403, "You may not create folders inside this one.");
    const cfg = await loadAccount(accountId, req.owner);
    const path = await withAccountLock(accountId, () => withImap(cfg.imap, async (client) => {
      const ns = (client as any).namespace as { prefix?: string; delimiter?: string } | undefined;
      const delim = parent?.delimiter || ns?.delimiter || "/";
      const name = checkName(b.name, delim);
      // top level means the top of your own folders, which on some servers sits under a prefix such as "INBOX."
      const path = parent ? `${parent.path}${delim}${name}` : `${ns?.prefix ?? ""}${name}`;
      const { rows: [dup] } = await pool.query("select 1 from folders where account_id = $1 and lower(path) = lower($2)", [accountId, path]);
      if (dup) throw httpError(409, "A folder with that name already exists there.");
      let r: { created?: boolean } | undefined;
      try { r = await client.mailboxCreate(path); } catch (e) { throw serverError(e, "The mail server could not create the folder"); }
      if (r && r.created === false) throw httpError(409, "A folder with that name already exists there.");
      await syncFolderList(client, accountId);
      return path;
    }));
    const { rows: [row] } = await pool.query("select id, path, name from folders where account_id = $1 and path = $2", [accountId, path]);
    publish({ type: "sync", accountId });
    reply.code(201);
    return { id: row ? String(row.id) : null, path, name: row?.name ?? path };
  });

  // Rename a folder, or move it into another folder (`parentId`; null = the top). Its subfolders come along, and filters
  // that file mail into it are pointed at the new place.
  app.patch<{ Params: { id: string } }>("/api/folders/:id", async (req) => {
    const b = z.object({ name: z.string().max(400).optional(), parentId: z.string().regex(/^\d{1,18}$/).nullish() }).parse(req.body);
    const f = await loadFolder(req.params.id, req.owner);
    assertManageable(f, "rename");
    const delim = f.delimiter ?? "";
    const name = checkName(b.name ?? f.name, delim);
    const moving = b.parentId !== undefined;
    const parent = moving && b.parentId ? await loadFolder(b.parentId, req.owner) : null;
    if (parent) {
      if (parent.account_id !== f.account_id) throw httpError(400, "That folder belongs to another account.");
      if (within(parent.path, f.path, delim)) throw httpError(400, "A folder cannot be moved into itself.");
      if (!mayCreateIn(parent)) throw httpError(403, "You may not create folders inside that one.");
    }
    if (moving && !parent && !personal(f)) throw httpError(400, "Only your own folders can be moved to the top.");
    if (parent && personal(parent) !== personal(f)) throw httpError(400, "A folder cannot be moved between your own folders and shared ones.");
    const cfg = await loadAccount(f.account_id, req.owner);
    const to = await withAccountLock(f.account_id, async () => {
      // read again under the lock: another change may have moved it (or its parent) meanwhile
      const now = await loadFolder(req.params.id, req.owner);
      if (now.path !== f.path || (parent && (await loadFolder(parent.id, req.owner)).path !== parent.path)) throw httpError(409, "The folder changed meanwhile. Try again.");
      await assertNoSpecialInside(f, "rename");
      return withImap(cfg.imap, async (client) => {
      const ns = (client as any).namespace as { prefix?: string } | undefined;
      const base = !moving ? parentOf(f.path, delim) : parent ? parent.path : null;
      const to = base == null ? `${moving ? ns?.prefix ?? "" : ""}${name}` : `${base}${parent?.delimiter || delim}${name}`;
      if (to === f.path) return to;
      // a change of case only is the same folder to case-insensitive servers; anything else must be free
      if (to.toLowerCase() !== f.path.toLowerCase()) {
        const { rows: [dup] } = await pool.query("select 1 from folders where account_id = $1 and lower(path) = lower($2)", [f.account_id, to]);
        if (dup) throw httpError(409, "A folder with that name already exists there.");
      }
      await renameFolder(client, f, to);
      return to;
      });
    });
    if (to === f.path) return { id: f.id, path: f.path, filtersUpdated: 0, filtersNotUpdated: 0 };
    publish({ type: "sync", accountId: f.account_id });
    const filters = personal(f) ? await atMost(renameInFilters(f.account_id, req.owner, f.path, to, delim), FILTER_WAIT_MS, { updated: 0, skipped: 0 }) : { updated: 0, skipped: 0 };
    return { id: f.id, path: to, filtersUpdated: filters.updated, filtersNotUpdated: filters.skipped };
  });

  // Delete a folder with its subfolders. Your own folders go to Trash first (as a subfolder there, like messages do);
  // `permanent=1`, a folder that is already in Trash, or an account without Trash deletes for good.
  app.delete<{ Params: { id: string }; Querystring: { permanent?: string } }>("/api/folders/:id", async (req) => {
    const f = await loadFolder(req.params.id, req.owner);
    assertManageable(f, "delete");
    const delim = f.delimiter ?? "";
    const { rows: [trash] } = await pool.query(
      "select id, path, delimiter from folders where account_id = $1 and special_use = '\\Trash' and coalesce(namespace, 'personal') = 'personal' and selectable limit 1", [f.account_id]);
    const inTrash = !!trash && within(f.path, trash.path, trash.delimiter ?? delim);
    const toTrash = req.query.permanent !== "1" && personal(f) && !!trash && !inTrash;
    if (!toTrash && req.query.permanent !== "1") throw httpError(400, "This folder can only be deleted permanently.");
    const cfg = await loadAccount(f.account_id, req.owner);
    let path: string | null = null;
    await withAccountLock(f.account_id, async () => {
      const now = await loadFolder(req.params.id, req.owner);
      if (now.path !== f.path) throw httpError(409, "The folder changed meanwhile. Try again.");
      await assertNoSpecialInside(f, "delete");
      return withImap(cfg.imap, async (client) => {
      if (toTrash) {
        const td = trash.delimiter || delim || "/";
        const { rows } = await pool.query("select lower(path) as p from folders where account_id = $1", [f.account_id]);
        const taken = new Set<string>(rows.map((r) => r.p));
        const name = freeName(f.name, taken, (n) => `${trash.path}${td}${n}`.toLowerCase());
        path = `${trash.path}${td}${name}`;
        await renameFolder(client, f, path);
      } else await deleteFolderTree(client, f);
      });
    });
    publish({ type: "sync", accountId: f.account_id });
    // filters still filing into the old place would create it again; say so, so they can be changed
    const filtersStillUsing = personal(f) ? await atMost(filtersUsing(f.account_id, req.owner, f.path, delim), FILTER_WAIT_MS, 0) : 0;
    return { movedToTrash: toTrash, path, filtersStillUsing };
  });
}
