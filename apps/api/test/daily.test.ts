import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_URL, user } from "./env.ts";
import { addAccount, api, apiRaw, deliver, imap, mailboxStatus, mailpit, messages, resetMailbox, sleep, syncFolder, waitFor, type Acct } from "./helpers.ts";

const U = user(20);
let acct: Acct;
let inbox: any, sent: any, trash: any, junk: any, archive: any;
let minute = 0;
const when = () => new Date(Date.UTC(2026, 7, 1, 9, minute++));
const bulk = (body: Record<string, unknown>) => api("/messages/bulk", { body });
const sync = async (...folders: any[]) => { for (const f of folders) await syncFolder(f.id); };
const subjectsOf = async (q: string) => ((await api(`/folders/${inbox.id}/messages?${q}`)).items as any[]).map((m) => m.subject);

beforeAll(async () => {
  await resetMailbox(U);
  await deliver(U, "INBOX", [
    { subject: "Charlie report", from: "Zed Zebra <zed@example.org>", text: "x".repeat(5000), date: when(), seen: true },
    { subject: "alpha plan", from: "Anna Berg <anna@example.org>", text: "short", date: when(), flagged: true },
    { subject: "Bravo notes", from: "Anna Berg <anna@example.org>", text: "y".repeat(500), date: when(), attachments: [{ filename: "a.txt", content: "attached" }] },
    { subject: "delta update", from: "Annika Ek <annika@example.org>", text: "z".repeat(20000), date: when(), seen: true },
    { subject: "Echo", from: "Bob Cole <bob@example.org>", text: "e", date: when() },
  ]);
  await deliver(U, "Sent", [
    { subject: "Re: alpha plan", from: `Me <${U}>`, to: "Anna Berg <anna@example.org>", date: when(), seen: true },
    { subject: "Re: delta update", from: `Me <${U}>`, to: "Anna Berg <anna@example.org>", cc: "Carol Quinn <carol@example.org>", date: when(), seen: true },
  ]);
  acct = await addAccount(U);
  [inbox, sent, trash, junk, archive] = await Promise.all(["INBOX", "Sent", "Trash", "Junk", "Archive"].map((n) => acct.folder(n)));
  await sync(inbox, sent);
});
afterAll(async () => { if (acct) await api(`/accounts/${acct.id}`, { method: "DELETE" }); });

describe("recipient suggestions", () => {
  it("suggests people from your mail, most-written-to first", async () => {
    // contacts are recorded just after the messages are stored: under load the first query can come before that
    const r = await waitFor(async () => { const x = await api<any[]>("/contacts?q=ann"); return x.length === 2 && x[0].sentTo === 2 ? x : false; }, { what: "contacts from the synced mail" });
    expect(r.map((c) => c.email)).toEqual(["anna@example.org", "annika@example.org"]);
    expect(r[0]).toMatchObject({ name: "Anna Berg", sentTo: 2 });
  });

  it("learns people you only ever wrote to (Cc counts)", async () => {
    expect((await api<any[]>("/contacts?q=carol"))[0]).toMatchObject({ email: "carol@example.org", name: "Carol Quinn" });
  });

  it("matches inside names and addresses, never suggests yourself, and returns nothing for an empty query", async () => {
    expect((await api<any[]>("/contacts?q=berg")).map((c) => c.email)).toEqual(["anna@example.org"]);
    expect(await api<any[]>(`/contacts?q=${encodeURIComponent(U.split("@")[0]!)}`)).toEqual([]);
    expect(await api<any[]>("/contacts?q=")).toEqual([]);
  });

  it("does not count the same message twice when a folder is synced again", async () => {
    await sync(inbox, sent, inbox, sent);
    expect((await api<any[]>("/contacts?q=anna"))[0]).toMatchObject({ sentTo: 2 });
  });
});

