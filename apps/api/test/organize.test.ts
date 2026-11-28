import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_URL, user } from "./env.ts";
import { addAccount, api, apiRaw, deliver, imap, mailpit, messages, resetMailbox, sleep, syncFolder, waitFor, type Acct } from "./helpers.ts";

/** Snooze, send later, labels, saved searches, source view and attachment preview. */
const U = user(34);
let acct: Acct;
let inbox = "";
const bulk = (body: Record<string, unknown>) => api<{ affected: number; undo: string | null }>("/messages/bulk", { body });
const find = async (folderId: string, subject: string) => (await messages(folderId)).find((m) => m.subject === subject);
const flagsOnServer = (box: string, subject: string) => imap(U, async (c) => {
  const lock = await c.getMailboxLock(box);
  try { for await (const m of c.fetch("1:*", { envelope: true, flags: true })) if (m.envelope?.subject === subject) return [...m.flags]; return []; } finally { lock.release(); }
});

beforeAll(async () => {
  await resetMailbox(U);
  await deliver(U, "INBOX", [
    { subject: "Snooze me", text: "zzz" }, { subject: "Snooze and undo", text: "zzz" }, { subject: "Label me", text: "x" }, { subject: "Other", text: "y" },
    { subject: "With files", text: "see", attachments: [
      { filename: "pic.png", content: Buffer.from("89504e470d0a1a0a", "hex"), contentType: "image/png" },
      { filename: "evil.svg", content: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', contentType: "image/svg+xml" },
      { filename: "notes.txt", content: "plain notes", contentType: "text/plain" },
      { filename: "page.html", content: "<script>alert(1)</script>", contentType: "text/html" }] },
  ]);
  acct = await addAccount(U);
  inbox = (await acct.folder("INBOX")).id;
  await syncFolder(inbox);
});
afterAll(async () => { if (acct) await api(`/accounts/${acct.id}`, { method: "DELETE" }); });

describe("snooze", () => {
  it("moves the message to a Snoozed folder and brings it back unread at the time", async () => {
    const m = await find(inbox, "Snooze me");
    await api(`/messages/${m.id}`, { method: "PATCH", body: { seen: true } });
    const r = await bulk({ action: "snooze", messageIds: [m.id], until: new Date(Date.now() + 4000).toISOString() });
    expect(r.affected).toBe(1);
    const snoozed = await waitFor(async () => acct.folder("Snoozed"), { what: "the Snoozed folder" });
    expect(await find(inbox, "Snooze me")).toBeUndefined();
    await syncFolder(snoozed.id);
    expect(await find(snoozed.id, "Snooze me")).toBeTruthy();
    // it comes back, unread
    const back = await waitFor(async () => { await syncFolder(inbox); const x = await find(inbox, "Snooze me"); return x; }, { timeout: 30_000, what: "the message to return" });
    expect(back.seen).toBe(false);
    await syncFolder(snoozed.id);
    expect(await find(snoozed.id, "Snooze me")).toBeUndefined();
  });
  it("refuses a time in the past", async () => {
    const m = await find(inbox, "Snooze and undo");
    expect((await apiRaw("/messages/bulk", { body: { action: "snooze", messageIds: [m.id], until: new Date(Date.now() - 1000).toISOString() } })).status).toBe(400);
  });
  it("can be undone, and then does not come back a second time", async () => {
    const m = await find(inbox, "Snooze and undo");
    const r = await bulk({ action: "snooze", messageIds: [m.id], until: new Date(Date.now() + 3000).toISOString() });
    expect(await find(inbox, "Snooze and undo")).toBeUndefined();
    await api(`/undo/${r.undo}`, { method: "POST" });
    await syncFolder(inbox);
    expect(await find(inbox, "Snooze and undo")).toBeTruthy();
    await sleep(5000);
    await syncFolder(inbox);
    expect((await messages(inbox)).filter((x) => x.subject === "Snooze and undo")).toHaveLength(1);
  });
});

describe("labels", () => {
  it("creates labels with a colour and a stable key", async () => {
    const l = await api<any>(`/accounts/${acct.id}/labels`, { body: { name: "Big Client" } });
    expect(l).toMatchObject({ slug: "big-client", name: "Big Client" });
    expect(l.color).toMatch(/^#[0-9a-f]{6}$/);
    await api(`/accounts/${acct.id}/labels`, { body: { name: "Work", color: "#16a34a" } });
    expect((await api<any[]>(`/accounts/${acct.id}/labels`)).map((x) => x.slug)).toEqual(["big-client", "work"]);
    expect((await apiRaw(`/accounts/${acct.id}/labels`, { body: { name: "!!!" } })).status).toBe(400);
  });
  it("labels messages with an IMAP keyword other clients keep, and shows it on the message", async () => {
    const m = await find(inbox, "Label me");
    await bulk({ action: "label", label: "work", messageIds: [m.id] });
    expect((await find(inbox, "Label me")).labels).toEqual(["work"]);
    expect(await flagsOnServer("INBOX", "Label me")).toContain("$ncl_work");
  });
  it("finds labelled mail across folders with label:", async () => {
    const hits = (await api<any>(`/accounts/${acct.id}/search?q=${encodeURIComponent("label:work")}&scope=all`)).items;
    expect(hits.map((h: any) => h.subject)).toEqual(["Label me"]);
    expect((await api<any>(`/accounts/${acct.id}/search?q=${encodeURIComponent('label:"Big Client"')}&scope=all`)).items).toEqual([]);
  });
  it("removes a label from messages", async () => {
    const m = await find(inbox, "Label me");
    await bulk({ action: "unlabel", label: "work", messageIds: [m.id] });
    expect((await find(inbox, "Label me")).labels).toEqual([]);
    expect(await flagsOnServer("INBOX", "Label me")).not.toContain("$ncl_work");
  });
  it("renames and deletes labels", async () => {
    expect((await api<any>(`/accounts/${acct.id}/labels/work`, { method: "PATCH", body: { name: "Job", color: "#2563eb" } }))).toMatchObject({ slug: "work", name: "Job" });
    await api(`/accounts/${acct.id}/labels/work`, { method: "DELETE" });
    expect((await api<any[]>(`/accounts/${acct.id}/labels`)).map((x) => x.slug)).toEqual(["big-client"]);
  });
});

describe("saved searches", () => {
  it("saves, lists and deletes named searches", async () => {
    const s = await api<any>(`/accounts/${acct.id}/saved-searches`, { body: { name: "Unread with files", query: "is:unread has:attachment" } });
    expect((await api<any[]>(`/accounts/${acct.id}/saved-searches`)).map((x) => x.name)).toEqual(["Unread with files"]);
    await api(`/accounts/${acct.id}/saved-searches/${s.id}`, { method: "DELETE" });
    expect(await api<any[]>(`/accounts/${acct.id}/saved-searches`)).toEqual([]);
    expect((await apiRaw(`/accounts/${acct.id}/saved-searches`, { body: { name: "", query: "x" } })).status).toBe(400);
  });
});

describe("send later", () => {
  const send = (body: Record<string, unknown>) => api<any>(`/accounts/${acct.id}/send`, { body: { to: ["later@example.org"], text: "hello", ...body } });
  it("holds a message until the chosen time, then sends it", async () => {
    const r = await send({ subject: "Scheduled soon", sendAt: new Date(Date.now() + 3000).toISOString() });
    expect(r.queued).toBe(true);
    expect((await mailpit.recent()).find((x) => x.Subject === "Scheduled soon")).toBeUndefined();
    const m = await mailpit.bySubject("Scheduled soon");
    expect(m.To[0].Address).toBe("later@example.org");
  });
  it("lists far-off messages as scheduled, and they can be cancelled", async () => {
    const r = await send({ subject: "Scheduled tomorrow", sendAt: new Date(Date.now() + 86400_000).toISOString() });
    expect(r.scheduled).toBe(true);
    const o = (await api<any[]>("/outbox")).find((x) => x.id === r.outboxId);
    expect(o).toMatchObject({ scheduled: true, status: "pending", subject: "Scheduled tomorrow" });
    await api(`/outbox/${r.outboxId}/cancel`, { method: "POST" });
    expect((await api<any[]>("/outbox")).find((x) => x.id === r.outboxId)).toBeUndefined();
  });
  it("refuses more than a year ahead", async () => {
    expect((await apiRaw(`/accounts/${acct.id}/send`, { body: { to: ["x@example.org"], text: "x", subject: "far", sendAt: new Date(Date.now() + 400 * 86400_000).toISOString() } })).status).toBe(400);
  });
});

describe("source and attachments", () => {
  let id = "", atts: any[] = [];
  beforeAll(async () => { const m = await find(inbox, "With files"); id = m.id; atts = (await api<any>(`/messages/${id}`)).attachments; });
  it("shows every header and the source, and offers an .eml download", async () => {
    const s = await api<any>(`/messages/${id}/source`);
    expect(s.headers.find((h: any) => h.name.toLowerCase() === "subject").value).toBe("With files");
    expect(s.source).toContain("Content-Type: multipart/mixed");
    const dl = await fetch(`${API_URL}/api/messages/${id}/source?download=1`);
    expect(dl.headers.get("content-type")).toBe("message/rfc822");
    expect(dl.headers.get("content-disposition")).toContain(".eml");
  });
  it("previews images and text inline, with a locked-down policy", async () => {
    const png = atts.find((a) => a.filename === "pic.png");
    const r = await fetch(`${API_URL}/api/messages/${id}/attachments/${png.idx}?inline=1`);
    expect(r.headers.get("content-disposition")).toMatch(/^inline/);
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    const txt = atts.find((a) => a.filename === "notes.txt");
    const t = await fetch(`${API_URL}/api/messages/${id}/attachments/${txt.idx}?inline=1`);
    expect(t.headers.get("content-type")).toContain("text/plain");
    expect(await t.text()).toBe("plain notes");
  });
  it("never shows active content inline (SVG, HTML): it downloads instead", async () => {
    for (const name of ["evil.svg", "page.html"]) {
      const a = atts.find((x) => x.filename === name);
      const r = await fetch(`${API_URL}/api/messages/${id}/attachments/${a.idx}?inline=1`);
      expect(r.headers.get("content-disposition"), name).toMatch(/^attachment/);
    }
  });
});
