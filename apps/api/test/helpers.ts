import { ImapFlow } from "imapflow";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { API_URL, IMAP_HOST, IMAP_PORT, MAILPIT_URL, SMTP_PORT, TEST_PASSWORD, user } from "./env.ts";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- HTTP
export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch(`${API_URL}/api${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!r.ok) throw Object.assign(new Error(data?.error ?? r.statusText), { status: r.status, data });
  return data as T;
}

/** Like api() but returns the status instead of throwing, for asserting on error responses. */
export async function apiRaw(path: string, init: { method?: string; body?: unknown } = {}) {
  try { return { status: 200, data: await api(path, init) }; }
  catch (e: any) { return { status: e.status as number, data: e.data }; }
}

export async function waitFor<T>(fn: () => Promise<T | false | undefined | null>, opts: { timeout?: number; interval?: number; what?: string } = {}): Promise<T> {
  const { timeout = 20_000, interval = 150, what = "condition" } = opts;
  const t0 = Date.now();
  let last: unknown;
  while (Date.now() - t0 < timeout) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
}

// ---------------------------------------------------------------- IMAP (acts like "another mail client")
export async function imap<T>(u: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = new ImapFlow({ host: IMAP_HOST, port: IMAP_PORT, secure: false, doSTARTTLS: false, auth: { user: u, pass: TEST_PASSWORD }, logger: false });
  c.on("error", () => {});
  await c.connect();
  try { return await fn(c); } finally { await c.logout().catch(() => {}); }
}

const SPECIAL = new Set(["INBOX", "Drafts", "Sent", "Trash", "Junk", "Archive"]);

/** Empty every mailbox and remove extra folders, so a test file starts from nothing. */
export async function resetMailbox(u: string) {
  await imap(u, async (c) => {
    // only the user's own folders: other people's ("Shared/...") and public folders ("Public/...") are not theirs to empty
    const boxes = (await c.list()).filter((b) => !/^(Shared|Public)(\/|$)/.test(b.path));
    for (const b of boxes.filter((b) => !b.flags.has("\\Noselect") && !b.flags.has("\\NonExistent"))) {
      const lock = await c.getMailboxLock(b.path);
      try { if ((c.mailbox as any).exists > 0) await c.messageDelete("1:*"); } finally { lock.release(); }
    }
    for (const b of boxes.filter((b) => !SPECIAL.has(b.path)).sort((a, b) => b.path.length - a.path.length)) await c.mailboxDelete(b.path).catch(() => {});
  });
}

export interface Msg {
  from?: string; to?: string; cc?: string; subject?: string; text?: string; html?: string;
  messageId?: string; inReplyTo?: string; references?: string[]; date?: Date; seen?: boolean; flagged?: boolean;
  attachments?: { filename: string; content: string | Buffer; contentType?: string; cid?: string }[];
  headers?: Record<string, string>;
}

export async function buildRaw(m: Msg, defaultTo: string): Promise<Buffer> {
  // Return-Path goes on top, where the delivering server writes it (the app trusts only a topmost one)
  const { "Return-Path": returnPath, ...headers } = m.headers ?? {};
  const raw = await new MailComposer({
    from: m.from ?? "Alice <alice@example.org>", to: m.to ?? defaultTo, cc: m.cc, subject: m.subject ?? "(test)",
    text: m.text ?? "body", html: m.html, messageId: m.messageId, inReplyTo: m.inReplyTo, references: m.references,
    date: m.date, attachments: m.attachments, headers,
  }).compile().build();
  return returnPath === undefined ? raw : Buffer.concat([Buffer.from(`Return-Path: ${returnPath}\r\n`), raw]);
}

/** Deliver messages straight into a mailbox over IMAP (as if another client or the MTA put them there). */
export async function deliver(u: string, box: string, msgs: Msg | Msg[]) {
  const list = Array.isArray(msgs) ? msgs : [msgs];
  await imap(u, async (c) => {
    for (const m of list) {
      const flags = [...(m.seen ? ["\\Seen"] : []), ...(m.flagged ? ["\\Flagged"] : [])];
      await c.append(box, await buildRaw(m, u), flags, m.date);
    }
  });
}

export const mailboxStatus = (u: string, box: string) =>
  imap(u, async (c) => {
    const s = await c.status(box, { messages: true, unseen: true });
    const lock = await c.getMailboxLock(box, { readOnly: true });
    try {
      const flagged = ((await c.search({ flagged: true }, { uid: true })) || []).length;
      return { messages: s.messages ?? 0, unseen: s.unseen ?? 0, flagged };
    } finally { lock.release(); }
  });

export async function createMailbox(u: string, path: string) { await imap(u, (c) => c.mailboxCreate(path)); }

// ---------------------------------------------------------------- app accounts
export interface Acct { id: string; email: string; folders: () => Promise<any[]>; folder: (name: string) => Promise<any> }

export async function addAccount(u: string, extra: Record<string, unknown> = {}): Promise<Acct> {
  const a = await api("/accounts", { body: {
    name: `Test ${u.split("@")[0]}`, email: u,
    imap: { host: IMAP_HOST, port: IMAP_PORT, security: "none", username: u, password: TEST_PASSWORD },
    smtp: { host: IMAP_HOST, port: SMTP_PORT, security: "none", username: u, password: TEST_PASSWORD },
    ...extra,
  } });
  await api(`/accounts/${a.id}/sync`, { method: "POST" });
  const folders = () => api<any[]>(`/accounts/${a.id}/folders`);
  // the whole folder list, not just INBOX: the first sync writes folders one by one
  await waitFor(async () => { const l = await folders(); return l.some((f) => f.specialUse === "\\Inbox") && !l.some((f) => f.syncing); }, { what: "folders to sync" });
  const folder = async (name: string) => (await folders()).find((f) => f.name === name);
  return { id: a.id, email: u, folders, folder };
}

/** Sync a folder and wait until it is done. */
export async function syncFolder(folderId: string) {
  await api(`/folders/${folderId}/sync`, { method: "POST" });
  await waitFor(async () => !(await api(`/folders/${folderId}`)).syncing, { what: "folder sync to finish" });
}

export async function messages(folderId: string, q = "") {
  return (await api(`/folders/${folderId}/messages?limit=200${q}`)).items as any[];
}

// ---------------------------------------------------------------- Mailpit
const STARTED = Date.now();
export const mailpit = {
  async list(): Promise<any[]> { return (await (await fetch(`${MAILPIT_URL}/api/v1/messages?limit=200`)).json()).messages; },
  async get(id: string): Promise<any> { return (await fetch(`${MAILPIT_URL}/api/v1/message/${id}`)).json(); },
  async headers(id: string): Promise<Record<string, string[]>> { return (await fetch(`${MAILPIT_URL}/api/v1/message/${id}/headers`)).json(); },
  /** Mail that arrived since this test process started (Mailpit keeps everything from earlier runs). */
  async recent(): Promise<any[]> { return (await this.list()).filter((m) => Date.parse(m.Created) >= STARTED - 2000); },
  /** Wait for a message with this subject and return it in full. */
  async bySubject(subject: string) {
    const hit = await waitFor(async () => (await this.recent()).find((m) => m.Subject === subject), { what: `mail "${subject}" in Mailpit` });
    return this.get(hit.ID);
  },
};
export { user };
