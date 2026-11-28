export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  // Only declare JSON when there is a body: Fastify rejects an empty body with a JSON content-type.
  const headers = init?.body != null ? { "content-type": "application/json" } : undefined;
  const r = await fetch(`/api${path}`, { ...init, headers });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    if (r.status === 401 && body.code === "auth") window.dispatchEvent(new Event("ncmail:auth-required"));
    throw new Error(body.error ?? r.statusText);
  }
  return r.status === 204 ? (undefined as T) : r.json();
}

export interface Folder {
  id: string; accountId: string; path: string; delimiter: string | null; name: string; specialUse: string | null;
  selectable: boolean; total: number; unseen: number; syncing: boolean; syncError: string | null; queued?: boolean; olderOnServer?: number;
  /** "personal", or someone else's ("other": shared by sharedOwner; "shared": a shared namespace). */
  namespace?: "personal" | "other" | "shared"; sharedOwner?: string | null;
  /** IMAP rights in a shared folder (RFC 4314), null when everything is allowed. */
  rights?: string | null;
}
/** Whether a folder allows these IMAP rights: w = flags, s = read state, i = add mail, t+e = delete/move away, k = subfolders. */
export const can = (f: { rights?: string | null } | null | undefined, rights: string) => !f?.rights || [...rights].every((r) => f.rights!.includes(r));
export const isShared = (f: { namespace?: string } | null | undefined) => !!f?.namespace && f.namespace !== "personal";
export interface Addr { name: string; address: string }
export interface MessageItem {
  id: string; uid: string; subject: string; fromName: string; fromAddr: string; date: string;
  seen: boolean; flagged: boolean; answered: boolean; hasAttachments: boolean; labels?: string[]; accountId?: string; accountName?: string;
  /** Bytes on the mail server */
  size?: number;
  /** Conversation mode only */
  threadId?: string | null; count?: number; unseenCount?: number; names?: string[];
  /** Search results only */
  folderId?: string; folderName?: string;
}
export type SignatureStatus = "valid" | "untrusted" | "mismatch" | "expired" | "invalid" | "unknown-key";
export interface SecurityInfo {
  signature?: { protocol: "pgp" | "smime"; status: SignatureStatus; message: string; canSave?: boolean; signer?: { name: string; email: string; fingerprint: string; emails: string[] } };
  /** authenticated: false when nothing proves the decrypted content is unchanged from the sender (S/MIME without their signature). */
  encryption?: { protocol: "pgp" | "smime"; status: "decrypted" | "no-key" | "failed"; message: string; authenticated?: boolean };
}
export interface MessageFull extends MessageItem {
  security?: SecurityInfo | null;
  auth?: { spf: string; dkim: string; dmarc: string; present: boolean } | null;
  warnings?: { kind: string; level: "bad" | "warn"; message: string }[];
  hasInvite?: boolean;
  folderId: string; to: Addr[]; cc: Addr[]; messageId: string | null; references: string[]; replyTo: Addr[];
  /** Your addresses the server delivered it to (Delivered-To, X-Original-To). */
  deliveredTo?: string[];
  /** How to leave the mailing list this came from: the service posts for you (one-click), mails the list, or you open its page. */
  unsubscribe?: { method: "one-click" | "mail" | "link"; target: string } | null;
  /** The mailing list's posting address (List-Post), for "Reply to list". */
  listPost?: string | null;
  /** The sender asked for a read receipt to this address, and it has not been answered yet. */
  receiptTo?: string | null;
  /** Whether "always show images from this sender" may apply (not in Junk, sender checks passed, content verified). */
  imagesTrustable?: boolean;
  html: string | null; hasRemoteImages: boolean; text: string;
  /** Remote images were removed because the content is not verified (they cannot be loaded at all). */
  remoteBlocked?: boolean;
  attachments: { idx: number; filename: string; contentType: string; size: number }[];
}
export interface ListPage {
  items: MessageItem[]; next: { v?: string; date: string; id: string } | null;
  total?: number; capped?: boolean; partial?: boolean; notes?: string[];
  index?: { enabled: boolean; indexed: number; total: number };
}
export interface SearchState { q: string; scope: "all" | "folder"; text: boolean; onScope: (s: "all" | "folder") => void; onText: (t: boolean) => void; onClear: () => void }

/** "Clients/Acme": a folder's full path, shown the same way whatever separator the server uses. */
export const folderPath = (f: { path: string; delimiter: string | null; specialUse: string | null }) =>
  f.specialUse === "\\Inbox" ? "Inbox" : f.path.split(f.delimiter || "/").filter(Boolean).join("/");
