import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool } from "./db.ts";
import { loadAccount } from "./accounts.ts";
import { downloadRaw, withImap } from "./mail.ts";
import { resolveIdentity } from "./identities.ts";
import { buildRaw } from "./send.ts";
import { MAX_HTML } from "./inlineImages.ts";
import { loadMessage } from "./routes.ts";
import { parseSource } from "./content.ts";
import { syncFolder } from "./sync.ts";
import { ownerOf } from "./auth.ts";
import { attachmentInput, MAX_ATTACHMENTS, publicUpload, stageBuffer } from "./uploads.ts";
import { encryptDraft, openDraft } from "./secure/protect.ts";

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

async function draftsFolder(accountId: string) {
  const { rows: [f] } = await pool.query("select id, path from folders where account_id = $1 and special_use = '\\Drafts'", [accountId]);
  if (!f) throw httpError(400, "This account has no Drafts folder on the server");
  return f as { id: string; path: string };
}

export async function deleteDraft(accountId: string, uid: number) {
  const f = await draftsFolder(accountId);
  const cfg = await loadAccount(accountId);
  await withImap(cfg.imap, async (c) => {
    const lock = await c.getMailboxLock(f.path);
    try { await c.messageDelete(String(uid), { uid: true }); } finally { lock.release(); }
  });
  await pool.query("delete from messages where folder_id = $1 and uid = $2", [f.id, uid]);
  syncFolder(f.id).catch(() => {});
}

const draftSchema = z.object({
  identityId: z.string().uuid().optional(),
  to: z.array(z.string()).default([]), cc: z.array(z.string()).default([]), bcc: z.array(z.string()).default([]),
  subject: z.string().default(""), text: z.string().default(""), html: z.string().max(MAX_HTML).optional(),
  inReplyTo: z.string().optional(), references: z.array(z.string()).default([]),
  attachments: z.array(attachmentInput).max(MAX_ATTACHMENTS).default([]),
  replacesUid: z.number().int().optional(),
  readReceipt: z.boolean().optional(),
  /** The composer's choice: a draft of a message to be encrypted is stored encrypted to your own key, when you have one. */
  security: z.object({ encrypt: z.boolean(), protocol: z.enum(["pgp", "smime"]) }).passthrough().optional(),
});

const isInlinePicture = (a: { cid?: string; related?: boolean; contentType: string }) => !!a.cid && !!a.related && a.contentType.startsWith("image/");

const flat = (v: any) =>
  (Array.isArray(v) ? v : v ? [v] : []).flatMap((x: any) => x.value ?? [])
    .map((a: any) => (a.name ? `${a.name} <${a.address}>` : a.address));

export async function draftRoutes(app: FastifyInstance) {
  // Save a draft to the server's Drafts folder. Replacing = append the new version, then remove the old one.
  app.post<{ Params: { id: string } }>("/api/accounts/:id/drafts", async (req) => {
    const input = draftSchema.parse(req.body);
    const cfg = await loadAccount(req.params.id, req.owner);
    const from = await resolveIdentity(cfg.id, input.identityId);
    const folder = await draftsFolder(cfg.id);
    const messageId = `<${randomUUID()}@${from.email.split("@")[1] ?? "ncmail.local"}>`;
    const { security, ...mail } = input;
    let raw = await buildRaw(cfg, from, mail, { keepBcc: true, messageId });
    let encrypted = false;
    if (security?.encrypt) {
      const sealed = await encryptDraft(req.owner, raw, from.email, security.protocol);
      if (sealed) { raw = sealed; encrypted = true; }
    }

    const uid = await withImap(cfg.imap, async (c) => {
      const res: any = await c.append(folder.path, raw, ["\\Draft", "\\Seen"]);
      const lock = await c.getMailboxLock(folder.path);
      try {
        let newUid: number | null = res?.uid ?? null;
        if (!newUid) { // server without UIDPLUS: find it by our Message-ID
          const found = (await c.search({ header: { "message-id": messageId } }, { uid: true })) || [];
          newUid = found[found.length - 1] ?? null;
        }
        if (input.replacesUid) await c.messageDelete(String(input.replacesUid), { uid: true });
        return newUid;
      } finally { lock.release(); }
    });
    if (input.replacesUid) await pool.query("delete from messages where folder_id = $1 and uid = $2", [folder.id, input.replacesUid]);
    syncFolder(folder.id).catch(() => {});
    return { uid, encrypted };
  });

  app.delete<{ Params: { id: string; uid: string } }>("/api/accounts/:id/drafts/:uid", async (req, reply) => {
    await deleteDraft(req.params.id, Number(req.params.uid));
    reply.code(204);
  });

  // Load a draft from the Drafts folder back into composer shape (incl. attachments and Bcc).
  app.get<{ Params: { id: string } }>("/api/messages/:id/draft", async (req) => {
    const m = await loadMessage(req.params.id, req.owner);
    if (m.folder_special !== "\\Drafts") throw httpError(400, "Not a draft");
    const cfg = await loadAccount(m.account_id);
    const source = await withImap(cfg.imap, async (c) => {
      const lock = await c.getMailboxLock(m.folder_path);
      try {
        return await downloadRaw(c, m.uid);
      } finally { lock.release(); }
    });
    const owner = await ownerOf(m.account_id);
    const opened = await openDraft(owner, source);
    const { parsed: p } = await parseSource(opened.raw);
    // the exact address, so me@example.com never matches a draft from home@example.com
    const fromAddr = String((p.from as any)?.value?.[0]?.address ?? "").toLowerCase();
    const { rows: ids } = await pool.query("select id, email from identities where account_id = $1", [m.account_id]);
    const identity = ids.find((i) => i.email.toLowerCase() === fromAddr);
    return {
      uid: Number(m.uid), accountId: m.account_id, identityId: identity?.id ?? null,
      to: flat(p.to).join(", "), cc: flat(p.cc).join(", "), bcc: flat(p.bcc).join(", "),
      subject: p.subject ?? "", text: p.text ?? "", html: typeof p.html === "string" ? p.html : null,
      inReplyTo: p.inReplyTo ?? null,
      references: Array.isArray(p.references) ? p.references : p.references ? [p.references] : [],
      // staged on the server, so reopening a draft never ships big files through the browser
      // pictures in the text come back inside the html (mailparser turns cid: into data: URLs), so they are not attachments
      attachments: p.attachments.filter((a) => !isInlinePicture(a)).map((a) => publicUpload(stageBuffer(owner, a.filename ?? "attachment", a.contentType, a.content))),
      readReceipt: !!p.headers.get("disposition-notification-to"),
      // reopened with encryption on again, so the next save is encrypted too
      security: opened.encrypted ? { sign: false, encrypt: true, protocol: opened.encrypted } : null,
    };
  });
}
