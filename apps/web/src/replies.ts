import type { AccountSummary } from "@ncmail/shared";
import { escapeHtml, messageAttachment, textToHtml, type MessageFull, type MessageItem } from "./api.ts";
import type { ComposeInit } from "./Compose.tsx";

/** What the composer starts with when replying to or forwarding a message (used by the reader and the list's right-click menu). */
const original = (m: MessageFull) => m.html ?? textToHtml(m.text);

/**
 * Which of your addresses to answer from: the one that sent it (your own sent mail), else the one it was sent to,
 * else the one the server delivered it to (Bcc, forwards), else the account's default.
 */
export function senderFor(m: MessageFull, accounts: AccountSummary[], accountId: string) {
  const identities = accounts.find((a) => a.id === accountId)?.identities ?? [];
  const find = (addrs: string[]) => {
    const set = new Set(addrs.map((a) => a.toLowerCase()));
    return identities.find((i) => set.has(i.email.toLowerCase()));
  };
  const own = find([m.fromAddr]);
  const identity = own ?? find([...m.to, ...m.cc].map((a) => a.address)) ?? find(m.deliveredTo ?? []) ?? identities.find((i) => i.isDefault) ?? identities[0];
  return { identity, sentByMe: !!own };
}

export function replyInit(m: MessageFull, accounts: AccountSummary[], accountId: string, all: boolean): ComposeInit {
  const myEmails = accounts.flatMap((a) => a.identities.map((i) => i.email.toLowerCase()));
  const { identity, sentByMe } = senderFor(m, accounts, accountId);
  const notMine = (a: string) => !!a && !myEmails.includes(a.toLowerCase());
  // replying to your own sent mail continues the conversation with its recipients, not with yourself
  const sentTo = sentByMe ? m.to.map((a) => a.address).filter(notMine) : [];
  const targets = sentTo.length ? sentTo : [m.replyTo[0] && !sentByMe ? m.replyTo[0].address : m.fromAddr];
  const others = !all ? [] : (sentByMe ? m.cc : [...m.to, ...m.cc]).map((a) => a.address).filter((a) => notMine(a) && !targets.includes(a));
  return {
    accountId, identityId: identity?.id, to: targets.join(", "), cc: [...new Set(others)].join(", "),
    subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
    html: `<p></p><p>On ${escapeHtml(new Date(m.date).toLocaleString())}, ${escapeHtml(m.fromName || m.fromAddr)} wrote:</p><blockquote>${original(m)}</blockquote>`,
    inReplyTo: m.messageId ?? undefined, references: [...m.references, ...(m.messageId ? [m.messageId] : [])],
    // an encrypted conversation stays encrypted
    security: m.security?.encryption?.status === "decrypted" ? { sign: false, encrypt: true, protocol: m.security.encryption.protocol } : undefined,
  };
}

export const forwardInit = (m: MessageFull, accounts: AccountSummary[], accountId: string): ComposeInit => ({
  accountId, identityId: senderFor(m, accounts, accountId).identity?.id,
  subject: /^fwd?:/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`,
  html: `<p></p><p>---------- Forwarded message ----------<br>From: ${escapeHtml(`${m.fromName} <${m.fromAddr}>`)}<br>Date: ${escapeHtml(new Date(m.date).toLocaleString())}<br>Subject: ${escapeHtml(m.subject)}</p>${original(m)}`,
});

/** Reply to the mailing list a message came through (its List-Post address), with the usual subject and quote. */
export function replyToListInit(m: MessageFull, accounts: AccountSummary[], accountId: string): ComposeInit {
  return { ...replyInit(m, accounts, accountId, false), to: m.listPost ?? "", cc: "" };
}

/** Forward messages as attachments (each as a .eml file), with nothing quoted; `first` (when loaded) picks the sender address. */
export function forwardAsAttachmentInit(list: MessageItem[], accounts: AccountSummary[], accountId: string, first?: MessageFull): ComposeInit {
  const one = list.length === 1 ? list[0]! : null;
  return {
    accountId, identityId: first ? senderFor(first, accounts, accountId).identity?.id : undefined,
    subject: one ? (/^fwd?:/i.test(one.subject) ? one.subject : `Fwd: ${one.subject}`) : `Fwd: ${list.length} messages`,
    attachments: list.map(messageAttachment),
  };
}
