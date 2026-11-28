import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_URL, user } from "./env.ts";
import { addAccount, api, createMailbox, deliver, imap, messages, resetMailbox, sleep, syncFolder, waitFor, type Acct } from "./helpers.ts";

const U = user(12);
let acct: Acct;
let inbox: any;

const base = new Date("2026-03-01T12:00:00Z").getTime();
const at = (i: number) => new Date(base + i * 60_000); // i-th minute, so ordering is predictable

beforeAll(async () => {
  await resetMailbox(U);
  await deliver(U, "INBOX", Array.from({ length: 30 }, (_, i) => ({
    subject: `Message ${i}`, from: `Sender ${i % 3} <s${i % 3}@example.org>`, date: at(i), seen: i % 3 !== 0, messageId: `<sync-${i}@t>`,
  })));
  acct = await addAccount(U);
  inbox = await acct.folder("INBOX");
  // the folder's counter arrives with the folder list; the messages themselves a moment later
  await waitFor(async () => (await messages(inbox.id)).length === 30, { what: "INBOX to mirror its 30 messages" });
  inbox = await acct.folder("INBOX");
});
afterAll(async () => { if (acct) await api(`/accounts/${acct.id}`, { method: "DELETE" }); });

describe("initial sync", () => {
  it("mirrors the folder with correct counts and special-use folders", async () => {
    expect(inbox.unseen).toBe(10); // every third message was delivered unread
    const names = (await acct.folders()).map((f) => f.specialUse).filter(Boolean);
    expect(names).toEqual(expect.arrayContaining(["\\Inbox", "\\Sent", "\\Drafts", "\\Trash", "\\Junk", "\\Archive"]));
  });

  it("lists newest first and pages with a keyset cursor without gaps or overlaps", async () => {
    const seen: string[] = [];
    let cursor = "";
    for (let page = 0; page < 10; page++) {
      const r = await api(`/folders/${inbox.id}/messages?limit=7${cursor}`);
      seen.push(...r.items.map((i: any) => i.subject));
      if (!r.next) break;
      cursor = `&beforeDate=${encodeURIComponent(r.next.date)}&beforeId=${r.next.id}`;
    }
    expect(seen).toHaveLength(30);
    expect(new Set(seen).size).toBe(30);
    expect(seen[0]).toBe("Message 29");
    expect(seen[29]).toBe("Message 0");
  });

  it("filters to unread messages", async () => {
    const unread = await messages(inbox.id, "&unread=1");
    expect(unread).toHaveLength(10);
    expect(unread.every((m) => !m.seen)).toBe(true);
  });

  it("stores sender, subject, date and flags correctly", async () => {
    const m = (await messages(inbox.id)).find((x) => x.subject === "Message 3")!;
    expect(m).toMatchObject({ fromName: "Sender 0", fromAddr: "s0@example.org", seen: false, hasAttachments: false });
    expect(new Date(m.date).toISOString()).toBe(at(3).toISOString());
  });
});

