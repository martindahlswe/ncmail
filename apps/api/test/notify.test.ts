import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IMAP_HOST, IMAP_PORT, SMTP_PORT, TEST_PASSWORD, user } from "./env.ts";
import { deliver, resetMailbox, waitFor } from "./helpers.ts";
import { startApi } from "./server.ts";
import { testNextcloud } from "./handoff.ts";

/** New mail for Nextcloud's notifications: what the Nextcloud app's background job is told, and what it is told to take back. */
const U = user(40);
let api: { url: string; stop: () => Promise<void> };
const ncs = testNextcloud();

const call = async (path: string, o: { method?: string; body?: unknown; cookie?: string } = {}) => {
  const r = await fetch(`${api.url}/api${path}`, {
    method: o.method ?? (o.body !== undefined ? "POST" : "GET"),
    headers: { ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...(o.cookie ? { cookie: o.cookie } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, data: text ? JSON.parse(text) : undefined, setCookie: r.headers.get("set-cookie") ?? "" };
};
const login = async (u: string) => (await call("/auth/handoff", { body: { token: ncs.token(u) } })).setCookie.split(";")[0]!;
/** The background job's call, signed as the Nextcloud app signs it. */
const poll = async (): Promise<{ new: any[]; done: any[] }> => {
  const s = ncs.signed("POST", "/api/internal/notifications", {}, new URL(api.url).host);
  const r = await fetch(`${api.url}/api/internal/notifications`, { method: "POST", headers: s.headers, body: s.body });
  expect(r.status).toBe(200);
  return r.json();
};

let alice = "", acctId = "", inbox = "";
/** Poll until something is announced (sync shows the message a moment before it records it as new mail). */
const pollNew = () => waitFor(async () => { const r = await poll(); return r.new.length ? r : false; }, { what: "new mail to be announced" });
const syncInbox = () => call(`/folders/${inbox}/sync`, { method: "POST", cookie: alice });
const byId = async (subject: string) =>
  waitFor(async () => (await call(`/folders/${inbox}/messages?threads=0`, { cookie: alice })).data.items.find((m: any) => m.subject === subject)?.id, { what: subject });

beforeAll(async () => {
  api = await startApi(4141, { NCMAIL_AUTH: "nextcloud", NEXTCLOUD_URL: "http://127.0.0.1:9", NCMAIL_HANDOFF_PUBLIC_KEY: ncs.publicKey }, "ncmail_notify_test");
  await resetMailbox(U);
  await deliver(U, "INBOX", { subject: "Before the account was added", text: "old" });
  alice = await login("alice");
  acctId = (await call("/accounts", { cookie: alice, body: {
    name: "Alice", email: U, imap: { host: IMAP_HOST, port: IMAP_PORT, security: "none", username: U, password: TEST_PASSWORD },
    smtp: { host: IMAP_HOST, port: SMTP_PORT, security: "none", username: U, password: TEST_PASSWORD } } })).data.id;
  await call(`/accounts/${acctId}/sync`, { method: "POST", cookie: alice });
  inbox = await waitFor(async () => (await call(`/accounts/${acctId}/folders`, { cookie: alice })).data?.find((f: any) => f.specialUse === "\\Inbox")?.id, { what: "folders" });
  await syncInbox();
  await byId("Before the account was added");
}, 90_000);
afterAll(async () => { await call(`/accounts/${acctId}`, { method: "DELETE", cookie: alice }).catch(() => {}); await api?.stop(); });

describe("new mail notifications", () => {
  it("only answers the Nextcloud app", async () => {
    expect((await fetch(`${api.url}/api/internal/notifications`, { method: "POST" })).status).toBe(401);
  });

  it("does not announce mail that was there before (the first sync)", async () => {
    expect((await poll()).new).toEqual([]);
  });

  it("announces new unread mail in the inbox once, with sender and subject", async () => {
    await deliver(U, "INBOX", [
      { subject: "Lunch tomorrow?", from: "Bob Builder <bob@example.org>", text: "hi" },
      { subject: "Already read elsewhere", text: "x", seen: true },
    ]);
    await syncInbox();
    const id = await byId("Lunch tomorrow?");
    const first = await pollNew();
    expect(first.new).toEqual([expect.objectContaining({ uid: "alice", id, subject: "Lunch tomorrow?", from: "Bob Builder", fromAddr: "bob@example.org", account: "Alice" })]);
    expect((await poll()).new).toEqual([]); // handed out once
  });

  it("takes the notification back once the message is read", async () => {
    const id = await byId("Lunch tomorrow?");
    expect((await poll()).done).toEqual([]);
    await call(`/messages/${id}`, { method: "PATCH", cookie: alice, body: { seen: true } });
    expect((await poll()).done).toEqual([{ uid: "alice", id }]);
    expect((await poll()).done).toEqual([]); // reported once
  });

  it("takes it back when the message is deleted, too", async () => {
    await deliver(U, "INBOX", { subject: "Soon in the trash", text: "x" });
    await syncInbox();
    const id = await byId("Soon in the trash");
    expect((await pollNew()).new.map((m) => m.id)).toEqual([id]);
    await call(`/messages/${id}`, { method: "DELETE", cookie: alice });
    expect((await poll()).done).toEqual([{ uid: "alice", id }]);
  });

  it("stays quiet for someone who switched it off, and says so in their settings", async () => {
    expect((await call("/prefs", { cookie: alice })).data).toEqual({ notifyNewMail: true, readReceipts: "ask" });
    expect((await call("/prefs", { method: "PATCH", cookie: alice, body: { notifyNewMail: false } })).data).toEqual({ notifyNewMail: false, readReceipts: "ask" });
    expect((await call("/prefs", { cookie: alice })).data).toEqual({ notifyNewMail: false, readReceipts: "ask" });
    await deliver(U, "INBOX", { subject: "While switched off", text: "x" });
    await syncInbox();
    await byId("While switched off");
    expect((await poll()).new).toEqual([]);
    await call("/prefs", { method: "PATCH", cookie: alice, body: { notifyNewMail: true } });
  });

  it("keeps each person's settings to themselves", async () => {
    const bob = await login("bob");
    expect((await call("/prefs", { cookie: bob })).data).toEqual({ notifyNewMail: true, readReceipts: "ask" });
    expect((await call("/prefs", { cookie: "" })).status).toBe(401);
  });
});
