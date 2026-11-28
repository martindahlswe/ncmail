import { afterAll, describe, expect, it } from "vitest";
import { api, apiRaw } from "./helpers.ts";
import { IMAP_HOST, IMAP_PORT, SMTP_PORT, TEST_PASSWORD, user } from "./env.ts";

const U = user(11);
const srv = (port: number, pw = TEST_PASSWORD, host = IMAP_HOST) => ({ host, port, security: "none", username: U, password: pw });
const account = (over: Record<string, unknown> = {}) => ({ name: "Acct", email: U, imap: srv(IMAP_PORT), smtp: srv(SMTP_PORT), ...over });

describe("connection test", () => {
  it("logs in to IMAP and SMTP and reports server capabilities", async () => {
    const r = await api("/accounts/test", { body: { imap: srv(IMAP_PORT), smtp: srv(SMTP_PORT) } });
    expect(r.imap.ok).toBe(true);
    expect(r.imap.capabilities).toMatchObject({ condstore: true, idle: true, move: true });
    expect(r.smtp.ok).toBe(true);
  });

  it("reports a wrong IMAP password with a message", async () => {
    const r = await api("/accounts/test", { body: { imap: srv(IMAP_PORT, "wrong"), smtp: srv(SMTP_PORT) } });
    expect(r.imap.ok).toBe(false);
    expect(r.imap.error).toBeTruthy();
    expect(r.smtp.ok).toBe(true); // each side is reported on its own
  });

  it("reports an unreachable SMTP server", async () => {
    const r = await api("/accounts/test", { body: { imap: srv(IMAP_PORT), smtp: srv(1) } });
    expect(r.imap.ok).toBe(true);
    expect(r.smtp.ok).toBe(false);
    expect(r.smtp.error).toMatch(/ECONNREFUSED/);
  });

  it("refuses to test without a password and without a stored account to borrow it from", async () => {
    const r = await apiRaw("/accounts/test", { body: { imap: srv(IMAP_PORT, ""), smtp: srv(SMTP_PORT, "") } });
    expect(r.status).toBe(400);
  });
});

describe("account lifecycle", () => {
  let id = "";
  afterAll(async () => { if (id) await api(`/accounts/${id}`, { method: "DELETE" }).catch(() => {}); });

  it("creates an account without ever returning passwords, with a default sender address", async () => {
    const a = await api("/accounts", { body: account() });
    id = a.id;
    expect(JSON.stringify(a)).not.toMatch(/password/i);
    expect(a.identities).toHaveLength(1);
    expect(a.identities[0]).toMatchObject({ email: U, isDefault: true });
    const list = await api<any[]>("/accounts");
    expect(JSON.stringify(list)).not.toMatch(/password/i);
    expect(list.find((x) => x.id === id)).toBeTruthy();
  });

  it("keeps the account label and the name recipients see separate", async () => {
    const b = await api("/accounts", { body: account({ name: "Work label", senderName: "Martin Dahl" }) });
    try {
      expect(b.name).toBe("Work label");
      expect(b.identities[0].name).toBe("Martin Dahl");
      const c = await api("/accounts", { body: account({ name: "Only a label" }) }); // no senderName: falls back to the label
      expect(c.identities[0].name).toBe("Only a label");
      await api(`/accounts/${c.id}`, { method: "DELETE" });
    } finally { await api(`/accounts/${b.id}`, { method: "DELETE" }); }
  });

  it("rejects invalid input with a 400", async () => {
    expect((await apiRaw("/accounts", { body: account({ email: "not-an-email" }) })).status).toBe(400);
  });

  it("edits the name and keeps the stored passwords when they are left blank", async () => {
    const edited = await api(`/accounts/${id}`, { method: "PATCH", body: account({ name: "Renamed", imap: srv(IMAP_PORT, ""), smtp: srv(SMTP_PORT, "") }) });
    expect(edited.name).toBe("Renamed");
    expect(edited.resynced).toBe(false);
    // the stored password still works
    const t = await api("/accounts/test", { body: { accountId: id, imap: srv(IMAP_PORT, ""), smtp: srv(SMTP_PORT, "") } });
    expect(t.imap.ok && t.smtp.ok).toBe(true);
  });

  it("moves the matching sender address when the account email changes", async () => {
    const a = await api(`/accounts/${id}`, { method: "PATCH", body: account({ email: "renamed@example.test", imap: srv(IMAP_PORT, ""), smtp: srv(SMTP_PORT, "") }) });
    expect(a.email).toBe("renamed@example.test");
    expect(a.identities.map((i: any) => i.email)).toEqual(["renamed@example.test"]);
    expect(a.identities[0].isDefault).toBe(true);
  });

  it("folds into an existing sender address instead of duplicating it", async () => {
    await api(`/accounts/${id}/identities`, { body: { name: "Alias", email: "alias@example.test" } });
    const a = await api(`/accounts/${id}`, { method: "PATCH", body: account({ email: "ALIAS@example.test", imap: srv(IMAP_PORT, ""), smtp: srv(SMTP_PORT, "") }) });
    expect(a.identities).toHaveLength(1);
    expect(a.identities[0].email).toBe("alias@example.test");
  });

  it("flags a resync when the IMAP login changes", async () => {
    const a = await api(`/accounts/${id}`, { method: "PATCH", body: account({ imap: { ...srv(IMAP_PORT, TEST_PASSWORD), username: user(12) }, smtp: srv(SMTP_PORT, "") }) });
    expect(a.resynced).toBe(true);
  });

  it("removes the account and everything under it", async () => {
    await api(`/accounts/${id}`, { method: "DELETE" });
    expect((await api<any[]>("/accounts")).some((x) => x.id === id)).toBe(false);
    expect(await api(`/accounts/${id}/folders`)).toEqual([]);
    id = "";
  });
});

