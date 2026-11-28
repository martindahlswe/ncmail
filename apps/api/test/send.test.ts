import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_URL, user } from "./env.ts";
import { addAccount, api, apiRaw, imap, mailboxStatus, mailpit, messages, resetMailbox, syncFolder, waitFor, type Acct } from "./helpers.ts";

const U = user(16);
let acct: Acct;
let defaultId = "", workId = "";
const send = (body: Record<string, unknown>) => api(`/accounts/${acct.id}/send`, { body: { to: ["friend@example.org"], text: "", ...body } });
const b64 = (s: string) => Buffer.from(s).toString("base64");
const lf = (s: string) => s.replace(/\r\n/g, "\n"); // SMTP text parts use CRLF

beforeAll(async () => {
  await resetMailbox(U);
  acct = await addAccount(U);
  const list = await api<any[]>(`/accounts/${acct.id}/identities`);
  defaultId = list[0].id;
  const work = await api(`/accounts/${acct.id}/identities`, { body: {
    name: "Dev (Work)", email: "work@example.test",
    signatureHtml: "<p><strong>Dev Team</strong></p><p>Platform Engineering</p>", signatureText: "Dev Team | Platform Engineering",
  } });
  workId = work.id;
  await syncFolder((await acct.folder("Drafts")).id);
});
afterAll(async () => { if (acct) await api(`/accounts/${acct.id}`, { method: "DELETE" }); });

describe("sending", () => {
  it("delivers plain text mail from the default sender with recipients and a copy in Sent", async () => {
    await send({ subject: "Plain send", text: "Hello there", cc: ["cc@example.org"] });
    const m = await mailpit.bySubject("Plain send");
    expect(m.From.Address).toBe(U);
    expect(m.To.map((t: any) => t.Address)).toEqual(["friend@example.org"]);
    expect(m.Cc.map((t: any) => t.Address)).toEqual(["cc@example.org"]);
    expect(lf(m.Text).trim()).toBe("Hello there");
    await waitFor(async () => (await mailboxStatus(U, "Sent")).messages >= 1, { what: "copy in the Sent folder" });
  });

  it("delivers to Bcc recipients without exposing them", async () => {
    await send({ subject: "Bcc send", text: "x", bcc: ["hidden@example.org"] });
    const m = await mailpit.bySubject("Bcc send");
    expect(m.Bcc.map((t: any) => t.Address)).toEqual(["hidden@example.org"]); // delivered to
    expect(m.To.map((t: any) => t.Address)).toEqual(["friend@example.org"]); // the visible recipients do not include the Bcc one
    // (Mailpit itself adds a Bcc header to its stored copy; the unit tests check our own message headers.)
  });

  it("sends HTML with a generated plain-text alternative", async () => {
    await send({ subject: "Rich send", html: '<p>See <a href="https://example.com/docs">the docs</a> and <strong>bold</strong></p>' });
    const m = await mailpit.bySubject("Rich send");
    expect(m.HTML).toContain("<strong>bold</strong>");
    expect(m.Text).toContain("https://example.com/docs");
    expect((await mailpit.headers(m.ID))["Content-Type"][0]).toMatch(/multipart\/alternative/);
  });

  it("attaches files", async () => {
    await send({ subject: "With file", text: "see attached", attachments: [{ filename: "hello.txt", contentBase64: b64("hello world") }] });
    const m = await mailpit.bySubject("With file");
    expect(m.Attachments.map((a: any) => a.FileName)).toEqual(["hello.txt"]);
  });

  it("keeps the threading headers of a reply", async () => {
    await send({ subject: "Re: Something", text: "ok", inReplyTo: "<orig@example.org>", references: ["<root@example.org>", "<orig@example.org>"] });
    const h = await mailpit.headers((await mailpit.bySubject("Re: Something")).ID);
    expect(h["In-Reply-To"]).toEqual(["<orig@example.org>"]);
    expect(h["References"][0]).toContain("<root@example.org>");
  });

  it("sends as a chosen sender address, and refuses one that is not the account's", async () => {
    await send({ subject: "As work", text: "x", identityId: workId });
    const m = await mailpit.bySubject("As work");
    expect(m.From).toMatchObject({ Name: "Dev (Work)", Address: "work@example.test" });
    expect((await apiRaw(`/accounts/${acct.id}/send`, { body: { to: ["a@b.org"], identityId: "00000000-0000-0000-0000-000000000000" } })).status).toBe(400);
  });

  it("requires at least one valid recipient", async () => {
    expect((await apiRaw(`/accounts/${acct.id}/send`, { body: { to: [], text: "x" } })).status).toBe(400);
  });
});

