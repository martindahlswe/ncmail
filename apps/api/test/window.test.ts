import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IMAP_HOST, IMAP_PORT, SMTP_PORT, TEST_PASSWORD, user } from "./env.ts";
import { api, apiRaw, deliver, imap, messages, resetMailbox, sleep, syncFolder, waitFor } from "./helpers.ts";

/** The first sync only brings in recent mail; older mail is searched on the server, can be loaded, and big imports take turns. */
const U = user(30), U2 = user(29);
const day = (n: number) => new Date(Date.now() - n * 86400_000);
let acct = "", inbox = "";
const server = (u: string) => ({ host: IMAP_HOST, port: IMAP_PORT, security: "none", username: u, password: TEST_PASSWORD });
const create = async (u: string, months: number | null) => {
  const a = await api("/accounts", { body: { name: `Window ${u}`, email: u, imap: server(u), smtp: { ...server(u), port: SMTP_PORT }, syncMonths: months } });
  await api(`/accounts/${a.id}/sync`, { method: "POST" });
  const folders = await waitFor(async () => { const f = await api<any[]>(`/accounts/${a.id}/folders`); return f.some((x) => x.specialUse === "\\Inbox") ? f : false; }, { what: "folders" });
  const id = folders.find((x: any) => x.specialUse === "\\Inbox").id;
  await waitFor(async () => !(await api(`/folders/${id}`)).syncing, { what: "first sync" });
  return { account: a.id as string, inbox: id as string };
};
const folder = (id: string) => api<any>(`/folders/${id}`);

beforeAll(async () => {
  await resetMailbox(U);
  await deliver(U, "INBOX", [
    ...Array.from({ length: 8 }, (_, i) => ({ subject: `recent ${i}`, text: "fresh", date: day(i + 1) })),
    ...Array.from({ length: 12 }, (_, i) => ({ subject: i === 3 ? "old zebra report" : `old ${i}`, text: i === 7 ? "the quokka is hiding in the body" : "stale", date: day(200 + i) })),
  ]);
  ({ account: acct, inbox } = await create(U, 3));
});
afterAll(async () => { if (acct) await api(`/accounts/${acct}`, { method: "DELETE" }); });

describe("the first sync window", () => {
  it("only mirrors recent mail, and says how much is still on the server", async () => {
    const f = await folder(inbox);
    expect((await messages(inbox)).map((m) => m.subject).sort()).toEqual(Array.from({ length: 8 }, (_, i) => `recent ${i}`).sort());
    expect(f).toMatchObject({ total: 20, olderOnServer: 12 });
  });

  it("reports and changes the setting", async () => {
    expect(await api<any>(`/accounts/${acct}/sync-window`)).toMatchObject({ months: 3, default: 0, olderOnServer: 12 });
    expect((await apiRaw(`/accounts/${acct}/sync-window`, { method: "PUT", body: { months: 700 } })).status).toBe(400);
    await api(`/accounts/${acct}/sync-window`, { method: "PUT", body: { months: 3 } });
  });

  it("keeps counts right when mail is deleted on the server, mirrored or not", async () => {
    await imap(U, async (c) => {
      const lock = await c.getMailboxLock("INBOX");
      try {
        for (const subject of ["old 9", "recent 0"]) { const u = await c.search({ subject }, { uid: true }); if (u && u.length) await c.messageDelete(u, { uid: true }); }
      } finally { lock.release(); }
    });
    await syncFolder(inbox);
    const f = await waitFor(async () => { const x = await folder(inbox); return x.total === 18 ? x : false; }, { what: "counts to update" });
    expect(f.olderOnServer).toBe(11); // one older message is gone from the server; none of the mirrored ones were wiped
    const subjects = (await messages(inbox)).map((m) => m.subject);
    expect(subjects).not.toContain("recent 0");
    expect(subjects).toHaveLength(7);
  });
});

describe("search covers all mail", () => {
  it("finds an older message by its subject without it having been loaded", async () => {
    const r = await api<any>(`/accounts/${acct}/search?q=${encodeURIComponent("zebra")}&scope=all`);
    expect(r.items.map((i: any) => i.subject)).toEqual(["old zebra report"]);
    // only the match is brought in (the background sync may already have counted it): the rest stays on the server
    expect((await folder(inbox)).olderOnServer).toBeGreaterThanOrEqual(9);
  });
  it("finds an older message by a word in its body", async () => {
    const r = await api<any>(`/accounts/${acct}/search?q=${encodeURIComponent("quokka")}&scope=all&text=1`);
    expect(r.items.map((i: any) => i.subject)).toContain("old 7");
    expect((await folder(inbox)).olderOnServer).toBeGreaterThanOrEqual(8);
  });
  it("applies operators to older mail too", async () => {
    const r = await api<any>(`/accounts/${acct}/search?q=${encodeURIComponent("subject:old before:2000-01-01")}&scope=all`);
    expect(r.items).toEqual([]);
  });
});

describe("loading older mail", () => {
  it("brings in the next batch, then the rest", async () => {
    const a = await api<any>(`/folders/${inbox}/sync-older`, { body: { count: 100 } });
    expect(a.added).toBe(0 + 100 > 9 ? 9 : 100); // everything that was left fits in one batch of 100
    expect((await folder(inbox)).olderOnServer).toBe(0);
    expect((await messages(inbox))).toHaveLength(7 + 2 + 9);
  });
  it("is a no-op when nothing is left", async () => {
    expect((await api<any>(`/folders/${inbox}/sync-older`, { body: { count: "all" } })).added).toBe(0);
    await syncFolder(inbox);
    expect((await messages(inbox))).toHaveLength(18); // the later sync did not drop what was loaded
  });
});

describe("big imports take turns", () => {
  let second = "", secondInbox = "";
  beforeAll(async () => {
    await resetMailbox(U2);
    await deliver(U2, "INBOX", Array.from({ length: 30 }, (_, i) => ({ subject: `bulk ${i}`, text: "x", date: day(i) })));
  });
  afterAll(async () => { if (second) await api(`/accounts/${second}`, { method: "DELETE" }); });

  it("never runs more than the limit at once, and everything still arrives", async () => {
    const before = await api<any>("/sync/status");
    expect(before.limit).toBe(1);
    // two accounts import 30 messages each (above the "big import" size) at the same moment
    await resetMailbox(U); // (reuse U: refill so both have bulk)
    await deliver(U, "INBOX", Array.from({ length: 30 }, (_, i) => ({ subject: `bulk ${i}`, text: "x", date: day(i) })));
    const [one, two] = await Promise.all([create(U, 0), create(U2, 0)]);
    second = two.account; secondInbox = two.inbox;
    await waitFor(async () => (await messages(one.inbox)).length === 30 && (await messages(secondInbox)).length === 30, { what: "both imports", timeout: 40_000 });
    const after = await api<any>("/sync/status");
    expect(after.peak).toBe(1);
    expect(after.running).toBe(0);
    expect(after.waiting).toBe(0);
    await api(`/accounts/${one.account}`, { method: "DELETE" });
  });
});
