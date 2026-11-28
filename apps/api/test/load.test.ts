import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IMAP_HOST, IMAP_PORT, SMTP_PORT, TEST_PASSWORD, user } from "./env.ts";
import { addAccount, api, deliver, imap, messages, resetMailbox, waitFor, type Acct } from "./helpers.ts";
import { startApi } from "./server.ts";

const U = user(18);
const EXTRA = 70; // more folders than the per-cycle STATUS budget (60)

async function seedFolders() {
  await resetMailbox(U);
  await imap(U, async (c) => { for (let i = 0; i < EXTRA; i++) await c.mailboxCreate(`Bulk/F${String(i).padStart(2, "0")}`); });
  for (let i = 0; i < EXTRA; i++) await deliver(U, `Bulk/F${String(i).padStart(2, "0")}`, { subject: `in folder ${i}` });
  await deliver(U, "INBOX", [{ subject: "a" }, { subject: "b", seen: true }, { subject: "c" }]);
  await deliver(U, "Archive", [{ subject: "x", seen: true }, { subject: "y", seen: true }]);
}
const withCounts = (folders: any[]) => folders.filter((f) => f.path.startsWith("Bulk/") && f.total > 0).length;

describe("background refresh", () => {
  let acct: Acct;
  beforeAll(async () => { await resetMailbox(U); acct = await addAccount(U); });
  afterAll(async () => { if (acct) await api(`/accounts/${acct.id}`, { method: "DELETE" }); });

  it("also keeps Sent and Drafts current, which IDLE (INBOX only) does not cover", async () => {
    const sent = await acct.folder("Sent");
    await deliver(U, "Sent", { subject: "Sent from another client", seen: true });
    await waitFor(async () => (await messages(sent.id)).some((m) => m.subject === "Sent from another client"), { timeout: 25_000, what: "Sent to be refreshed in the background" });
    const drafts = await acct.folder("Drafts");
    await deliver(U, "Drafts", { subject: "Draft from another client", seen: true });
    await waitFor(async () => (await messages(drafts.id)).some((m) => m.subject === "Draft from another client"), { timeout: 25_000, what: "Drafts to be refreshed in the background" });
  });
});

describe("folder counts on a server with LIST-STATUS (one command)", () => {
  let acct: Acct;
  beforeAll(async () => { await seedFolders(); acct = await addAccount(U); });
  afterAll(async () => { if (acct) await api(`/accounts/${acct.id}`, { method: "DELETE" }); });

  it("has the counts of every folder after a single sync", async () => {
    const folders = await waitFor(async () => { const f = await acct.folders(); return withCounts(f) === EXTRA ? f : false; }, { what: "all folder counts" });
    expect(folders.find((f) => f.name === "Archive")).toMatchObject({ total: 2, unseen: 0 });
    expect(folders.find((f) => f.name === "INBOX")).toMatchObject({ total: 3, unseen: 2 });
  });
});

describe("folder counts on a server WITHOUT LIST-STATUS (one STATUS per folder)", () => {
  let server: Awaited<ReturnType<typeof startApi>>;
  let id = "";
  const call = async (path: string, body?: unknown) => {
    const r = await fetch(`${server.url}/api${path}`, body !== undefined ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
    return r.json();
  };
  const folders = () => call(`/accounts/${id}/folders`) as Promise<any[]>;

  beforeAll(async () => {
    await seedFolders();
    server = await startApi(4102, { NCMAIL_NO_LIST_STATUS: "1", NCMAIL_STATUS_BUDGET: "16", NCMAIL_BG_TICK_MS: "3600000" }, "ncmail_fallback"); // own database; no background cycles, we drive them by hand
    const srv = (port: number) => ({ host: IMAP_HOST, port, security: "none", username: U, password: TEST_PASSWORD });
    id = (await call("/accounts", { name: "Fallback", email: U, imap: srv(IMAP_PORT), smtp: srv(SMTP_PORT) })).id;
    await call(`/accounts/${id}/sync`, {});
    await waitFor(async () => (await folders()).length > EXTRA, { what: "folder list" });
  });
  afterAll(async () => {
    if (id) await fetch(`${server.url}/api/accounts/${id}`, { method: "DELETE" });
    await server?.stop();
  });

  it("still reports correct counts for the INBOX and special folders every cycle", async () => {
    const f = await waitFor(async () => { const x = await folders(); return x.find((y) => y.name === "Archive")?.total === 2 ? x : false; }, { what: "special-folder counts" });
    expect(f.find((y) => y.name === "INBOX")).toMatchObject({ total: 3, unseen: 2 });
    expect(f.find((y) => y.name === "Archive")).toMatchObject({ total: 2, unseen: 0 });
  });

  it("spreads the rest over cycles instead of asking about every folder at once", async () => {
    // the first cycle's counts arrive just after the folder list (background cycles are off here, so this is one cycle)
    const afterFirst = await waitFor(async () => withCounts(await folders()) || false, { what: "the first cycle's folder counts" });
    expect(afterFirst).toBeGreaterThan(0);
    expect(afterFirst).toBeLessThan(EXTRA); // bounded by the per-cycle budget (16, of which the 6 special folders take their share every time)
    // each further cycle covers the folders checked longest ago, so everything is reached
    for (let i = 0; i < 25 && withCounts(await folders()) < EXTRA; i++) {
      await call(`/accounts/${id}/sync`, {});
      await sleep(500);
    }
    expect(withCounts(await folders())).toBe(EXTRA);
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
