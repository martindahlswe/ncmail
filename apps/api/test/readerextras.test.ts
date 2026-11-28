import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAILPIT_URL, user } from "./env.ts";
import { addAccount, api, apiRaw, deliver, imap, mailpit, messages, resetMailbox, syncFolder, type Acct } from "./helpers.ts";

/** Reader extras: images from allowed senders, forward as attachment, reply to list, read receipts. */
const U = user(23);
let acct: Acct;
let inbox = "", junk = "";
const pass = { "Authentication-Results": "mx.example.test; spf=pass smtp.mailfrom=example.org; dkim=pass header.d=example.org; dmarc=pass header.from=example.org" };
const img = '<p>Hi <img src="https://images.example.org/logo.png"></p>';
const find = async (subject: string, folder = inbox) => (await messages(folder, "&threads=0")).find((m) => m.subject === subject)!;
const read = async (subject: string, folder = inbox) => api(`/messages/${(await find(subject, folder)).id}`);
const flagsOf = (subject: string, box = "INBOX") => imap(U, async (c) => {
  const lock = await c.getMailboxLock(box, { readOnly: true });
  try {
    const [uid] = (await c.search({ subject }, { uid: true })) || [];
    for await (const m of c.fetch(String(uid), { flags: true }, { uid: true })) return [...(m.flags ?? [])];
    return [];
  } finally { lock.release(); }
});

beforeAll(async () => {
  await resetMailbox(U);
  await deliver(U, "INBOX", [
    { subject: "RX list mail", from: "Dev list <dev@lists.example.org>", html: img, headers: { ...pass, "List-Post": "<mailto:dev@lists.example.org?subject=x>", "List-Id": "<dev.lists.example.org>" } },
    { subject: "RX forged", from: "Bank <alerts@example.org>", html: img, headers: { "Authentication-Results": "mx.example.test; spf=fail smtp.mailfrom=example.org; dkim=none; dmarc=fail header.from=example.org" } },
    { subject: "RX receipt please", from: "Ann <ann@example.org>", text: "Did you get this?", messageId: "<rx-receipt@example.org>",
      headers: { "Disposition-Notification-To": "Ann <ann@example.org>", "Return-Path": "<ann@example.org>" } },
    { subject: "RX receipt decline", from: "Ann <ann@example.org>", text: "And this?", headers: { "Disposition-Notification-To": "ann@example.org", "Return-Path": "<ann@example.org>" } },
    { subject: "RX receipt elsewhere", from: "Ann <ann@example.org>", text: "x", headers: { "Disposition-Notification-To": "collector@elsewhere.example", "Return-Path": "<ann@example.org>" } },
    { subject: "RX forward me", from: "Bob <bob@example.org>", text: "The original text", attachments: [{ filename: "notes.txt", content: "notes" }] },
  ]);
  await deliver(U, "Junk", [
    { subject: "RX junk", from: "Ann <ann@example.org>", html: img, headers: { ...pass, "Disposition-Notification-To": "ann@example.org", "Return-Path": "<ann@example.org>" } },
  ]);
  acct = await addAccount(U);
  inbox = (await acct.folder("INBOX")).id;
  junk = (await acct.folder("Junk")).id;
  await syncFolder(inbox);
  await syncFolder(junk);
});
afterAll(async () => {
  await api("/prefs", { method: "PATCH", body: { readReceipts: "ask" } }).catch(() => {});
  for (const s of ["ann@example.org", "@lists.example.org"]) await api(`/image-senders/${encodeURIComponent(s)}`, { method: "DELETE" }).catch(() => {});
  if (acct) await api(`/accounts/${acct.id}`, { method: "DELETE" });
});

describe("images from allowed senders", () => {
  it("keeps a list per person that can be added to and removed from", async () => {
    expect((await apiRaw("/image-senders", { body: { sender: "not an address" } })).status).toBe(400);
    await api("/image-senders", { body: { sender: "Ann@Example.org" } });
    await api("/image-senders", { body: { sender: "@lists.example.org" } });
    await api("/image-senders", { body: { sender: "ann@example.org" } }); // twice is fine
    const list = await api<string[]>("/image-senders");
    expect(list).toEqual(expect.arrayContaining(["ann@example.org", "@lists.example.org"]));
    expect(list.filter((s) => s === "ann@example.org")).toHaveLength(1);
    await api(`/image-senders/${encodeURIComponent("@lists.example.org")}`, { method: "DELETE" });
    expect(await api<string[]>("/image-senders")).not.toContain("@lists.example.org");
  });

  it("applies only to mail that passed the sender checks and is not in Junk", async () => {
    expect((await read("RX list mail")).imagesTrustable).toBe(true);
    expect((await read("RX forged")).imagesTrustable).toBe(false);
    expect((await read("RX junk", junk)).imagesTrustable).toBe(false);
  });
});

