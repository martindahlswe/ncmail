import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addAccount, api, apiRaw, deliver, mailpit, messages, resetMailbox, syncFolder, user, type Acct } from "./helpers.ts";

// One login that may send as several addresses: me@... is the account, another.test is an extra address on the same server.
const U = user(39);
let acct: Acct;
let mainId = "", otherId = "", homeId = "";
const base = () => `/accounts/${acct.id}/identities`;
const send = (body: Record<string, unknown>) => api(`/accounts/${acct.id}/send`, { body: { to: ["friend@example.org"], text: "x", ...body } });

beforeAll(async () => {
  await resetMailbox(U);
  acct = await addAccount(U);
  mainId = (await api<any[]>(base()))[0].id;
  otherId = (await api(base(), { body: { name: "Me (Another)", email: "me@another.test", replyTo: "replies@another.test" } })).id;
  // an address that contains another one, to catch loose matching
  homeId = (await api(base(), { body: { name: "Home", email: `home${U.split("@")[0]}@example.test` } })).id;
});
afterAll(async () => { if (acct) await api(`/accounts/${acct.id}`, { method: "DELETE" }); });

describe("sender addresses", () => {
  it("keeps a Reply-To address per sender address, and clears it", async () => {
    let list = await api<any[]>(base());
    expect(list.find((i) => i.id === otherId)).toMatchObject({ email: "me@another.test", replyTo: "replies@another.test", isDefault: false });
    expect(list.find((i) => i.id === mainId)).toMatchObject({ replyTo: "", isDefault: true });

    await api(`${base()}/${otherId}`, { method: "PATCH", body: { replyTo: "" } });
    list = await api<any[]>(base());
    expect(list.find((i) => i.id === otherId).replyTo).toBe("");
    await api(`${base()}/${otherId}`, { method: "PATCH", body: { replyTo: "replies@another.test" } });
  });

  it("refuses a Reply-To that is not an address", async () => {
    expect((await apiRaw(`${base()}/${otherId}`, { method: "PATCH", body: { replyTo: "not an address" } })).status).toBe(400);
    expect((await apiRaw(base(), { body: { name: "X", email: "x@another.test", replyTo: "nope" } })).status).toBe(400);
  });

  it("makes another address the default, which new mail is sent from", async () => {
    await api(`${base()}/${otherId}`, { method: "PATCH", body: { isDefault: true } });
    const list = await api<any[]>(base());
    expect(list.filter((i) => i.isDefault).map((i) => i.id)).toEqual([otherId]);
    expect(list[0].id).toBe(otherId); // the default comes first
    expect((await api<any[]>("/accounts")).find((a) => a.id === acct.id).identities[0].id).toBe(otherId);

    await send({ subject: "Identity default send" }); // no identityId: the default
    const m = await mailpit.bySubject("Identity default send");
    expect(m.From).toMatchObject({ Name: "Me (Another)", Address: "me@another.test" });

    await api(`${base()}/${mainId}`, { method: "PATCH", body: { isDefault: true } });
    expect((await api<any[]>(base())).filter((i) => i.isDefault).map((i) => i.id)).toEqual([mainId]);
  });
});