describe("live updates from the server (IMAP IDLE)", () => {
  it("picks up new mail without being asked", async () => {
    await deliver(U, "INBOX", { subject: "Arrived while watching", date: at(40) });
    await waitFor(async () => (await acct.folder("INBOX")).total === 31, { timeout: 20_000, what: "new message to appear via IDLE" });
    expect((await messages(inbox.id))[0].subject).toBe("Arrived while watching");
  });

  it("picks up flag changes made by another client", async () => {
    const before = (await acct.folder("INBOX")).unseen;
    await imap(U, async (c) => {
      const lock = await c.getMailboxLock("INBOX");
      try { const unseen = (await c.search({ seen: false }, { uid: true })) || []; await c.messageFlagsAdd(String(unseen[0]), ["\\Seen"], { uid: true }); } finally { lock.release(); }
    });
    await waitFor(async () => (await acct.folder("INBOX")).unseen === before - 1, { timeout: 20_000, what: "unread count to drop" });
  });

  it("notices messages deleted by another client", async () => {
    await imap(U, async (c) => {
      const lock = await c.getMailboxLock("INBOX");
      try {
        const first = ((await c.search({ all: true }, { uid: true })) || [])[0]!; // UIDs keep growing across runs, so never assume UID 1
        await c.messageDelete(String(first), { uid: true });
      } finally { lock.release(); }
    });
    await waitFor(async () => (await acct.folder("INBOX")).total === 30, { timeout: 20_000, what: "total to drop" });
    expect(await messages(inbox.id)).toHaveLength(30);
  });

  it("pushes an event to the browser when something changed", async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${API_URL}/api/events`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const events: any[] = [];
    const pump = (async () => {
      const dec = new TextDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          for (const line of dec.decode(value).split("\n")) if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
        }
      } catch { /* aborted */ }
    })();
    await sleep(300);
    await deliver(U, "INBOX", { subject: "Triggers an event", date: at(41) });
    const ev = await waitFor(async () => events.find((e) => e.accountId === acct.id), { timeout: 20_000, what: "SSE event" });
    ctrl.abort(); await pump;
    expect(ev).toMatchObject({ type: "sync", accountId: acct.id });
  });
});

describe("folders", () => {
  it("shows nested folders with their path and delimiter, and marks container-only parents as not selectable", async () => {
    await createMailbox(U, "Clients");
    await createMailbox(U, "Clients/Acme");
    await createMailbox(U, "Projects/Alpha/Specs");
    await api(`/accounts/${acct.id}/sync`, { method: "POST" });
    const folders = await waitFor(async () => { const f = await acct.folders(); return f.some((x) => x.path === "Projects/Alpha/Specs") ? f : false; }, { what: "new folders" });
    const byPath = Object.fromEntries(folders.map((f) => [f.path, f]));
    expect(byPath["Clients/Acme"]).toMatchObject({ name: "Acme", selectable: true });
    expect(byPath["Clients/Acme"].delimiter).toBe("/");
    expect(byPath["Projects"].selectable).toBe(false);
    expect(byPath["Projects/Alpha"].selectable).toBe(false);
    expect(byPath["Projects/Alpha/Specs"].selectable).toBe(true);
  });

  it("syncs a folder when it is opened and removes folders deleted on the server", async () => {
    await deliver(U, "Archive", [{ subject: "Archived 1", date: at(1) }, { subject: "Archived 2", date: at(2) }]);
    const archive = await acct.folder("Archive");
    await syncFolder(archive.id);
    expect((await messages(archive.id)).map((m) => m.subject)).toEqual(["Archived 2", "Archived 1"]);

    await imap(U, (c) => c.mailboxDelete("Clients/Acme"));
    await api(`/accounts/${acct.id}/sync`, { method: "POST" });
    await waitFor(async () => !(await acct.folders()).some((f) => f.path === "Clients/Acme"), { what: "deleted folder to disappear" });
  });
});

describe("repeated syncs (re-used connections)", () => {
  // Regression: a pooled connection keeps the INBOX selected, and its cached message count is stale until a command runs.
  it("sees mail that arrived since the previous sync, every time", async () => {
    for (let i = 0; i < 4; i++) {
      const before = (await messages(inbox.id)).length;
      await deliver(U, "INBOX", { subject: `Re-used connection ${i}`, date: at(100 + i) });
      await syncFolder(inbox.id);
      expect((await messages(inbox.id)).length).toBe(before + 1);
    }
  });
});

describe("oversized headers", () => {
  it("stores a message with very long header values in bounded form and keeps syncing", async () => {
    const subject = randomBytes(4500).toString("base64"); // 6000 characters that do not compress
    const longId = `<${"a".repeat(1200)}@t>`;
    await deliver(U, "INBOX", { subject, from: `${randomBytes(3000).toString("hex")} <long@example.org>`, messageId: longId, references: [longId], date: at(200) });
    await deliver(U, "INBOX", { subject: "After the long one", date: at(201) });
    await syncFolder(inbox.id);
    const list = await messages(inbox.id);
    const long = list.find((m) => m.fromAddr === "long@example.org");
    expect(long).toBeTruthy();
    expect(Buffer.byteLength(long.subject)).toBeLessThanOrEqual(1500);
    expect(subject.startsWith(long.subject)).toBe(true);
    expect(Buffer.byteLength(long.fromName)).toBeLessThanOrEqual(1500);
    expect(list.some((m) => m.subject === "After the long one")).toBe(true);
    expect((await api(`/folders/${inbox.id}`)).syncError).toBeFalsy();

    await deliver(U, "INBOX", { subject: "Later still", date: at(202) });
    await syncFolder(inbox.id);
    expect((await messages(inbox.id)).some((m) => m.subject === "Later still")).toBe(true);
  });
});
