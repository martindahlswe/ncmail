import { randomBytes } from "node:crypto";

/**
 * Read receipts (Message Disposition Notifications, RFC 8098): reading the request, deciding whether to offer an answer,
 * and building the answer. Nothing is ever sent without the person choosing to.
 */

export interface ReceiptRequest {
  /** Where the receipt should go (the first address in Disposition-Notification-To). */
  to: string;
  /** The envelope sender the receiving server recorded (Return-Path), "" for a null sender, null when there is none. */
  returnPath: string | null;
}

/** The keyword that marks a message whose request was answered (sent or declined), so it is not asked again. */
export const MDN_SENT = "$MDNSent";

const ADDRESS = /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+\.[^\s@<>()",;:\\]+$/;
const unfold = (l: string) => l.slice(l.indexOf(":") + 1).replace(/\r?\n[ \t]+/g, " ").trim();

/** The first address in a header value: inside <...>, else the first bare one. */
function firstAddress(value: string): string | null {
  const plain = value.replace(/\([^()]*\)/g, " "); // comments
  const a = plain.match(/<\s*([^<>\s]+)\s*>/)?.[1] ?? plain.split(/[\s,;]+/).find((t) => t.includes("@"));
  // printable ASCII only: the address goes into a To header and the SMTP envelope
  return a && a.length <= 320 && ADDRESS.test(a) && /^[\x21-\x7e]+$/.test(a) ? a : null;
}

/** From the raw header lines; null when the message does not ask for a receipt. */
export function parseReceiptRequest(lines: { key: string; line: string }[] | undefined): ReceiptRequest | null {
  const line = (key: string) => (lines ?? []).find((h) => h.key === key)?.line;
  const dnt = line("disposition-notification-to");
  const to = dnt ? firstAddress(unfold(dnt)) : null;
  if (!to) return null;
  // only a Return-Path at the very top counts: that one is added at final delivery. One further down may be the sender's own.
  const rp = lines?.[0]?.key === "return-path" ? lines[0].line : undefined;
  const returnPath = rp === undefined ? null : /<\s*>/.test(rp) ? "" : firstAddress(unfold(rp)) ?? "";
  return { to, returnPath };
}

const domainOf = (a: string) => a.split("@").pop()!.toLowerCase();

/**
 * Where a receipt may be sent for this message, or null when nothing should be offered: no request, already answered,
 * mail in Junk / Sent / Drafts, your own mail, or a receipt address in another domain than the envelope sender's
 * (otherwise anyone could have receipts sent to an address of their choosing).
 */
export function receiptOffer(r: ReceiptRequest | null | undefined, o: { flags: string[]; folderSpecial: string | null; fromMine: boolean }): string | null {
  if (!r?.to || !r.returnPath) return null;
  if (o.flags.includes(MDN_SENT) || o.fromMine) return null;
  if (o.folderSpecial === "\\Junk" || o.folderSpecial === "\\Sent" || o.folderSpecial === "\\Drafts") return null;
  return domainOf(r.to) === domainOf(r.returnPath) ? r.to : null;
}

/** An RFC 2047 encoded word for header text that is not plain ASCII, in pieces short enough for a header line. */
export function encodeHeaderText(s: string): string {
  if (!/[^\x20-\x7e]/.test(s)) return s;
  const words: string[] = [];
  let chunk = "";
  for (const ch of s) { // whole characters only, so no piece splits a UTF-8 sequence
    if (Buffer.byteLength(chunk + ch) > 45) { words.push(chunk); chunk = ""; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString("base64")}?=`).join("\r\n ");
}

const fmtAddress = (name: string, email: string) => {
  if (!name) return email;
  const n = /[^\x20-\x7e]/.test(name) ? encodeHeaderText(name) : `"${name.replace(/["\\]/g, "\\$&")}"`;
  return `${n} <${email}>`;
};
const b64 = (s: string) => Buffer.from(s).toString("base64").replace(/.{76}/g, "$&\r\n");
/** Field values must stay on one line and in ASCII. */
const field = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/[^\x20-\x7e]/g, "?");

export interface MdnInput {
  from: { name: string; email: string };
  to: string;
  subject: string;
  originalMessageId: string | null;
  originalDate: Date;
  date?: Date;
  /** Who reports it: the product name after the host part (Reporting-UA). */
  product?: string;
}

/**
 * A read receipt sent by hand (multipart/report; report-type=disposition-notification): a short note for people and the
 * machine-readable part (Reporting-UA, Final-Recipient, Original-Message-ID, Disposition: manual-action/MDN-sent-manually; displayed).
 */
export function buildMdn(o: MdnInput): Buffer {
  const domain = domainOf(o.from.email);
  const boundary = `----=_mdn_${randomBytes(12).toString("hex")}`;
  const date = (o.date ?? new Date()).toUTCString().replace(/GMT$/, "+0000");
  const subject = o.subject.trim() || "(no subject)";
  const human = [
    `This is a read receipt for the message you sent to ${o.from.email} on ${o.originalDate.toUTCString()} with the subject "${subject}".`,
    "",
    "It means the message was shown on the recipient's screen. It does not mean it was read or understood.",
    "",
  ].join("\r\n");
  const report = [
    `Reporting-UA: ${domain}; ${o.product ?? "NCMail"}`,
    `Final-Recipient: rfc822; ${field(o.from.email)}`,
    ...(o.originalMessageId ? [`Original-Message-ID: ${field(o.originalMessageId)}`] : []),
    "Disposition: manual-action/MDN-sent-manually; displayed",
    "",
  ].join("\r\n");
  const head = [
    `From: ${fmtAddress(o.from.name, o.from.email)}`,
    `To: ${o.to}`,
    `Subject: ${encodeHeaderText(`Read: ${subject.replace(/[\r\n]+/g, " ")}`)}`,
    `Date: ${date}`,
    `Message-ID: <${randomBytes(16).toString("hex")}@${domain}>`,
    ...(o.originalMessageId ? [`In-Reply-To: ${field(o.originalMessageId)}`, `References: ${field(o.originalMessageId)}`] : []),
    "MIME-Version: 1.0",
    `Content-Type: multipart/report; report-type=disposition-notification; boundary="${boundary}"`,
  ];
  return Buffer.from([
    ...head, "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64", "",
    b64(human),
    `--${boundary}`,
    "Content-Type: message/disposition-notification",
    "Content-Transfer-Encoding: 7bit", "",
    report,
    `--${boundary}--`, "",
  ].join("\r\n"));
}
