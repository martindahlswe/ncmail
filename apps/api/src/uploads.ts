import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import { z } from "zod";
import { pool } from "./db.ts";
import { READABLE_SQL } from "./acl.ts";
import { loadAccount } from "./accounts.ts";
import { downloadRaw, withImap } from "./mail.ts";

/**
 * Attachments are uploaded once, as they are added (with progress), and referenced by id when a draft is saved or a
 * message is sent. That keeps big files out of JSON bodies, and means autosaving a draft never re-uploads them.
 * Files live in the OS temp folder and are removed after a day.
 */

const DIR = join(process.env.NCMAIL_UPLOAD_DIR || join(tmpdir(), "ncmail-uploads"));
/** What one person may have waiting at the same time. */
const MAX_STAGED_BYTES = Number(process.env.NCMAIL_UPLOAD_QUOTA_MB ?? 500) * 1024 * 1024;
const MAX_BYTES = 100 * 1024 * 1024;
/** All attachments of one message together (never more than one person may have staged). */
const MAX_MESSAGE_BYTES = Math.min(MAX_STAGED_BYTES, MAX_BYTES);
export const MAX_ATTACHMENTS = 100;
const TTL_MS = 24 * 60 * 60 * 1000;

export interface Upload { id: string; owner: string; filename: string; contentType: string; size: number; path: string; created: number }
const uploads = new Map<string, Upload>();

mkdirSync(DIR, { recursive: true, mode: 0o700 });
try { chmodSync(DIR, 0o700); } catch { /* not ours to change */ }

const staged = (owner: string) => { let n = 0; for (const u of uploads.values()) if (u.owner === owner) n += u.size; return n; };
/** Bytes of uploads still streaming in, per person: they count against the quota while they arrive. */
const streaming = new Map<string, number>();
const addStreaming = (owner: string, n: number) => { const v = (streaming.get(owner) ?? 0) + n; if (v > 0) streaming.set(owner, v); else streaming.delete(owner); };
const quota = () => Object.assign(new Error("Too many attachments are waiting. Send or remove some first."), { statusCode: 413 });

/** Forget everything one person has waiting (used when their Nextcloud user is deleted). */
export function dropUploadsOf(owner: string) {
  for (const [id, u] of uploads) if (u.owner === owner) { rmSync(u.path, { force: true }); uploads.delete(id); }
}

export function stageBuffer(owner: string, filename: string, contentType: string, content: Buffer): Upload {
  if (staged(owner) + content.length > MAX_STAGED_BYTES) throw quota();
  const id = randomUUID();
  const path = join(DIR, id);
  writeFileSync(path, content, { mode: 0o600 });
  const u: Upload = { id, owner, filename, contentType: contentType || "application/octet-stream", size: content.length, path, created: Date.now() };
  uploads.set(id, u);
  return u;
}
/** An upload is only visible to the person who made it (a stranger's id looks like a missing one). */
export const getUpload = (id: string, owner: string) => { const u = uploads.get(id); return u && u.owner === owner && existsSync(u.path) ? u : undefined; };
export const publicUpload = (u: Upload) => ({ id: u.id, filename: u.filename, contentType: u.contentType, size: u.size });

/**
 * How a request refers to an attachment: a previously uploaded file, a message of yours attached whole ("forward as
 * attachment", fetched from the mail server when the message is built), or (older clients, tests) inline base64.
 */
export const attachmentInput = z.union([
  z.object({ uploadId: z.string().uuid(), filename: z.string().optional() }),
  z.object({ messageId: z.string().regex(/^\d{1,18}$/), filename: z.string().max(255).optional() }),
  z.object({ filename: z.string(), contentType: z.string().optional(), contentBase64: z.string() }),
]);
export type AttachmentInput = z.infer<typeof attachmentInput>;

const tooBig = () => Object.assign(new Error(`Attachments can be at most ${Math.floor(MAX_MESSAGE_BYTES / 1024 / 1024)} MB per message`), { statusCode: 413 });
/** "Re: Plans / May?" becomes "Re_ Plans _ May_.eml". */
export const emlName = (subject: string) => `${(subject || "message").replace(/[\\/:*?"<>|\r\n\t]+/g, "_").trim().slice(0, 80) || "message"}.eml`;

/** The raw source of one of `owner`'s messages (another person's message is "no longer available", like a missing upload). */
async function rawMessageOf(id: string, owner: string, room: number): Promise<{ raw: Buffer; subject: string }> {
  const { rows: [m] } = await pool.query(
    `select m.uid, m.subject, m.size, f.path, f.account_id from messages m join folders f on f.id = m.folder_id join accounts a on a.id = f.account_id
     where m.id = $1 and a.owner = $2 and ${READABLE_SQL}`, [id, owner]);
  if (!m) throw Object.assign(new Error("A forwarded message is no longer available. Please add it again."), { statusCode: 400 });
  if (Number(m.size) > room) throw tooBig(); // known before fetching it
  const cfg = await loadAccount(m.account_id);
  const raw = await withImap(cfg.imap, async (c) => {
    const lock = await c.getMailboxLock(m.path);
    // the stored size can be missing (0) or stale: the download itself stops once it no longer fits
    try { return await downloadRaw(c, m.uid, room, tooBig); } finally { lock.release(); }
  });
  return { raw, subject: m.subject ?? "" };
}