describe("sorting and filters", () => {
  it("sorts by date, sender, subject and size", async () => {
    expect(await subjectsOf("sort=date_desc")).toEqual(["Echo", "delta update", "Bravo notes", "alpha plan", "Charlie report"]);
    expect(await subjectsOf("sort=date_asc")).toEqual(["Charlie report", "alpha plan", "Bravo notes", "delta update", "Echo"]);
    expect(await subjectsOf("sort=from")).toEqual(["alpha plan", "Bravo notes", "delta update", "Echo", "Charlie report"]); // Anna, Anna, Annika, Bob, Zed
    expect(await subjectsOf("sort=subject")).toEqual(["alpha plan", "Bravo notes", "Charlie report", "delta update", "Echo"]); // case-insensitive
    expect((await subjectsOf("sort=size"))[0]).toBe("delta update");
  });

  it("pages through every order without gaps or repeats", async () => {
    for (const sort of ["date_desc", "date_asc", "from", "subject", "size"]) {
      const seen: string[] = [];
      let cursor = "";
      for (let i = 0; i < 10; i++) {
        const r = await api(`/folders/${inbox.id}/messages?sort=${sort}&limit=2${cursor}`);
        seen.push(...r.items.map((m: any) => m.subject));
        if (!r.next) break;
        cursor = `&cursor=${encodeURIComponent(JSON.stringify(r.next))}`;
      }
      expect(new Set(seen).size, sort).toBe(5);
      expect(seen, sort).toEqual(await subjectsOf(`sort=${sort}&limit=50`));
    }
  });

  it("filters to unread, starred, or with attachments", async () => {
    expect((await subjectsOf("filter=unread")).sort()).toEqual(["Bravo notes", "Echo", "alpha plan"]);
    expect(await subjectsOf("filter=starred")).toEqual(["alpha plan"]);
    expect(await subjectsOf("filter=attachments")).toEqual(["Bravo notes"]);
    expect((await subjectsOf("unread=1")).length).toBe(3); // the older parameter still works
  });

  it("lists individual messages for non-date orders even when conversations are requested", async () => {
    const r = await api(`/folders/${inbox.id}/messages?sort=subject&threads=1`);
    expect(r.items.every((m: any) => m.count === undefined)).toBe(true);
  });
});

describe("copy, spam and undo", () => {
  it("copies messages to another folder and leaves the originals", async () => {
    const [m] = await messages(inbox.id, "&filter=starred");
    await bulk({ action: "copy", messageIds: [m.id], targetFolderId: archive.id });
    await sync(archive);
    expect((await mailboxStatus(U, "Archive")).messages).toBe(1);
    expect((await mailboxStatus(U, "INBOX")).messages).toBe(5);
  });

  it("reports spam to Junk with a $Junk keyword, and undoes it", async () => {
    const m = (await messages(inbox.id)).find((x) => x.subject === "Echo")!;
    const r = await bulk({ action: "spam", messageIds: [m.id] });
    expect(r.undo).toBeTruthy();
    expect((await mailboxStatus(U, "Junk")).messages).toBe(1);
    const keywords = await imap(U, async (c) => {
      const lock = await c.getMailboxLock("Junk", { readOnly: true });
      try { for await (const x of c.fetch("1:*", { flags: true })) return [...x.flags]; return []; } finally { lock.release(); }
    });
    expect(keywords).toContain("$Junk");

    await api(`/undo/${r.undo}`, { method: "POST" });
    await waitFor(async () => (await mailboxStatus(U, "Junk")).messages === 0, { what: "undo to move it back" });
    expect((await mailboxStatus(U, "INBOX")).messages).toBe(5);
  });

  it("marks not-spam and moves the message back to the INBOX", async () => {
    await deliver(U, "Junk", { subject: "Wrongly flagged", date: when() });
    await sync(junk);
    const m = (await messages(junk.id))[0];
    await bulk({ action: "notspam", messageIds: [m.id] });
    await waitFor(async () => (await mailboxStatus(U, "Junk")).messages === 0, { what: "message to leave Junk" });
    expect((await mailboxStatus(U, "INBOX")).messages).toBe(6);
  });

  it("undoes a delete (the message returns to where it was)", async () => {
    await sync(inbox);
    const m = (await messages(inbox.id)).find((x) => x.subject === "Charlie report")!;
    const r = await bulk({ action: "delete", messageIds: [m.id] });
    expect((await mailboxStatus(U, "Trash")).messages).toBe(1);
    await api(`/undo/${r.undo}`, { method: "POST" });
    await waitFor(async () => (await mailboxStatus(U, "Trash")).messages === 0, { what: "undo" });
    expect((await mailboxStatus(U, "INBOX")).messages).toBe(6);
  });

  it("refuses to undo twice, or with an unknown token", async () => {
    const m = (await messages(inbox.id))[0];
    const r = await bulk({ action: "move", messageIds: [m.id], targetFolderId: archive.id });
    await api(`/undo/${r.undo}`, { method: "POST" });
    expect((await apiRaw(`/undo/${r.undo}`, { body: {} , method: "POST" })).status).toBe(410);
    expect((await apiRaw(`/undo/00000000-0000-0000-0000-000000000000`, { method: "POST" })).status).toBe(410);
  });

  it("gives no undo for a permanent delete", async () => {
    await sync(trash);
    await deliver(U, "Trash", { subject: "To purge", date: when() });
    await sync(trash);
    const m = (await messages(trash.id)).find((x) => x.subject === "To purge")!;
    expect((await bulk({ action: "delete", messageIds: [m.id] })).undo).toBeNull();
  });
});

