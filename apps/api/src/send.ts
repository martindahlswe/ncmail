import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { toPlainText } from "./signature.ts";
import type { AccountConfig } from "./accounts.ts";
import { pool } from "./db.ts";
import { smtpTransport, withImap } from "./mail.ts";
import { syncFolder } from "./sync.ts";
import { resolveAttachments, type AttachmentInput } from "./uploads.ts";
import type { Identity } from "@ncmail/shared";
import { ownerOf } from "./auth.ts";
import { extractInlineImages } from "./inlineImages.ts";
import { protectMessage, recipientKeys, type SecurityRequest } from "./secure/protect.ts";

export interface OutgoingMail {
  to: string[]; cc: string[]; bcc: string[];
  subject: string; text: string;
  /** Rich-text body. When present it is sent as multipart/alternative with a generated plain-text part. */
  html?: string;
  inReplyTo?: string; references: string[];
  attachments: AttachmentInput[];
  /** Sign and/or encrypt (PGP/MIME or S/MIME). */
  security?: SecurityRequest;
  /** Ask the recipients' mail programs to confirm when the message is read (Disposition-Notification-To, RFC 8098). */
  readReceipt?: boolean;
}

type Sender =Pick<Identity, "name" | "email"> & Partial<Pick<Identity, "signatureHtml" | "signatureText" | "replyTo">>;

// Providers that file sent mail in Sent automatically; appending ourselves would create duplicates.
const AUTO_SAVES_SENT = /(gmail\.com|googlemail\.com|office365\.com|outlook\.com)$/i;

/** Builds the RFC 5322 message. Drafts keep Bcc; sent mail must not leak it. */
export async function buildRaw(cfg: AccountConfig, from: Sender, m: OutgoingMail, opts: { keepBcc?: boolean; messageId?: string } = {}): Promise<Buffer> {
  const inline = m.html ? extractInlineImages(m.html, from.email.split("@")[1] || undefined) : { html: undefined, images: [] };
  const inlineBytes = inline.images.reduce((n, i) => n + i.content.length, 0);
  // uploads and forwarded messages belong to someone: look up the account's owner only when one is referenced
  const files = await resolveAttachments(m.attachments, m.attachments.some((a) => !("contentBase64" in a)) ? await ownerOf(cfg.id) : "", inlineBytes);
  const mail = new MailComposer({
    from: { name: from.name, address: from.email },
    // only when replies should go somewhere else than the From address
    ...(from.replyTo && from.replyTo.toLowerCase() !== from.email.toLowerCase() ? { replyTo: from.replyTo } : {}),
    to: m.to, cc: m.cc, bcc: m.bcc,
    subject: m.subject,
    ...(inline.html
      ? { html: inline.html, text: toPlainText(m.html!, from) } // the signature is compared as stored, with its pictures as data: URLs
      : { text: m.text }),
    messageId: opts.messageId,
    inReplyTo: m.inReplyTo, references: m.references,
    ...(m.readReceipt ? { headers: { "Disposition-Notification-To": from.email } } : {}),
    attachments: [...files, ...inline.images],
  }).compile();
  mail.keepBcc = !!opts.keepBcc;
  return mail.build();
}

/**
 * A finished message and who it goes to. Everything needed to deliver it later, with nothing left to look up.
 * `copies` are separately encrypted messages, one per Bcc recipient, each sent on its own; only `raw` is filed in Sent.
 */
export interface Prepared { raw: Buffer; envelopeFrom: string; envelopeTo: string[]; copies?: { to: string; raw: Buffer }[] }

export async function prepareMail(cfg: AccountConfig, from: Sender, m: OutgoingMail): Promise<Prepared> {
  const raw = await buildRaw(cfg, from, m);
  const all = [...m.to, ...m.cc, ...m.bcc];
  const sec = m.security;
  if (!sec || (!sec.sign && !sec.encrypt)) return { raw, envelopeFrom: from.email, envelopeTo: all };
  const owner = await ownerOf(cfg.id);
  const protect = (recipients: string[]) => protectMessage(owner, raw, from.email, recipients, sec);
  if (!sec.encrypt || !m.bcc.length) return { raw: await protect(all), envelopeFrom: from.email, envelopeTo: all };
  // Encrypted mail names each recipient's key, so the To/Cc copy is encrypted for To and Cc only (and you), and every
  // Bcc recipient gets a copy encrypted just for them (and you).
  await recipientKeys(owner, all, sec.protocol); // report every missing key at once
  const open = [...m.to, ...m.cc];
  const copies = [];
  for (const b of [...new Set(m.bcc)]) copies.push({ to: b, raw: await protect([b]) });
  return { raw: await protect(open), envelopeFrom: from.email, envelopeTo: open, copies };
}

/**
 * SMTP delivery (each Bcc copy in a transaction of its own), then a copy in Sent (unless the provider files it itself).
 * `signal` stops the SMTP conversation; `onDelivered` runs as soon as the server has accepted everything, before the copy in Sent is saved.
 */
export async function deliverPrepared(cfg: AccountConfig, p: Prepared, opts: { signal?: AbortSignal; onDelivered?: () => Promise<void> } = {}) {
  const smtp = await smtpTransport(cfg.smtp);
  if (p.envelopeTo.length) await smtp.sendMail({ envelope: { from: p.envelopeFrom, to: p.envelopeTo }, raw: p.raw, signal: opts.signal });
  for (const c of p.copies ?? []) await smtp.sendMail({ envelope: { from: p.envelopeFrom, to: [c.to] }, raw: c.raw, signal: opts.signal });
  await opts.onDelivered?.();

  if (AUTO_SAVES_SENT.test(cfg.smtp.host)) return;
  const { rows: [sent] } = await pool.query(
    "select id, path from folders where account_id = $1 and special_use = '\\Sent'", [cfg.id]);
  if (!sent) return;
  await withImap(cfg.imap, (c) => c.append(sent.path, p.raw, ["\\Seen"]));
  syncFolder(sent.id).catch(() => {});
}

export async function sendMail(cfg: AccountConfig, from: Sender, m: OutgoingMail) {
  await deliverPrepared(cfg, await prepareMail(cfg, from, m));
}