/**
 * Turn attachment references into what the MIME builder needs (a path to stream from, or a buffer). The same upload or
 * message cannot be referenced twice, and the attachments together must fit MAX_MESSAGE_BYTES, so building a message stays bounded.
 * `extraBytes` counts what else the message carries (pictures in the text) against the same limit.
 */
export async function resolveAttachments(list: AttachmentInput[], owner: string, extraBytes = 0) {
  const seen = new Set<string>();
  let total = extraBytes;
  const out = [];
  for (const a of list) {
    if ("messageId" in a) {
      if (seen.has(`m${a.messageId}`)) throw Object.assign(new Error("The same message was attached twice."), { statusCode: 400 });
      seen.add(`m${a.messageId}`);
      const { raw, subject } = await rawMessageOf(a.messageId, owner, MAX_MESSAGE_BYTES - total);
      total += raw.length;
      if (total > MAX_MESSAGE_BYTES) throw tooBig();
      out.push({ filename: a.filename?.replace(/[\r\n]+/g, " ") || emlName(subject), contentType: "message/rfc822", contentDisposition: "attachment" as const, content: raw });
      continue;
    }
    out.push(resolveOne(a));
  }
  if (total > MAX_MESSAGE_BYTES) throw tooBig();
  return out;

  function resolveOne(a: Exclude<AttachmentInput, { messageId: string }>) {
    if ("uploadId" in a) {
      if (seen.has(a.uploadId)) throw Object.assign(new Error("The same attachment was added twice."), { statusCode: 400 });
      seen.add(a.uploadId);
      const u = getUpload(a.uploadId, owner);
      if (!u) throw Object.assign(new Error("An attachment is no longer available. Please add it again."), { statusCode: 400 });
      total += u.size;
      return { filename: a.filename ?? u.filename, contentType: u.contentType, path: u.path };
    }
    const content = Buffer.from(a.contentBase64, "base64");
    total += content.length;
    return { filename: a.filename, contentType: a.contentType, content };
  }
}

export async function uploadRoutes(app: FastifyInstance) {
  await app.register(multipart, { limits: { fileSize: MAX_BYTES, files: 1 } });

  app.post("/api/uploads", async (req, reply) => {
    if (staged(req.owner) >= MAX_STAGED_BYTES) throw quota();
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "No file" });
    const id = randomUUID();
    const path = join(DIR, id);
    const out = createWriteStream(path, { mode: 0o600 });
    // the file is only removed once the stream has closed, so a late open cannot leave it behind
    const discard = async () => { out.destroy(); await finished(out).catch(() => {}); rmSync(path, { force: true }); };
    let size = 0, over = false;
    try {
      for await (const chunk of file.file as AsyncIterable<Buffer>) {
        if (over) continue; // read the rest so the request completes, but store nothing more
        size += chunk.length;
        addStreaming(req.owner, chunk.length);
        if (staged(req.owner) + (streaming.get(req.owner) ?? 0) > MAX_STAGED_BYTES) { over = true; await discard(); continue; }
        if (!out.write(chunk)) await once(out, "drain");
      }
      if (!over) { out.end(); await finished(out); }
    } catch (e) {
      await discard();
      throw e;
    } finally {
      addStreaming(req.owner, -size);
    }
    if (over) throw quota();
    if (file.file.truncated) { rmSync(path, { force: true }); return reply.code(413).send({ error: `Files can be at most ${MAX_BYTES / 1024 / 1024} MB` }); }
    if (staged(req.owner) + size > MAX_STAGED_BYTES) { rmSync(path, { force: true }); throw quota(); }
    const u: Upload = { id, owner: req.owner, filename: file.filename || "attachment", contentType: file.mimetype || "application/octet-stream", size, path, created: Date.now() };
    uploads.set(id, u);
    reply.code(201);
    return publicUpload(u);
  });

  app.get<{ Params: { id: string } }>("/api/uploads/:id", async (req, reply) => {
    const u = getUpload(req.params.id, req.owner);
    if (!u) return reply.code(404).send({ error: "Not found" });
    return reply.type(u.contentType).header("content-disposition", `attachment; filename="${u.filename.replace(/[\r\n"]/g, "_")}"`).header("x-content-type-options", "nosniff").send(createReadStream(u.path));
  });

  app.delete<{ Params: { id: string } }>("/api/uploads/:id", async (req, reply) => {
    const u = uploads.get(req.params.id);
    if (u && u.owner === req.owner) { rmSync(u.path, { force: true }); uploads.delete(u.id); }
    reply.code(204);
  });

  setInterval(() => { // forget old files; also sweeps files left by a previous run
    const now = Date.now();
    for (const [id, u] of uploads) if (now - u.created > TTL_MS) { rmSync(u.path, { force: true }); uploads.delete(id); }
    try { for (const f of readdirSync(DIR)) if (!uploads.has(f) && now - statSync(join(DIR, f)).mtimeMs > TTL_MS) rmSync(join(DIR, f), { force: true }); } catch { /* ignore */ }
  }, 60 * 60 * 1000).unref();
}