describe("attachments are uploaded once and referenced", () => {
  const upload = async (name: string, content: string | Buffer, type = "text/plain") => {
    const form = new FormData();
    form.append("file", new Blob([content as BlobPart], { type }), name);
    const r = await fetch(`${API_URL}/api/uploads`, { method: "POST", body: form });
    return { status: r.status, body: await r.json() as any };
  };

  it("stores a file and serves it back unchanged", async () => {
    const bytes = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251));
    const { status, body } = await upload("data.bin", bytes, "application/octet-stream");
    expect(status).toBe(201);
    expect(body).toMatchObject({ filename: "data.bin", size: 300_000, contentType: "application/octet-stream" });
    const back = Buffer.from(await (await fetch(`${API_URL}/api/uploads/${body.id}`)).arrayBuffer());
    expect(back.equals(bytes)).toBe(true);
  });

  it("sends an uploaded file as an attachment", async () => {
    const { body } = await upload("notes.txt", "hello from an upload");
    await api(`/accounts/${acct.id}/send`, { body: { to: ["friend@example.org"], subject: "Upload send", text: "see file", attachments: [{ uploadId: body.id }] } });
    const m = await mailpit.bySubject("Upload send");
    expect(m.Attachments.map((a: any) => a.FileName)).toEqual(["notes.txt"]);
  });

  it("explains when an uploaded file is gone, and can delete uploads", async () => {
    const { body } = await upload("tmp.txt", "x");
    await fetch(`${API_URL}/api/uploads/${body.id}`, { method: "DELETE" });
    expect((await fetch(`${API_URL}/api/uploads/${body.id}`)).status).toBe(404);
    const r = await apiRaw(`/accounts/${acct.id}/send`, { body: { to: ["a@b.org"], text: "x", attachments: [{ uploadId: body.id }] } });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/add it again/i);
  });

  it("hands back a reopened draft's attachments as uploads", async () => {
    const drafts = await acct.folder("Drafts");
    const d = await api(`/accounts/${acct.id}/drafts`, { body: { to: ["a@example.org"], subject: "Draft with file", text: "x", attachments: [{ filename: "kept.txt", contentBase64: Buffer.from("keep me").toString("base64") }] } });
    expect(d.uid).toBeGreaterThan(0);
    await syncFolder(drafts.id);
    const row = (await messages(drafts.id)).find((m) => m.subject === "Draft with file")!;
    const loaded = await api(`/messages/${row.id}/draft`);
    expect(loaded.attachments).toHaveLength(1);
    expect(loaded.attachments[0]).toMatchObject({ filename: "kept.txt", size: 7 });
    expect(await (await fetch(`${API_URL}/api/uploads/${loaded.attachments[0].id}`)).text()).toBe("keep me");
  });
});

describe("undo send (outbox)", () => {
  const send = (subject: string, delaySeconds: number) => api(`/accounts/${acct.id}/send`, { body: { to: ["friend@example.org"], subject, text: "body", delaySeconds } });

  it("holds a message for the delay, then sends it, and keeps the copy in Sent", async () => {
    const t0 = Date.now();
    const q = await send("Delayed send", 3);
    expect(q).toMatchObject({ queued: true });
    expect((await api<any[]>("/outbox")).some((o) => o.id === q.outboxId && o.status === "pending")).toBe(true);
    expect((await mailpit.recent()).some((m) => m.Subject === "Delayed send")).toBe(false); // not yet
    await mailpit.bySubject("Delayed send");
    expect(Date.now() - t0).toBeGreaterThan(2500);
    await waitFor(async () => (await mailboxStatus(U, "Sent")).messages >= 3, { what: "copy in Sent" });
  });

  it("never sends a message that was cancelled in time", async () => {
    const q = await send("Cancelled send", 3);
    expect(await api(`/outbox/${q.outboxId}/cancel`, { method: "POST" })).toEqual({ cancelled: true });
    await sleep(5000);
    expect((await mailpit.recent()).some((m) => m.Subject === "Cancelled send")).toBe(false);
  });

  it("says so when it is too late to cancel", async () => {
    const q = await send("Late cancel", 1);
    await mailpit.bySubject("Late cancel");
    await sleep(300);
    expect((await apiRaw(`/outbox/${q.outboxId}/cancel`, { method: "POST" })).status).toBe(409);
  });

  it("can be sent right away instead of waiting", async () => {
    const q = await send("Send now", 30);
    await api(`/outbox/${q.outboxId}/send-now`, { method: "POST" });
    await mailpit.bySubject("Send now");
  });

  it("sends immediately when no delay is asked for", async () => {
    expect(await send("No delay", 0)).toEqual({ ok: true });
    await mailpit.bySubject("No delay");
  });
});