describe("sender addresses", () => {
  let id = "";
  afterAll(async () => { if (id) await api(`/accounts/${id}`, { method: "DELETE" }).catch(() => {}); });

  it("supports several addresses with exactly one default", async () => {
    id = (await api("/accounts", { body: account() })).id;
    const added = await api(`/accounts/${id}/identities`, { body: { name: "Work", email: "work@example.test", signatureText: "-- work" } });
    expect(added.isDefault).toBe(false);
    expect(added.signatureText).toBe("-- work");

    await api(`/accounts/${id}/identities/${added.id}`, { method: "PATCH", body: { isDefault: true } });
    const list = await api<any[]>(`/accounts/${id}/identities`);
    expect(list.filter((i) => i.isDefault).map((i) => i.email)).toEqual(["work@example.test"]);
  });

  it("rejects a duplicate address regardless of case", async () => {
    const r = await apiRaw(`/accounts/${id}/identities`, { body: { name: "Dup", email: "WORK@example.test" } });
    expect(r.status).toBe(409);
  });

  it("hands the default to another address when the default is removed, and keeps at least one", async () => {
    const list = await api<any[]>(`/accounts/${id}/identities`);
    const def = list.find((i) => i.isDefault);
    await api(`/accounts/${id}/identities/${def.id}`, { method: "DELETE" });
    const after = await api<any[]>(`/accounts/${id}/identities`);
    expect(after).toHaveLength(1);
    expect(after[0].isDefault).toBe(true);
    expect((await apiRaw(`/accounts/${id}/identities/${after[0].id}`, { method: "DELETE" })).status).toBe(400);
  });

  it("stores rich and plain signatures per address", async () => {
    const [i] = await api<any[]>(`/accounts/${id}/identities`);
    const upd = await api(`/accounts/${id}/identities/${i.id}`, { method: "PATCH", body: { signatureHtml: "<p><strong>Me</strong></p>", signatureText: "Me" } });
    expect(upd).toMatchObject({ signatureHtml: "<p><strong>Me</strong></p>", signatureText: "Me" });
    const cleared = await api(`/accounts/${i.id ? id : id}/identities/${i.id}`, { method: "PATCH", body: { signatureHtml: "", signatureText: "" } });
    expect(cleared).toMatchObject({ signatureHtml: "", signatureText: "" });
  });
});