describe("signatures in the plain-text part", () => {
  const sigDiv = '<div data-signature="true"><p><strong>Dev Team</strong></p><p>Platform Engineering</p></div>';

  it("uses the configured plain-text signature when the signature is unchanged", async () => {
    await send({ subject: "Sig configured", identityId: workId, html: `<p>Body</p>${sigDiv}` });
    expect(lf((await mailpit.bySubject("Sig configured")).Text).trim()).toBe("Body\n\n-- \nDev Team | Platform Engineering");
  });

  it("mirrors a signature the sender edited", async () => {
    await send({ subject: "Sig edited", identityId: workId, html: '<p>Body</p><div data-signature="true"><p>Dev Team</p><p>Edited here</p></div>' });
    const t = (await mailpit.bySubject("Sig edited")).Text;
    expect(t).toContain("Edited here");
    expect(t).not.toContain("Platform Engineering");
  });

  it("leaves no signature when the block was removed", async () => {
    await send({ subject: "Sig removed", identityId: workId, html: "<p>Just the body</p>" });
    expect(lf((await mailpit.bySubject("Sig removed")).Text).trim()).toBe("Just the body");
  });
});

describe("drafts", () => {
  const draft = (over: Record<string, unknown> = {}) => api(`/accounts/${acct.id}/drafts`, { body: {
    identityId: defaultId, to: ["a@example.org"], bcc: ["secret@example.org"], cc: ["c@example.org"], subject: "Draft one",
    text: "first", html: "<p>first <strong>version</strong></p>", inReplyTo: "<orig@x>", references: ["<orig@x>"],
    attachments: [{ filename: "a.txt", contentBase64: b64("hello") }], ...over,
  } });
  const draftsOnServer = () => imap(U, async (c) => {
    const lock = await c.getMailboxLock("Drafts");
    try {
      const out: { uid: number; flags: string[]; subject: string }[] = [];
      if ((c.mailbox as any).exists > 0) {
        for await (const m of c.fetch("1:*", { uid: true, flags: true, envelope: true })) out.push({ uid: m.uid, flags: [...m.flags], subject: m.envelope.subject });
      }
      return out;
    } finally { lock.release(); }
  });
  let uid1 = 0, uid2 = 0;

  it("saves to the server's Drafts folder flagged as a draft", async () => {
    uid1 = (await draft()).uid;
    expect(uid1).toBeGreaterThan(0);
    const onServer = await draftsOnServer();
    expect(onServer).toHaveLength(1);
    expect(onServer[0]!.flags).toContain("\\Draft");
  });

  it("replaces the previous version instead of piling up copies", async () => {
    uid2 = (await draft({ subject: "Draft one (v2)", html: "<p>second</p>", replacesUid: uid1 })).uid;
    expect(uid2).not.toBe(uid1);
    const onServer = await draftsOnServer();
    expect(onServer.map((d) => d.subject)).toEqual(["Draft one (v2)"]);
  });

  it("reopens with recipients, Bcc, formatting, threading headers and attachments intact", async () => {
    const drafts = await acct.folder("Drafts");
    await syncFolder(drafts.id);
    const [row] = await messages(drafts.id);
    const d = await api(`/messages/${row.id}/draft`);
    expect(d).toMatchObject({ to: "a@example.org", cc: "c@example.org", bcc: "secret@example.org", subject: "Draft one (v2)", identityId: defaultId, inReplyTo: "<orig@x>" });
    expect(d.html).toContain("second");
    // attachments come back as server-side uploads (never as base64 through the browser)
    expect(d.attachments).toHaveLength(1);
    expect(d.attachments[0]).toMatchObject({ filename: "a.txt", size: 5 });
    expect(await (await fetch(`${API_URL}/api/uploads/${d.attachments[0].id}`)).text()).toBe("hello");
  });

  it("is removed from the server when it is sent", async () => {
    await send({ subject: "Draft one (v2)", text: "second", draftUid: uid2 });
    await mailpit.bySubject("Draft one (v2)");
    expect(await draftsOnServer()).toHaveLength(0);
  });

  it("can be discarded", async () => {
    const { uid } = await draft({ subject: "Throwaway" });
    expect(await draftsOnServer()).toHaveLength(1);
    await api(`/accounts/${acct.id}/drafts/${uid}`, { method: "DELETE" });
    expect(await draftsOnServer()).toHaveLength(0);
  });
});
