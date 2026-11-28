import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { user } from "./env.ts";
import { addAccount, api, apiRaw, deliver, mailboxStatus, messages, resetMailbox, syncFolder, type Acct } from "./helpers.ts";

const U = user(15);
let acct: Acct;
let inbox: any, junk: any, trash: any;
let ids: string[] = [];
const bulk = (body: Record<string, unknown>) => api("/messages/bulk", { body });
/** The app's view and the IMAP server's view of a folder must agree. */
const agree = async (name: string, f: any) => {
  const app = await acct.folder(name);
  const srv = await mailboxStatus(U, name);
  expect({ total: app.total, unseen: app.unseen }).toEqual({ total: srv.messages, unseen: srv.unseen });
  return { ...srv, id: f.id };
};

beforeAll(async () => {
  await resetMailbox(U);
  // 40 messages: every 4th unread; the first 6 are one 3-message thread + singles
  await deliver(U, "INBOX", Array.from({ length: 40 }, (_, i) => ({
    subject: `Bulk ${i}`, messageId: `<bulk-${i}@t>`, seen: i % 4 !== 0, date: new Date(Date.UTC(2026, 5, 1, 8, i)),
    ...(i % 10 === 5 ? { references: [`<bulk-${i - 1}@t>`], inReplyTo: `<bulk-${i - 1}@t>` } : {}),
  })));
  acct = await addAccount(U);
  inbox = await acct.folder("INBOX"); junk = await acct.folder("Junk"); trash = await acct.folder("Trash");
  await syncFolder(inbox.id);
  ids = (await messages(inbox.id)).map((m) => m.id); // newest first
});
afterAll(async () => { if (acct) await api(`/accounts/${acct.id}`, { method: "DELETE" }); });

describe("flag actions", () => {
  it("marks messages read and unread, on the server and in the app", async () => {
    const unread = (await messages(inbox.id, "&unread=1")).slice(0, 5).map((m) => m.id);
    expect((await bulk({ action: "read", messageIds: unread })).affected).toBe(5);
    await agree("INBOX", inbox);
    expect((await acct.folder("INBOX")).unseen).toBe(5);
    await bulk({ action: "unread", messageIds: unread.slice(0, 4) });
    expect((await agree("INBOX", inbox)).unseen).toBe(9);
  });

  it("stars and unstars", async () => {
    await bulk({ action: "star", messageIds: ids.slice(0, 6) });
    expect((await mailboxStatus(U, "INBOX")).flagged).toBe(6);
    await bulk({ action: "unstar", messageIds: ids.slice(0, 2) });
    expect((await mailboxStatus(U, "INBOX")).flagged).toBe(4);
    expect((await messages(inbox.id)).filter((m) => m.flagged)).toHaveLength(4);
  });
});

describe("move and delete", () => {
  it("moves several messages to another folder in one go", async () => {
    const r = await bulk({ action: "move", messageIds: ids.slice(10, 16), targetFolderId: junk.id });
    expect(r.affected).toBe(6);
    await syncFolder(junk.id);
    const a = await agree("INBOX", inbox);
    const j = await agree("Junk", junk);
    expect(a.messages).toBe(34);
    expect(j.messages).toBe(6);
  });

  it("deletes into Trash, and permanently from Trash", async () => {
    await bulk({ action: "delete", messageIds: ids.slice(20, 24) });
    await syncFolder(trash.id);
    expect((await agree("Trash", trash)).messages).toBe(4);
    expect((await agree("INBOX", inbox)).messages).toBe(30);

    const inTrash = (await messages(trash.id)).slice(0, 2).map((m) => m.id);
    await bulk({ action: "delete", messageIds: inTrash });
    expect((await agree("Trash", trash)).messages).toBe(2);
  });
});

describe("targets", () => {
  it("acts on whole conversations through threadIds", async () => {
    const conv = ((await api(`/folders/${inbox.id}/messages?threads=1&limit=100`)).items as any[]).find((c) => c.count > 1)!;
    await bulk({ action: "read", threadIds: [conv.threadId], folderId: inbox.id });
    const after = ((await api(`/folders/${inbox.id}/messages?threads=1&limit=100`)).items as any[]).find((c) => c.threadId === conv.threadId)!;
    expect(after.unseenCount).toBe(0);
    await agree("INBOX", inbox);
  });

  it("acts on everything in a folder (scope=folder), optionally only the unread", async () => {
    const r = await bulk({ action: "read", scope: "folder", folderId: inbox.id, unreadOnly: true });
    expect(r.affected).toBeGreaterThan(0);
    expect((await agree("INBOX", inbox)).unseen).toBe(0);
  });
});

describe("validation", () => {
  it("needs a destination to move", async () => {
    const r = await apiRaw("/messages/bulk", { body: { action: "move", messageIds: ids.slice(0, 1) } });
    expect(r.status).toBe(400);
  });
  it("needs a folder to resolve conversations", async () => {
    expect((await apiRaw("/messages/bulk", { body: { action: "read", threadIds: ["1"] } })).status).toBe(400);
  });
  it("does nothing for an empty selection", async () => {
    expect((await bulk({ action: "read", messageIds: [] })).affected).toBe(0);
  });
  it("rejects unknown actions", async () => {
    expect((await apiRaw("/messages/bulk", { body: { action: "explode", messageIds: ["1"] } })).status).toBe(400);
  });
});