const SPECIAL = ["\\Inbox", "\\Drafts", "\\Sent", "\\Archive", "\\Junk", "\\Trash"];
/** Folders in the order people expect: the standard ones first, then the rest by path, so subfolders sit under their parents. */
export const sortFolders = <T extends { path: string; delimiter: string | null; specialUse: string | null }>(list: T[]) =>
  [...list].sort((a, b) => { const ra = SPECIAL.indexOf(a.specialUse ?? ""), rb = SPECIAL.indexOf(b.specialUse ?? ""); return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb) || folderPath(a).localeCompare(folderPath(b), undefined, { numeric: true, sensitivity: "base" }); });

export const fmtAddr = (a: Addr) => (a.name ? `${a.name} <${a.address}>` : a.address);
export const fmtSize = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
export function fmtDate(iso: string) {
  const d = new Date(iso), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

/** "Re: Fwd: Topic" -> "Topic" (conversation titles). */
export const stripSubject = (s: string) => s.replace(/^\s*((re|fwd?|aw|sv|vs|wg)(\[\d+\])?\s*:\s*)+/i, "").trim() || s;
export const initials = (name: string) => {
  const parts = name.replace(/[<>"@.]/g, " ").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1]![0] : "")).toUpperCase();
};
export const avatarColor = (key: string) => {
  let h = 0;
  for (const ch of key.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 42% 32%)`; // dark enough for white initials at 4.5:1 on every hue (WCAG AA)
};

export const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
/** Plain text -> simple HTML paragraphs (blank line = new paragraph, newline = <br>). */
export const textToHtml = (t: string) => (t.trim() ? t.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("") : "<p></p>");
export const htmlToPlain = (h: string) => new DOMParser().parseFromString(h, "text/html").body.textContent ?? "";

export type SortKey = "date_desc" | "date_asc" | "from" | "subject" | "size";
export type FilterKey = "all" | "unread" | "starred" | "attachments";
export const SORT_LABELS: Record<SortKey, string> = { date_desc: "Newest first", date_asc: "Oldest first", from: "Sender A–Z", subject: "Subject A–Z", size: "Largest first" };
export const FILTER_LABELS: Record<FilterKey, string> = { all: "All", unread: "Unread", starred: "Starred", attachments: "Attachments" };

export interface UploadedFile { id: string; filename: string; contentType: string; size: number }
/** A whole message attached to a new one ("forward as attachment") looks like an upload whose id names the message. */
export const messageAttachment = (m: { id: string; subject: string; size?: number }): UploadedFile =>
  ({ id: `msg:${m.id}`, filename: emlName(m.subject), contentType: "message/rfc822", size: m.size ?? 0 });
export const emlName = (subject: string) => `${(subject || "message").replace(/[\\/:*?"<>|\r\n\t]+/g, "_").trim().slice(0, 80) || "message"}.eml`;
/** How the send and draft requests refer to an attachment: an upload, or a message fetched from the mail server. */
export const attachmentRef = (a: { id: string; filename: string }) =>
  a.id.startsWith("msg:") ? { messageId: a.id.slice(4), filename: a.filename } : { uploadId: a.id, filename: a.filename };
/** Upload one file with progress (fetch cannot report upload progress). */
export function uploadFile(file: File, onProgress: (fraction: number) => void): { promise: Promise<UploadedFile>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<UploadedFile>((resolve, reject) => {
    xhr.open("POST", "/api/uploads");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      try {
        const j = JSON.parse(xhr.responseText || "{}");
        xhr.status >= 200 && xhr.status < 300 ? resolve(j) : reject(new Error(j.error ?? `Upload failed (${xhr.status})`));
      } catch { reject(new Error("Upload failed")); }
    };
    xhr.onerror = () => reject(new Error("Upload failed: network error"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    const fd = new FormData(); fd.append("file", file, file.name);
    xhr.send(fd);
  });
  return { promise, abort: () => xhr.abort() };
}

export type BulkAction = "read" | "unread" | "star" | "unstar" | "move" | "copy" | "delete" | "spam" | "notspam" | "snooze" | "label" | "unlabel";
export const bulk = (body: Record<string, unknown>) =>
  api<{ affected: number; undo: string | null }>("/messages/bulk", { method: "POST", body: JSON.stringify(body) });
export const undoMove = (token: string) => api<{ restored: number }>(`/undo/${token}`, { method: "POST" });

export const isEmail = (s: string) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s);
/** "Anna <a@b.c>, d@e.f" -> list of entries; entries that are not an address are flagged invalid. */
export function parseRecipients(s: string): { raw: string; label: string; address: string; valid: boolean }[] {
  return s.split(/[,;]/).map((x) => x.trim()).filter(Boolean).map((raw) => {
    const m = raw.match(/^(.*?)<([^>]+)>$/);
    const address = (m ? m[2]! : raw).trim(), name = m ? m[1]!.replace(/^"|"$/g, "").trim() : "";
    return { raw, label: name || address, address, valid: isEmail(address) };
  });
}
