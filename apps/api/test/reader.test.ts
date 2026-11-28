import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_URL, user } from "./env.ts";
import { addAccount, api, deliver, imap, mailboxStatus, messages, resetMailbox, syncFolder, waitFor, type Acct } from "./helpers.ts";

const U = user(17);
let acct: Acct;
let inbox: any;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const find = async (subject: string) => (await messages(inbox.id)).find((m) => m.subject === subject)!;

beforeAll(async () => {
  await resetMailbox(U);
  await deliver(U, "INBOX", [
    { subject: "Hostile HTML", html: '<p onclick="steal()">Hello <b>there</b></p><script>alert(1)</script><a href="javascript:alert(1)">x</a><img src="https://tracker.example/pixel.png"><p style="color:#00679e">styled</p>', text: "Hello there" },
    { subject: "Inline image", html: '<p>Logo: <img src="cid:logo123"></p>', attachments: [{ filename: "logo.png", content: png, contentType: "image/png", cid: "logo123" }] },
    { subject: "With attachment", text: "see file", attachments: [{ filename: "report.csv", content: "a,b\n1,2\n", contentType: "text/csv" }] },
    { subject: "Only text", text: "Just plain text\nsecond line" },
  ]);
  acct = await addAccount(U);
  inbox = await acct.folder("INBOX");
  await syncFolder(inbox.id);
});
afterAll(async () => { if (acct) await api(`/accounts/${acct.id}`, { method: "DELETE" }); });

describe("reading a message", () => {
  it("returns sanitised HTML and says remote images are present", async () => {
    const m = await api(`/messages/${(await find("Hostile HTML")).id}`);
    expect(m.html).toContain("<b>there</b>");
    expect(m.html).toContain("color:#00679e");
    expect(m.html).not.toMatch(/script|onclick|javascript:/i);
    expect(m.hasRemoteImages).toBe(true);
    expect(m.text).toContain("Hello there");
  });

  it("inlines cid images as data URIs and hides them from the attachment list", async () => {
    const m = await api(`/messages/${(await find("Inline image")).id}`);
    expect(m.html).toMatch(/src="data:image\/png;base64,/);
    expect(m.html).not.toContain("cid:");
    expect(m.attachments).toEqual([]);
    expect(m.hasRemoteImages).toBe(false);
  });

  it("returns plain text for text-only mail", async () => {
    const m = await api(`/messages/${(await find("Only text")).id}`);
    expect(m.html).toBeNull();
    expect(m.text).toBe("Just plain text\nsecond line\n");
  });

  it("lists attachments and downloads them safely", async () => {
    const row = await find("With attachment");
    const m = await api(`/messages/${row.id}`);
    expect(m.attachments).toMatchObject([{ filename: "report.csv", contentType: "text/csv" }]);
    const r = await fetch(`${API_URL}/api/messages/${row.id}/attachments/${m.attachments[0].idx}`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("a,b\n1,2\n");
    expect(r.headers.get("content-disposition")).toMatch(/^attachment; filename="report\.csv"/);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("answers 404 for an unknown message", async () => {
    const r = await fetch(`${API_URL}/api/messages/999999999`);
    expect(r.status).toBe(404);
  });

  it("answers 404, not an error, for a message deleted on the server since the last sync", async () => {
    await deliver(U, "INBOX", { subject: "Gone soon", text: "x" });
    await syncFolder(inbox.id);
    const { id, uid } = await find("Gone soon");
    await imap(U, async (c) => {
      const lock = await c.getMailboxLock("INBOX");
      try { await c.messageDelete(String(uid), { uid: true }); } finally { lock.release(); }
    });
    expect((await fetch(`${API_URL}/api/messages/${id}/source`)).status).toBe(404); // always read from the server
  });
});

describe("single-message actions", () => {
  it("sets flags on the server", async () => {
    const row = await find("Only text");
    await api(`/messages/${row.id}`, { method: "PATCH", body: { seen: true, flagged: true } });
    const flags = await imap(U, async (c) => {
      const lock = await c.getMailboxLock("INBOX", { readOnly: true });
      try { const out: string[][] = []; for await (const m of c.fetch("1:*", { flags: true, envelope: true })) if (m.envelope.subject === "Only text") out.push([...m.flags]); return out[0]!; } finally { lock.release(); }
    });
    expect(flags).toEqual(expect.arrayContaining(["\\Seen", "\\Flagged"]));
  });

  it("moves a message to another folder", async () => {
    const archive = await acct.folder("Archive");
    await api(`/messages/${(await find("Inline image")).id}/move`, { body: { folderId: archive.id } });
    expect((await mailboxStatus(U, "Archive")).messages).toBe(1);
    expect(await find("Inline image")).toBeUndefined();
  });

  it("deletes into Trash, then permanently from Trash", async () => {
    await api(`/messages/${(await find("Hostile HTML")).id}`, { method: "DELETE" });
    const trash = await acct.folder("Trash");
    await waitFor(async () => (await mailboxStatus(U, "Trash")).messages === 1, { what: "message in Trash" });
    await syncFolder(trash.id);
    await api(`/messages/${(await messages(trash.id))[0].id}`, { method: "DELETE" });
    expect((await mailboxStatus(U, "Trash")).messages).toBe(0);
  });
});
