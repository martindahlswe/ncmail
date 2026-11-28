import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { user } from "./env.ts";
import { addAccount, api, apiRaw, mailpit, messages, resetMailbox, syncFolder, type Acct } from "./helpers.ts";

// Pictures in the text, read receipts: what the composer sends and how drafts keep them.
const U = user(25);
let acct: Acct;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const picture = `<img src="data:image/png;base64,${PNG}" alt="dot" width="1">`;

beforeAll(async () => {
  await resetMailbox(U);
  acct = await addAccount(U);
  await syncFolder((await acct.folder("Drafts")).id);
});
afterAll(async () => { if (acct) await api(`/accounts/${acct.id}`, { method: "DELETE" }); });

describe("pictures in the text", () => {
  it("are sent as inline cid parts referenced from the HTML", async () => {
    await api(`/accounts/${acct.id}/send`, { body: { to: ["friend@example.org"], subject: "Inline picture", html: `<p>Look ${picture}</p>` } });
    const m = await mailpit.bySubject("Inline picture");
    expect(m.HTML).toMatch(/src="cid:[^"]+"/);
    expect(m.HTML).not.toContain("data:image");
    expect(m.Inline).toHaveLength(1);
    expect(m.Inline[0].ContentType).toBe("image/png");
    expect(m.Attachments ?? []).toHaveLength(0);
  });

  it("come back in a reopened draft, inside the text and not as attachments", async () => {
    const { uid } = await api(`/accounts/${acct.id}/drafts`, { body: { to: ["a@example.org"], subject: "Picture draft", html: `<p>Draft ${picture}</p>`,
      attachments: [{ filename: "a.txt", contentBase64: Buffer.from("hello").toString("base64") }] } });
    expect(uid).toBeGreaterThan(0);
    const drafts = await acct.folder("Drafts");
    await syncFolder(drafts.id);
    const row = (await messages(drafts.id)).find((r: any) => r.subject === "Picture draft");
    const d = await api(`/messages/${row.id}/draft`);
    expect(d.html).toContain(`data:image/png;base64,${PNG}`);
    expect(d.attachments.map((a: any) => a.filename)).toEqual(["a.txt"]);
    await api(`/accounts/${acct.id}/drafts/${uid}`, { method: "DELETE" });
  });

  it("are refused when the message would get too big", async () => {
    const big = Buffer.alloc(11_000_001, 65).toString("ascii");
    const r = await apiRaw(`/accounts/${acct.id}/send`, { body: { to: ["friend@example.org"], subject: "Too big", html: `<p>${big}</p>` } });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});

describe("read receipts", () => {
  it("asks for one from the sender's address when requested", async () => {
    await api(`/accounts/${acct.id}/send`, { body: { to: ["friend@example.org"], subject: "Receipt please", text: "hi", readReceipt: true } });
    const m = await mailpit.bySubject("Receipt please");
    expect((await mailpit.headers(m.ID))["Disposition-Notification-To"]).toEqual([U]);
  });

  it("does not ask for one otherwise", async () => {
    await api(`/accounts/${acct.id}/send`, { body: { to: ["friend@example.org"], subject: "No receipt", text: "hi" } });
    const m = await mailpit.bySubject("No receipt");
    expect((await mailpit.headers(m.ID))["Disposition-Notification-To"]).toBeUndefined();
  });

  it("keeps the request through undo send", async () => {
    await api(`/accounts/${acct.id}/send`, { body: { to: ["friend@example.org"], subject: "Receipt later", text: "hi", readReceipt: true, delaySeconds: 1 } });
    const m = await mailpit.bySubject("Receipt later");
    expect((await mailpit.headers(m.ID))["Disposition-Notification-To"]).toEqual([U]);
  });

  it("is kept in a draft and reported when it is reopened", async () => {
    const { uid } = await api(`/accounts/${acct.id}/drafts`, { body: { to: ["a@example.org"], subject: "Receipt draft", text: "x", readReceipt: true } });
    const drafts = await acct.folder("Drafts");
    await syncFolder(drafts.id);
    const row = (await messages(drafts.id)).find((r: any) => r.subject === "Receipt draft");
    expect((await api(`/messages/${row.id}/draft`)).readReceipt).toBe(true);
    await api(`/accounts/${acct.id}/drafts/${uid}`, { method: "DELETE" });
  });
});