describe("reply to list", () => {
  it("exposes the list's posting address", async () => {
    expect((await read("RX list mail")).listPost).toBe("dev@lists.example.org");
    expect((await read("RX forged")).listPost).toBeNull();
  });
});

describe("forward as attachment", () => {
  it("attaches the original message from the mail server as a .eml file", async () => {
    const orig = await find("RX forward me");
    await api(`/accounts/${acct.id}/send`, { body: { to: ["friend@example.net"], subject: "RX fwd as attachment", text: "See the attached message.", attachments: [{ messageId: orig.id }] } });
    const m = await mailpit.bySubject("RX fwd as attachment");
    const att = m.Attachments.find((a: any) => a.ContentType === "message/rfc822");
    expect(att?.FileName).toBe("RX forward me.eml");
    expect(await (await fetch(`${MAILPIT_URL}/api/v1/message/${m.ID}/raw`)).text()).toContain("The original text");
  });

  it("refuses a message that is not there, and the same message twice", async () => {
    expect((await apiRaw(`/accounts/${acct.id}/send`, { body: { to: ["friend@example.net"], subject: "x", attachments: [{ messageId: "999999999" }] } })).status).toBe(400);
    const orig = await find("RX forward me");
    expect((await apiRaw(`/accounts/${acct.id}/send`, { body: { to: ["friend@example.net"], subject: "x", attachments: [{ messageId: orig.id }, { messageId: orig.id }] } })).status).toBe(400);
  });
});

describe("read receipts", () => {
  it("offers an answer only when the receipt goes to the envelope sender's domain, and never in Junk", async () => {
    expect((await read("RX receipt please")).receiptTo).toBe("ann@example.org");
    expect((await read("RX receipt elsewhere")).receiptTo).toBeNull();
    expect((await read("RX junk", junk)).receiptTo).toBeNull();
    expect((await read("RX list mail")).receiptTo).toBeNull();
  });

  it("sends a proper receipt and does not ask again", async () => {
    const id = (await find("RX receipt please")).id;
    expect(await api(`/messages/${id}/receipt`, { body: { send: true } })).toEqual({ ok: true, sent: true });
    const m = await mailpit.bySubject("Read: RX receipt please");
    expect(m.To.map((t: any) => t.Address)).toEqual(["ann@example.org"]);
    const h = await mailpit.headers(m.ID);
    expect(h["Content-Type"]![0]).toMatch(/multipart\/report;\s*report-type=disposition-notification/);
    expect(h["In-Reply-To"]![0]).toBe("<rx-receipt@example.org>");
    expect(await flagsOf("RX receipt please")).toContain("$MDNSent");
    expect((await api(`/messages/${id}`)).receiptTo).toBeNull();
    expect((await apiRaw(`/messages/${id}/receipt`, { body: { send: true } })).status).toBe(400);
  });

  it("remembers a declined request without sending anything", async () => {
    const id = (await find("RX receipt decline")).id;
    expect(await api(`/messages/${id}/receipt`, { body: { send: false } })).toEqual({ ok: true, sent: false });
    expect(await flagsOf("RX receipt decline")).toContain("$MDNSent");
    expect((await api(`/messages/${id}`)).receiptTo).toBeNull();
    expect((await mailpit.recent()).some((x) => x.Subject === "Read: RX receipt decline")).toBe(false);
  });

  it("sends none when switched off in the settings", async () => {
    expect(await api("/prefs", { method: "PATCH", body: { readReceipts: "never" } })).toMatchObject({ readReceipts: "never" });
    expect((await api("/prefs")).readReceipts).toBe("never");
    expect((await apiRaw("/prefs", { method: "PATCH", body: { readReceipts: "always" } })).status).toBe(400);
    // a fresh request (the earlier ones are answered)
    await deliver(U, "INBOX", { subject: "RX receipt off", from: "Ann <ann@example.org>", text: "x", headers: { "Disposition-Notification-To": "ann@example.org", "Return-Path": "<ann@example.org>" } });
    await syncFolder(inbox);
    const id = (await find("RX receipt off")).id;
    expect((await apiRaw(`/messages/${id}/receipt`, { body: { send: true } })).status).toBe(400);
    await api("/prefs", { method: "PATCH", body: { readReceipts: "ask" } });
  });
});
