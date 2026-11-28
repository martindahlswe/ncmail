import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "./db.ts";
import { READABLE_SQL } from "./acl.ts";
import { loadAccount } from "./accounts.ts";
import { downloadRaw, withImap } from "./mail.ts";
import { defaultSyncMonths, isQueued, isSyncing, loadOlder, syncAccount, syncFolder, syncStatus, withFolderFlags } from "./sync.ts";
import { parseSource, sanitizeEmailHtml } from "./content.ts";
import { prepareMail, deliverPrepared } from "./send.ts";
import { MAX_HTML } from "./inlineImages.ts";
import { queueOutbox } from "./outbox.ts";
import { attachmentInput, MAX_ATTACHMENTS } from "./uploads.ts";
import { storeBody } from "./bodies.ts";
import { resolveIdentity } from "./identities.ts";
import { deleteDraft } from "./drafts.ts";
import { inspectSecure } from "./secure/protect.ts";
import { parseSmime } from "./secure/smime.ts";
import { saveKey } from "./secure/store.ts";
import { putFile } from "./nextcloud/files.ts";
import { requireNcLink } from "./nextcloud/link.ts";
import { addrOf, type SecurityInfo } from "./secure/types.ts";
import { labelsOf } from "./labels.ts";
import { authWarnings, senderAuthenticated, senderWarnings } from "./phishing.ts";
import { unsubscribeOffer } from "./listunsub.ts";
import { receiptFor } from "./receipts.ts";
import { imagesTrustable } from "./imagesenders.ts";

const ORDER = ["\\Inbox", "\\Drafts", "\\Sent", "\\Archive", "\\Junk", "\\Trash"];

/** A message of one of `owner`'s accounts; another user's message is "not found". */
export async function loadMessage(id: string, owner: string) {
  const { rows } = await pool.query(
    `select m.*, f.path as folder_path, f.account_id, f.special_use as folder_special
     from messages m join folders f on f.id = m.folder_id join accounts a on a.id = f.account_id where m.id = $1 and a.owner = $2 and ${READABLE_SQL}`, [id, owner]);
  if (!rows[0]) throw Object.assign(new Error("Message not found"), { statusCode: 404 });
  return rows[0];
}

export const listItem = (r: any) => ({
  labels: labelsOf(r.flags),
  id: r.id, uid: r.uid, subject: r.subject, fromName: r.from_name, fromAddr: r.from_addr,
  date: r.date.toISOString(), seen: r.flags.includes("\\Seen"), flagged: r.flags.includes("\\Flagged"),
  answered: r.flags.includes("\\Answered"), hasAttachments: r.has_attachments, size: r.size,
});