describe("sending as another address", () => {
  it("puts that address in From and the envelope, with its Reply-To", async () => {
    await send({ subject: "Identity alias send", identityId: otherId });
    const m = await mailpit.bySubject("Identity alias send");
    expect(m.From).toMatchObject({ Name: "Me (Another)", Address: "me@another.test" });
    expect(m.ReplyTo.map((r: any) => r.Address)).toEqual(["replies@another.test"]);
    expect(m.ReturnPath).toBe("me@another.test"); // the SMTP envelope sender
  });

  it("sends no Reply-To when none is set, so replies come back to the From address", async () => {
    await send({ subject: "Identity main send", identityId: mainId });
    const m = await mailpit.bySubject("Identity main send");
    expect(m.From.Address).toBe(U);
    expect(m.ReplyTo).toEqual([]);
    expect((await mailpit.headers(m.ID))["Reply-To"]).toBeUndefined();
  });

  it("reopens a draft with the exact sender address it was written from", async () => {
    const drafts = await acct.folder("Drafts");
    await api(`/accounts/${acct.id}/drafts`, { body: { identityId: homeId, to: ["a@example.org"], subject: "Identity draft home" } });
    await api(`/accounts/${acct.id}/drafts`, { body: { identityId: otherId, to: ["a@example.org"], subject: "Identity draft other" } });
    await syncFolder(drafts.id);
    const rows = await messages(drafts.id);
    const byId = async (subject: string) => (await api(`/messages/${rows.find((r: any) => r.subject === subject).id}/draft`)).identityId;
    expect(await byId("Identity draft home")).toBe(homeId); // not the main address, which it contains
    expect(await byId("Identity draft other")).toBe(otherId);
  });
});

describe("knowing which address a message reached", () => {
  it("reports the Delivered-To and X-Original-To addresses", async () => {
    await deliver(U, "INBOX", { subject: "Identity bcc'd", to: "list@example.org",
      headers: { "Delivered-To": "me@another.test", "X-Original-To": "Me <ME@another.test>" } });
    await deliver(U, "INBOX", { subject: "Identity plain" });
    const inbox = await acct.folder("INBOX");
    await syncFolder(inbox.id);
    const rows = await messages(inbox.id);
    const detail = (s: string) => api(`/messages/${rows.find((r: any) => r.subject === s).id}`);
    expect((await detail("Identity bcc'd")).deliveredTo).toEqual(["me@another.test"]);
    expect((await detail("Identity plain")).deliveredTo).toEqual([]);
  });
});

describe("a signature entered as HTML", () => {
  const pasted = `<table cellpadding="0" style="border-collapse:collapse;font-family:Arial"><tr>
    <td style="padding-right:12px"><img src="https://example.org/logo.png" width="64" alt="Logo" onerror="alert(1)"></td>
    <td><b style="color:#0b5394">Ada Lovelace</b><br><a href="mailto:ada@example.org">ada@example.org</a> · <a href="javascript:alert(1)">bad</a>
      <div style="background:url(https://tracker.example/p.gif)">tracked</div></td></tr></table><script>alert(2)</script><form><input></form>`;

  it("keeps the layout and the flag, and removes what could run or reach out", async () => {
    const saved = await api(`${base()}/${otherId}`, { method: "PATCH", body: { signatureHtml: pasted, signatureIsHtml: true } });
    expect(saved.signatureIsHtml).toBe(true);
    const h: string = saved.signatureHtml;
    expect(h).toContain('<table cellpadding="0" style="border-collapse:collapse;font-family:Arial">');
    expect(h).toContain('<img src="https://example.org/logo.png" width="64" alt="Logo" />');
    expect(h).toContain('<b style="color:#0b5394">Ada Lovelace</b>');
    expect(h).toContain('<a href="mailto:ada@example.org">');
    for (const bad of ["onerror", "javascript:", "<script", "alert(2)", "<form", "<input", "url("]) expect(h).not.toContain(bad);
    expect(h).toContain("tracked"); // the text stays, its style that loads something does not
  });

  it("sends it as it is", async () => {
    await send({ identityId: otherId, subject: "HTML signature", html: `<p>Hello</p><div data-signature="html">${(await api<any[]>(base())).find((i) => i.id === otherId).signatureHtml}</div>` });
    const html: string = (await mailpit.bySubject("HTML signature")).HTML;
    expect(html).toContain("border-collapse:collapse");
    expect(html).toContain("Ada Lovelace");
  });

  it("goes back to a normal signature", async () => {
    const saved = await api(`${base()}/${otherId}`, { method: "PATCH", body: { signatureHtml: "<p>Ada</p>", signatureIsHtml: false } });
    expect(saved).toMatchObject({ signatureHtml: "<p>Ada</p>", signatureIsHtml: false });
  });
});