export async function mailRoutes(app: FastifyInstance) {
  // ---- sync triggers ----
  app.post<{ Params: { id: string } }>("/api/accounts/:id/sync", async (req, reply) => {
    syncAccount(req.params.id).catch((e) => app.log.error(e, "account sync failed"));
    reply.code(202);
    return { started: true };
  });

  // How far back the first sync goes (months; null = the server default, 0 = everything), and what is still on the server.
  app.get<{ Params: { id: string } }>("/api/accounts/:id/sync-window", async (req) => {
    const { rows: [a] } = await pool.query("select sync_months from accounts where id = $1", [req.params.id]);
    const { rows: [o] } = await pool.query("select coalesce(sum(unsynced_older), 0)::int as n from folders where account_id = $1", [req.params.id]);
    return { months: a?.sync_months ?? null, default: defaultSyncMonths(), olderOnServer: o.n };
  });
  app.put<{ Params: { id: string } }>("/api/accounts/:id/sync-window", async (req) => {
    const b = z.object({ months: z.number().int().min(0).max(600).nullable(), loadNow: z.boolean().optional() }).parse(req.body);
    await pool.query("update accounts set sync_months = $2 where id = $1", [req.params.id, b.months]);
    let started = 0;
    if (b.loadNow) { // bring in everything that is still on the server, one folder after another in the background
      const { rows } = await pool.query("select id from folders where account_id = $1 and window_start is not null", [req.params.id]);
      started = rows.length;
      void (async () => { for (const r of rows) await loadOlder(String(r.id), "all").catch(() => {}); })();
    }
    return { ok: true, started };
  });
  app.get("/api/sync/status", async () => syncStatus());

  // Bring in older mail that the first sync left on the server.
  app.post<{ Params: { id: string }; Body: { count?: number | "all" } }>("/api/folders/:id/sync-older", async (req) => {
    const n = (req.body as any)?.count;
    const added = await loadOlder(req.params.id, n === "all" ? "all" : Math.min(Math.max(Number(n) || 5000, 100), 50000));
    return { added };
  });

  app.post<{ Params: { id: string } }>("/api/folders/:id/sync", async (req, reply) => {
    syncFolder(req.params.id).catch((e) => app.log.error(e, "folder sync failed"));
    reply.code(202);
    return { started: true };
  });

  // ---- folders ----
  const folderOut = (r: any) => ({
    id: r.id, accountId: r.account_id, path: r.path, delimiter: r.delimiter, name: r.name, specialUse: r.special_use,
    selectable: r.selectable, total: r.total, unseen: r.unseen, lastSyncedAt: r.last_synced_at,
    syncError: r.sync_error, syncing: isSyncing(`f:${r.id}`) || isSyncing(`a:${r.account_id}`) || isSyncing(`o:${r.id}`),
    queued: isQueued(String(r.id)), olderOnServer: r.unsynced_older ?? 0,
    namespace: r.namespace ?? "personal", sharedOwner: r.shared_owner ?? null, rights: r.rights ?? null,
  });

  app.get<{ Params: { id: string } }>("/api/accounts/:id/folders", async (req) => {
    // someone else's folder the server lists but will not open, and that holds nothing mirrored, is left out (see sync.ts)
    const { rows } = await pool.query(
      `select * from folders f where account_id = $1
         and not (f.unavailable_at is not null and f.namespace <> 'personal' and not exists (select 1 from messages m where m.folder_id = f.id))`,
      [req.params.id]);
    const rank = (r: any) => { const i = ORDER.indexOf(r.special_use); return i < 0 ? 99 : i; };
    return rows.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path)).map(folderOut);
  });

  app.get<{ Params: { id: string } }>("/api/folders/:id", async (req, reply) => {
    const { rows } = await pool.query("select f.* from folders f join accounts a on a.id = f.account_id where f.id = $1 and a.owner = $2", [req.params.id, req.owner]);
    if (!rows[0]) return reply.code(404).send({ error: "Folder not found" });
    return folderOut(rows[0]);
  });

  // ---- message list: keyset pagination in any of several orders; threads=1 collapses conversations to one row ----
  const hiddenFolders = "(f.special_use is null or f.special_use not in ('\\Trash','\\Junk') or f.id = $3)";
  const unseenOf = (alias: string) => `not ('\\Seen' = any(${alias}.flags))`;
  const SORTS: Record<string, { key: string; dir: "asc" | "desc"; type: string }> = {
    date_desc: { key: "m.date", dir: "desc", type: "timestamptz" },
    date_asc: { key: "m.date", dir: "asc", type: "timestamptz" },
    from: { key: "lower(coalesce(nullif(m.from_name, ''), m.from_addr))", dir: "asc", type: "text" },
    subject: { key: "lower(m.subject)", dir: "asc", type: "text" },
    size: { key: "m.size", dir: "desc", type: "int" },
  };
  const filterSql = (filter: string, alias: string) =>
    filter === "unread" ? unseenOf(alias) : filter === "starred" ? `'\\Flagged' = any(${alias}.flags)` : filter === "attachments" ? `${alias}.has_attachments` : "";

  app.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string; beforeDate?: string; beforeId?: string; unread?: string; filter?: string; sort?: string; threads?: string } }>(
    "/api/folders/:id/messages", async (req) => {
      const q = req.query;
      const limit = Math.min(Number(q.limit ?? 50), 300);
      const sortName = q.sort && SORTS[q.sort] ? q.sort : "date_desc";
      const sort = SORTS[sortName]!;
      const filter = q.filter ?? (q.unread === "1" ? "unread" : "all");
      const threaded = q.threads === "1" && sortName.startsWith("date"); // other orders list individual messages
      const args: any[] = [req.params.id];
      let where = `m.folder_id = $1 and exists (select 1 from folders f where f.id = $1 and ${READABLE_SQL})`;

      let cur: { v: unknown; id: string } | null = null;
      if (q.cursor) { try { cur = JSON.parse(q.cursor); } catch { /* ignore a bad cursor: start from the top */ } }
      else if (q.beforeDate && q.beforeId) cur = { v: q.beforeDate, id: q.beforeId };
      if (cur && (!/^\d{1,18}$/.test(String(cur.id)) || !["string", "number"].includes(typeof cur.v) || String(cur.v).length > 200)) throw Object.assign(new Error("Invalid cursor"), { statusCode: 400 });
      if (cur) {
        args.push(cur.v, cur.id);
        where += ` and (${sort.key}, m.id) ${sort.dir === "desc" ? "<" : ">"} ($${args.length - 1}::${sort.type}, $${args.length}::bigint)`;
      }
      const cond = filterSql(filter, "m");
      if (threaded) {
        // Show only the newest message of each conversation in this folder.
        where += " and not exists (select 1 from messages n where n.folder_id = m.folder_id and n.thread_id = m.thread_id and (n.date, n.id) > (m.date, m.id))";
        if (cond) where += ` and (${cond} or exists (select 1 from messages u where u.folder_id = m.folder_id and u.thread_id = m.thread_id and ${filterSql(filter, "u")}))`;
      } else if (cond) where += ` and ${cond}`;

      args.push(limit + 1);
      const dir = sort.dir;
      const { rows } = await pool.query(
        `select m.*, ${sort.key} as sk from messages m where ${where} order by ${sort.key} ${dir}, m.id ${dir} limit $${args.length}`, args);
      const page = rows.slice(0, limit);
      let items: any[] = page.map(listItem);

      if (threaded && page.length) {
        // Conversation stats across the account (minus Trash/Junk unless we are looking at them).
        const threadIds = [...new Set(page.map((r) => r.thread_id).filter((t) => t != null))];
        const { rows: stats } = await pool.query(
          `select m.thread_id, count(*)::int as cnt,
                  count(*) filter (where ${unseenOf("m")})::int as unseen,
                  bool_or('\\Flagged' = any(m.flags)) as flagged, bool_or(m.has_attachments) as att,
                  array_agg(distinct coalesce(nullif(m.from_name, ''), m.from_addr)) as names
           from messages m join folders f on f.id = m.folder_id
           where f.account_id = (select account_id from folders where id = $1) and m.thread_id = any($2::bigint[]) and ${hiddenFolders}
           group by m.thread_id`, [req.params.id, threadIds, req.params.id]);
        const byThread = new Map(stats.map((st) => [String(st.thread_id), st]));
        items = page.map((r) => {
          const st = r.thread_id != null ? byThread.get(String(r.thread_id)) : undefined;
          const base = listItem(r);
          if (!st) return { ...base, threadId: null, count: 1, unseenCount: base.seen ? 0 : 1, names: [base.fromName || base.fromAddr] };
          return { ...base, threadId: String(r.thread_id), count: st.cnt, unseenCount: st.unseen, seen: st.unseen === 0,
            flagged: st.flagged, hasAttachments: st.att, names: st.names };
        });
      }
      const last = rows[limit - 1];
      const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
      return { items, next: rows.length > limit ? { v: iso(last.sk), id: String(last.id), date: last.date.toISOString() } : null };
    });

  // ---- one conversation, oldest first (account-wide, so your own replies in Sent are part of it) ----
  app.get<{ Params: { threadId: string }; Querystring: { folderId: string } }>("/api/threads/:threadId", async (req) => {
    const { rows } = await pool.query(
      `select m.*, f.id as fid, f.name as fname from messages m join folders f on f.id = m.folder_id
       where m.thread_id = $1 and f.account_id = (select account_id from folders where id = $2) and ${hiddenFolders}
       order by m.date asc, m.id asc`, [req.params.threadId, req.query.folderId, req.query.folderId]);
    return rows.map((r) => ({ ...listItem(r), folderId: String(r.fid), folderName: r.fname }));
  });

  // ---- read one message ----
  /** The raw source of a message, straight from the mail server. */
  const fetchRaw = async (m: any): Promise<Buffer> => {
    const cfg = await loadAccount(m.account_id);
    return withImap(cfg.imap, async (c) => {
      const lock = await c.getMailboxLock(m.folder_path);
      try {
        return await downloadRaw(c, m.uid);
      } finally { lock.release(); }
    });
  };

  app.get<{ Params: { id: string } }>("/api/messages/:id", async (req) => {
    const m = await loadMessage(req.params.id, req.owner);
    let { rows: [body] } = await pool.query("select * from message_bodies where message_id = $1", [m.id]);
    let security: SecurityInfo | undefined;
    let raw: Buffer | undefined;
    if (!body) {
      raw = await fetchRaw(m);
      const { cache } = await parseSource(raw);
      if (!(cache.headers as any).secure) await storeBody(String(m.id), cache);
      body = { html: cache.html, text: cache.text, attachments: cache.attachments, headers: cache.headers };
    }
    if (body.headers?.secure) {
      // Signed or encrypted: never cached (what you see is the decrypted text, which must not be kept in the database)
      raw ??= await fetchRaw(m);
      const r = await inspectSecure(req.owner, raw);
      security = r.security;
      const { cache } = await parseSource(r.inner);
      body = { html: cache.html, text: cache.text, attachments: cache.attachments, headers: { ...body.headers, ...cache.headers, secure: body.headers.secure,
        // the outer message's headers say who it came through (Return-Path) and which list
        // ...and the list's posting address only comes from the inner part when the sender's signature vouches for it
        listPost: (r.security?.encryption?.status === "decrypted" && r.security.encryption.authenticated === false ? undefined : cache.headers.listPost) ?? body.headers.listPost,
        receipt: body.headers.receipt } };
    }
    // S/MIME encryption alone does not protect integrity: without the sender's valid signature, no remote content is loaded
    const unverified = security?.encryption?.status === "decrypted" && security.encryption.authenticated === false;
    const safe = body.html ? sanitizeEmailHtml(body.html, { allowRemote: !unverified }) : null;
    const auth = body.headers?.auth ?? null;
    const fromDomain = String(m.from_addr ?? "").split("@")[1]?.toLowerCase() ?? "";
    const failedChecks = auth ? authWarnings(auth, fromDomain) : [];
    const warnings = [...failedChecks, ...(await senderWarnings(req.owner, m.account_id, m.from_name ?? "", m.from_addr ?? "").catch(() => []))];
    return {
      ...listItem(m),
      auth, warnings,
      folderId: m.folder_id, accountId: m.account_id,
      to: m.to_addrs, cc: m.cc_addrs,
      messageId: m.message_id, references: body.headers?.references ?? m.refs, replyTo: body.headers?.replyTo ?? [], deliveredTo: body.headers?.deliveredTo ?? [],
      unsubscribe: unsubscribeOffer(body.headers?.unsubscribe, auth, m.folder_special, m.from_addr ?? ""),
      listPost: body.headers?.listPost ?? null,
      // a request for a read receipt that may be answered (the reader asks first, unless that is switched off)
      receiptTo: await receiptFor(m, body.headers),
      // whether "always show images from this sender" may apply to this message
      imagesTrustable: imagesTrustable({ folderSpecial: m.folder_special, authWarnings: failedChecks.length, unverified, authenticated: senderAuthenticated(auth, fromDomain) }),
      html: safe?.html ?? null, hasRemoteImages: !unverified && (safe?.hasRemoteImages ?? false), remoteBlocked: unverified && (safe?.hasRemoteImages ?? false),
      text: body.text, attachments: (body.attachments as any[]).filter((a) => !a.inline),
      // the signer's certificate itself stays on the server; the client only needs to know it can be kept
      hasInvite: (body.attachments as any[]).some((a) => /calendar|ics/i.test(a.contentType) || /\.ics$/i.test(a.filename ?? "")),
      security: security ? { ...security, signature: security.signature ? { ...security.signature, signerData: undefined, canSave: !!security.signature.signerData } : undefined } : null,
    };
  });

  // Keep the signer's certificate from a signed message (S/MIME certificates travel inside the signature).
  app.post<{ Params: { id: string } }>("/api/messages/:id/security/save-key", async (req) => {
    const m = await loadMessage(req.params.id, req.owner);
    const bad = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
    const { security } = await inspectSecure(req.owner, await fetchRaw(m));
    const sig = security.signature;
    if (!sig?.signerData || sig.protocol !== "smime") throw bad("This message carries no certificate to keep");
    // the verdict is worked out again here: only a correct signature that nothing vouches for yet can be trusted this way
    if (sig.status !== "untrusted") throw bad("Only a correct signature from a certificate you do not trust yet can be kept here");
    const from = addrOf(m.from_addr ?? "");
    const r = parseSmime([{ name: "signature", data: Buffer.from(sig.signerData) }]);
    const key = r.keys[0];
    if (!key) throw bad(r.errors[0] ?? "Could not read the certificate");
    if (key.fingerprint !== sig.signer?.fingerprint || !from || !key.emails.includes(from)) throw bad("The certificate does not belong to the sender of this message");
    // trust is given for the sender's address only, not for every address the certificate lists
    key.emails = [from]; key.hasPrivate = false; delete key.privateData;
    return { id: (await saveKey(m.account_id, key, { fromMessage: true })).id, emails: key.emails };
  });

  // Raw message: its header block and source, for "View source" and "Download .eml".
  app.get<{ Params: { id: string }; Querystring: { download?: string } }>("/api/messages/:id/source", async (req, reply) => {
    const m = await loadMessage(req.params.id, req.owner);
    const raw = await fetchRaw(m);
    if (req.query.download) {
      const name = (m.subject || "message").replace(/[^\w .-]+/g, "_").slice(0, 60);
      return reply.type("message/rfc822").header("content-disposition", `attachment; filename="${name}.eml"`).header("x-content-type-options", "nosniff").send(raw);
    }
    const text = raw.toString("utf8");
    const at = text.search(/\r?\n\r?\n/);
    const head = at < 0 ? text : text.slice(0, at);
    const headers = head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/).filter(Boolean).map((l) => { const i = l.indexOf(":"); return { name: l.slice(0, i), value: l.slice(i + 1).trim() }; });
    const LIMIT = 2_000_000;
    return { headers, source: text.length > LIMIT ? text.slice(0, LIMIT) : text, truncated: text.length > LIMIT, size: raw.length };
  });

  app.get<{ Params: { id: string; idx: string } }>("/api/messages/:id/attachments/:idx", async (req, reply) => {
    const m = await loadMessage(req.params.id, req.owner);
    let { parsed, cache } = await parseSource(await fetchRaw(m));
    if ((cache.headers as any).secure) ({ parsed } = await parseSource((await inspectSecure(req.owner, await fetchRaw(m))).inner));
    const a = parsed.attachments[Number(req.params.idx)];
    if (!a) return reply.code(404).send({ error: "No such attachment" });
    const name = (a.filename ?? "attachment").replace(/[\r\n"]/g, "_");
    // Preview: only kinds that cannot run script in this page are shown inline (no SVG, HTML ...); everything else downloads.
    const previewable = /^(image\/(png|jpe?g|gif|webp|bmp|avif)|application\/pdf|text\/(plain|csv|markdown)|audio\/(mpeg|mp4|ogg|wav|webm)|video\/(mp4|webm|ogg))$/i.test(a.contentType.split(";")[0]!.trim());
    if ((req.query as any).inline === "1" && previewable) {
      const type = /^text\//i.test(a.contentType) ? "text/plain; charset=utf-8" : a.contentType;
      return reply.type(type).header("content-disposition", `inline; filename="${name}"`).header("x-content-type-options", "nosniff")
        .header("content-security-policy", "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'").send(a.content);
    }
    return reply.type(a.contentType).header("content-disposition", `attachment; filename="${name}"`)
      .header("x-content-type-options", "nosniff").send(a.content);
  });

  // Save an attachment (idx) or all of them (idx "all") into a Nextcloud folder, without replacing existing files.
  app.post<{ Params: { id: string; idx: string } }>("/api/messages/:id/attachments/:idx/save-to-nextcloud", async (req) => {
    const { folder } = z.object({ folder: z.string().default("/") }).parse(req.body);
    const l = await requireNcLink(req.owner);
    const m = await loadMessage(req.params.id, req.owner);
    let { parsed, cache } = await parseSource(await fetchRaw(m));
    if ((cache.headers as any).secure) ({ parsed } = await parseSource((await inspectSecure(req.owner, await fetchRaw(m))).inner));
    const meta = cache.attachments as { idx: number; inline: boolean }[];
    const want = req.params.idx === "all" ? parsed.attachments.map((_, i) => i).filter((i) => !meta[i]?.inline) : [Number(req.params.idx)];
    const saved: string[] = [];
    for (const i of want) {
      const a = parsed.attachments[i];
      if (!a) throw Object.assign(new Error("No such attachment"), { statusCode: 404 });
      saved.push(await putFile(l, folder, a.filename ?? `attachment-${i + 1}`, a.content, a.contentType));
    }
    return { saved };
  });

  // ---- flags / move / delete ----
  const flagsBody = z.object({ seen: z.boolean().optional(), flagged: z.boolean().optional() });
  app.patch<{ Params: { id: string } }>("/api/messages/:id", async (req) => {
    const body = flagsBody.parse(req.body);
    const m = await loadMessage(req.params.id, req.owner);
    const cfg = await loadAccount(m.account_id);
    const add: string[] = [], remove: string[] = [];
    if (body.seen !== undefined) (body.seen ? add : remove).push("\\Seen");
    if (body.flagged !== undefined) (body.flagged ? add : remove).push("\\Flagged");
    await withImap(cfg.imap, async (c) => {
      const lock = await c.getMailboxLock(m.folder_path);
      try {
        await withFolderFlags(m.folder_id, async () => { // see withFolderFlags in sync.ts
          if (add.length) await c.messageFlagsAdd(String(m.uid), add, { uid: true });
          if (remove.length) await c.messageFlagsRemove(String(m.uid), remove, { uid: true });
          // only the flags changed here, on the current mirror row (not the copy read before the server answered)
          for (const f of add) await pool.query("update messages set flags = array_append(array_remove(flags, $2), $2) where id = $1", [m.id, f]);
          for (const f of remove) await pool.query("update messages set flags = array_remove(flags, $2) where id = $1", [m.id, f]);
        });
      } finally { lock.release(); }
    });
    if (body.seen !== undefined && body.seen !== m.flags.includes("\\Seen")) {
      await pool.query("update folders set unseen = greatest(unseen + $2, 0) where id = $1", [m.folder_id, body.seen ? -1 : 1]);
    }
    return { ok: true };
  });

  const moveBody = z.object({ folderId: z.string() });
  async function moveMessage(m: any, destPath: string) {
    const cfg = await loadAccount(m.account_id);
    await withImap(cfg.imap, async (c) => {
      const lock = await c.getMailboxLock(m.folder_path);
      try { await c.messageMove(String(m.uid), destPath, { uid: true }); } finally { lock.release(); }
    });
    await pool.query("delete from messages where id = $1", [m.id]);
    await pool.query("update folders set total = greatest(total - 1, 0), unseen = greatest(unseen - $2, 0) where id = $1",
      [m.folder_id, m.flags.includes("\\Seen") ? 0 : 1]);
  }

  app.post<{ Params: { id: string } }>("/api/messages/:id/move", async (req) => {
    const { folderId } = moveBody.parse(req.body);
    const m = await loadMessage(req.params.id, req.owner);
    const { rows: [dest] } = await pool.query("select path, account_id from folders where id = $1", [folderId]);
    if (!dest || dest.account_id !== m.account_id) throw Object.assign(new Error("Bad destination"), { statusCode: 400 });
    await moveMessage(m, dest.path);
    syncFolder(folderId).catch(() => {});
    return { ok: true };
  });

  // Delete = move to Trash; deleting from Trash (or with no Trash folder) expunges.
  app.delete<{ Params: { id: string } }>("/api/messages/:id", async (req) => {
    const m = await loadMessage(req.params.id, req.owner);
    const { rows: [trash] } = await pool.query(
      "select id, path from folders where account_id = $1 and special_use = '\\Trash'", [m.account_id]);
    if (trash && m.folder_special !== "\\Trash") {
      await moveMessage(m, trash.path);
      syncFolder(trash.id).catch(() => {});
    } else {
      const cfg = await loadAccount(m.account_id);
      await withImap(cfg.imap, async (c) => {
        const lock = await c.getMailboxLock(m.folder_path);
        try { await c.messageDelete(String(m.uid), { uid: true }); } finally { lock.release(); }
      });
      await pool.query("delete from messages where id = $1", [m.id]);
    }
    return { ok: true };
  });

  // ---- send ----
  const addr = z.string().min(3);
  const sendSchema = z.object({
    identityId: z.string().uuid().optional(),
    draftUid: z.number().int().optional(),
    to: z.array(addr).min(1), cc: z.array(addr).default([]), bcc: z.array(addr).default([]),
    subject: z.string().default(""), text: z.string().default(""), html: z.string().max(MAX_HTML).optional(),
    inReplyTo: z.string().optional(), references: z.array(z.string()).default([]),
    attachments: z.array(attachmentInput).max(MAX_ATTACHMENTS).default([]),
    readReceipt: z.boolean().optional(),
    /** Hold the message in the outbox for this many seconds so it can be undone. 0 sends immediately. */
    delaySeconds: z.number().int().min(0).max(60).default(0),
    /** Send later: an exact time (up to a year ahead). Takes the place of delaySeconds. */
    sendAt: z.string().datetime().optional(),
    /** Sign and/or encrypt with a PGP key or S/MIME certificate. */
    security: z.object({ sign: z.boolean(), encrypt: z.boolean(), protocol: z.enum(["pgp", "smime"]) }).optional(),
  });
  app.post<{ Params: { id: string } }>("/api/accounts/:id/send", async (req) => {
    const input = sendSchema.parse(req.body);
    const cfg = await loadAccount(req.params.id, req.owner);
    const from = await resolveIdentity(cfg.id, input.identityId);
    const prepared = await prepareMail(cfg, from, input);
    if (input.sendAt) {
      const at = new Date(input.sendAt);
      if (at.getTime() > Date.now() + 366 * 86400_000) throw Object.assign(new Error("Send later can be at most a year ahead"), { statusCode: 400 });
      const q = await queueOutbox({ accountId: cfg.id, prepared, subject: input.subject, delaySeconds: 0, sendAt: at.getTime() < Date.now() ? new Date() : at, draftUid: input.draftUid });
      return { ok: true, queued: true, outboxId: q.id, sendAt: q.sendAt, scheduled: at.getTime() > Date.now() + 120_000 };
    }
    if (input.delaySeconds > 0) {
      const q = await queueOutbox({ accountId: cfg.id, prepared, subject: input.subject, delaySeconds: input.delaySeconds, draftUid: input.draftUid });
      return { ok: true, queued: true, outboxId: q.id, sendAt: q.sendAt };
    }
    await deliverPrepared(cfg, prepared);
    if (input.draftUid) await deleteDraft(cfg.id, input.draftUid).catch((e) => app.log.warn(e, "could not remove sent draft"));
    return { ok: true };
  });
}
