import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { user, IMAP_HOST } from "./env.ts";
import { addAccount, api, apiRaw, deliver, imap, messages, resetMailbox, syncFolder, waitFor, type Acct } from "./helpers.ts";
import { withSieve, type SieveConn } from "../src/sieve/managesieve.ts";
import { readConfig, SCRIPT_NAME } from "../src/sieve/script.ts";

/** Creating, renaming and deleting folders from the app. */
const U = user(24);
let acct: Acct;
const direct: SieveConn = { host: IMAP_HOST, port: 14190, security: "none", username: U, password: "test" };
const serverPaths = () => imap(U, async (c) => (await c.list()).map((e) => e.path));
const byPath = async (p: string) => (await acct.folders()).find((f) => f.path === p);

beforeAll(async () => {
  await resetMailbox(U);
  await withSieve(direct, async (s) => { await s.setActive(""); for (const x of await s.list()) await s.delete(x.name); });
  acct = await addAccount(U);
  await api(`/accounts/${acct.id}/sieve/connection`, { method: "PUT", body: { host: "", port: 14190, security: "none" } }); // the test stack's Sieve port
});
afterAll(async () => { if (acct) await api(`/accounts/${acct.id}`, { method: "DELETE" }); });

describe("creating folders", () => {
  it("creates a folder at the top and one inside it, on the server and in the list right away", async () => {
    const top = await api(`/accounts/${acct.id}/folders`, { body: { name: "Projects" } });
    expect(top).toMatchObject({ path: "Projects", name: "Projects" });
    expect(top.id).toBeTruthy();
    const sub = await api(`/accounts/${acct.id}/folders`, { body: { name: "Alpha", parentId: top.id } });
    expect(sub.path).toBe("Projects/Alpha");
    expect(await serverPaths()).toEqual(expect.arrayContaining(["Projects", "Projects/Alpha"]));
    expect(await byPath("Projects/Alpha")).toMatchObject({ id: sub.id, name: "Alpha", selectable: true });
    // subscribed, so other mail clients show it too
    const subscribed = await imap(U, async (c) => (await c.list()).filter((e) => e.subscribed).map((e) => e.path));
    expect(subscribed).toContain("Projects/Alpha");
  });

  it("refuses duplicates, separators, wildcards and empty names", async () => {
    const top = await byPath("Projects");
    expect((await apiRaw(`/accounts/${acct.id}/folders`, { body: { name: "projects" } })).status).toBe(409);
    expect((await apiRaw(`/accounts/${acct.id}/folders`, { body: { name: "Alpha", parentId: top.id } })).status).toBe(409);
    expect((await apiRaw(`/accounts/${acct.id}/folders`, { body: { name: "a/b" } })).status).toBe(400);
    expect((await apiRaw(`/accounts/${acct.id}/folders`, { body: { name: "a*" } })).status).toBe(400);
    expect((await apiRaw(`/accounts/${acct.id}/folders`, { body: { name: "   " } })).status).toBe(400);
    expect((await apiRaw(`/accounts/${acct.id}/folders`, { body: { name: "inbox" } })).status).toBe(400);
  });

  it("accepts names outside ASCII", async () => {
    const r = await api(`/accounts/${acct.id}/folders`, { body: { name: "Kvitton ✓ å" } });
    expect(await serverPaths()).toContain("Kvitton ✓ å");
    expect((await byPath("Kvitton ✓ å"))?.id).toBe(r.id);
  });
});

describe("renaming folders", () => {
  it("renames a folder with its subfolders and keeps the mirrored mail and folder ids", async () => {
    await deliver(U, "Projects/Alpha", [{ subject: "Spec draft" }, { subject: "Spec final" }]);
    const alpha = await byPath("Projects/Alpha");
    await syncFolder(alpha.id);
    const before = (await messages(alpha.id)).map((m) => m.id).sort();
    expect(before).toHaveLength(2);
    const projects = await byPath("Projects");

    const r = await api(`/folders/${projects.id}`, { method: "PATCH", body: { name: "Work" } });
    expect(r.path).toBe("Work");
    const paths = await serverPaths();
    expect(paths).toEqual(expect.arrayContaining(["Work", "Work/Alpha"]));
    expect(paths).not.toContain("Projects");
    expect(await byPath("Work")).toMatchObject({ id: projects.id, name: "Work" });
    expect(await byPath("Work/Alpha")).toMatchObject({ id: alpha.id, name: "Alpha" });
    expect(await byPath("Projects/Alpha")).toBeUndefined();
    expect((await messages(alpha.id)).map((m) => m.id).sort()).toEqual(before);
    // and the folder still syncs from its new place
    await deliver(U, "Work/Alpha", { subject: "Spec v2" });
    await syncFolder(alpha.id);
    expect((await messages(alpha.id)).map((m) => m.subject)).toContain("Spec v2");
  });

  it("points filters that file into the folder at its new name", async () => {
    const cfg = { rules: [
      { id: "r1", name: "Specs", conditions: [{ field: "subject", op: "contains", value: "spec" }], actions: [{ type: "move", value: "Work/Alpha" }] },
      { id: "r2", name: "Other", conditions: [{ field: "from", op: "contains", value: "x@y" }], actions: [{ type: "move", value: "Workshop" }] },
    ] };
    await api(`/accounts/${acct.id}/sieve`, { method: "PUT", body: cfg });
    const work = await byPath("Work");
    const r = await api(`/folders/${work.id}`, { method: "PATCH", body: { name: "Clients" } });
    expect(r.filtersUpdated).toBe(1);
    const stored = await withSieve(direct, async (s) => readConfig(await s.get(SCRIPT_NAME)));
    expect(stored!.rules.map((x) => x.actions[0]!.value)).toEqual(["Clients/Alpha", "Workshop"]); // "Workshop" only starts with the old name
  });

  it("does not rename Inbox or other special folders, or onto an existing name", async () => {
    const inbox = await byPath("INBOX");
    const sent = (await acct.folders()).find((f) => f.specialUse === "\\Sent");
    expect((await apiRaw(`/folders/${inbox.id}`, { method: "PATCH", body: { name: "Old" } })).status).toBe(400);
    expect((await apiRaw(`/folders/${sent.id}`, { method: "PATCH", body: { name: "Outgoing" } })).status).toBe(400);
    const clients = await byPath("Clients");
    expect((await apiRaw(`/folders/${clients.id}`, { method: "PATCH", body: { name: "Kvitton ✓ å" } })).status).toBe(409);
    expect((await apiRaw(`/folders/${clients.id}`, { method: "PATCH", body: { name: "x/y" } })).status).toBe(400);
  });
});

describe("moving folders", () => {
  it("moves a folder into another one and back to the top, and never into itself", async () => {
    const a = await api(`/accounts/${acct.id}/folders`, { body: { name: "Mover" } });
    const b = await api(`/accounts/${acct.id}/folders`, { body: { name: "Holder" } });
    const c = await api(`/accounts/${acct.id}/folders`, { body: { name: "Child", parentId: a.id } });
    expect((await api(`/folders/${a.id}`, { method: "PATCH", body: { parentId: b.id } })).path).toBe("Holder/Mover");
    expect(await byPath("Holder/Mover/Child")).toMatchObject({ id: c.id });
    expect((await apiRaw(`/folders/${a.id}`, { method: "PATCH", body: { parentId: c.id } })).status).toBe(400);
    expect((await api(`/folders/${a.id}`, { method: "PATCH", body: { parentId: null, name: "Moved" } })).path).toBe("Moved");
    expect(await serverPaths()).toEqual(expect.arrayContaining(["Moved", "Moved/Child", "Holder"]));
    await api(`/folders/${a.id}?permanent=1`, { method: "DELETE" });
    await api(`/folders/${b.id}?permanent=1`, { method: "DELETE" });
  });
});

describe("deleting folders", () => {
  it("moves a folder with its subfolders into Trash, and a second one with the same name beside it", async () => {
    const clients = await byPath("Clients");
    const alpha = await byPath("Clients/Alpha");
    const r = await api(`/folders/${clients.id}`, { method: "DELETE" });
    expect(r).toMatchObject({ movedToTrash: true, path: "Trash/Clients" });
    expect(r.filtersStillUsing).toBe(1); // the "Specs" rule still files into Clients/Alpha: the app says so instead of following it into Trash
    expect(await serverPaths()).toEqual(expect.arrayContaining(["Trash/Clients", "Trash/Clients/Alpha"]));
    expect(await byPath("Trash/Clients/Alpha")).toMatchObject({ id: alpha.id });
    expect((await messages(alpha.id)).length).toBe(3);

    // Undo in the app moves it back to where it was
    await api(`/folders/${clients.id}`, { method: "PATCH", body: { name: "Clients", parentId: null } });
    expect(await byPath("Clients/Alpha")).toMatchObject({ id: alpha.id });
    await api(`/folders/${clients.id}`, { method: "DELETE" });

    const again = await api(`/accounts/${acct.id}/folders`, { body: { name: "Clients" } });
    expect((await api(`/folders/${again.id}`, { method: "DELETE" })).path).toBe("Trash/Clients 2");
  });

  it("deletes a folder in Trash permanently, with everything in it", async () => {
    const inTrash = await byPath("Trash/Clients");
    const alpha = await byPath("Trash/Clients/Alpha");
    expect((await apiRaw(`/folders/${inTrash.id}`, { method: "DELETE" })).status).toBe(400); // must say permanent
    const r = await api(`/folders/${inTrash.id}?permanent=1`, { method: "DELETE" });
    expect(r.movedToTrash).toBe(false);
    const paths = await serverPaths();
    expect(paths).not.toContain("Trash/Clients");
    expect(paths).not.toContain("Trash/Clients/Alpha");
    expect(paths).toContain("Trash/Clients 2");
    expect(await byPath("Trash/Clients/Alpha")).toBeUndefined();
    expect(await messages(alpha.id)).toEqual([]); // the mirrored mail went with it
  });

  it("deletes permanently on request, and never deletes special folders", async () => {
    const k = await byPath("Kvitton ✓ å");
    await api(`/folders/${k.id}?permanent=1`, { method: "DELETE" });
    expect(await serverPaths()).not.toContain("Kvitton ✓ å");
    const trash = (await acct.folders()).find((f) => f.specialUse === "\\Trash");
    const inbox = await byPath("INBOX");
    expect((await apiRaw(`/folders/${trash.id}?permanent=1`, { method: "DELETE" })).status).toBe(400);
    expect((await apiRaw(`/folders/${inbox.id}?permanent=1`, { method: "DELETE" })).status).toBe(400);
  });

  it("warns when a filter still files mail into a deleted folder", async () => {
    const f = await api(`/accounts/${acct.id}/folders`, { body: { name: "Newsletters" } });
    await api(`/accounts/${acct.id}/sieve`, { method: "PUT", body: { rules: [{ id: "n", name: "News", conditions: [{ field: "list-id", op: "contains", value: "news" }], actions: [{ type: "move", value: "Newsletters" }] }] } });
    expect((await api(`/folders/${f.id}`, { method: "DELETE" })).filtersStillUsing).toBe(1);
  });
});

describe("second security review", () => {
  it("does not rename, move or delete a folder that holds a special folder", async () => {
    // a parent holding Sent, as Gmail's [Gmail] does
    await imap(U, async (c) => { await c.mailboxCreate("Holder"); await c.mailboxCreate("Holder/Sent"); });
    await api(`/accounts/${acct.id}/sync`, { method: "POST" });
    await waitFor(async () => !!(await byPath("Holder/Sent")), { what: "Holder/Sent to sync" });
    const pool = (await import("pg")).default;
    const c = new pool.Client({ connectionString: "postgres://ncmail:ncmail@127.0.0.1:15432/ncmail_test" });
    await c.connect();
    try { await c.query(`update folders set special_use = '\\Sent' where account_id = $1 and path = 'Holder/Sent'`, [acct.id]); } finally { await c.end(); }
    const holder = await byPath("Holder");
    for (const req of [{ method: "PATCH", body: { name: "Renamed" } }, { method: "DELETE" }, { method: "DELETE", q: "?permanent=1" }] as const) {
      const r = await apiRaw(`/folders/${holder.id}${"q" in req ? req.q : ""}`, { method: req.method, ...("body" in req ? { body: req.body } : {}) });
      expect(r.status).toBe(400);
      expect(r.data.error).toMatch(/contains Sent, a special folder/);
    }
    expect(await serverPaths()).toEqual(expect.arrayContaining(["Holder", "Holder/Sent"]));
  });

  it("leaves a filter alone, and says so, when its folder path would become too long", async () => {
    const f = await api(`/accounts/${acct.id}/folders`, { body: { name: "Short" } });
    await api(`/accounts/${acct.id}/folders`, { body: { name: "Inner", parentId: f.id } });
    await api(`/accounts/${acct.id}/sieve`, { method: "PUT", body: { rules: [{ id: "s", name: "S", conditions: [{ field: "from", op: "contains", value: "s@x" }], actions: [{ type: "move", value: "Short/Inner" }] }] } });
    const long = "L".repeat(199); // Short/Inner would become 205 characters
    const r = await api(`/folders/${f.id}`, { method: "PATCH", body: { name: long } });
    expect(r).toMatchObject({ filtersUpdated: 0, filtersNotUpdated: 1 });
    // the filters are still readable (a value over 200 characters used to make them all disappear)
    const sieve = await api(`/accounts/${acct.id}/sieve`);
    expect(sieve.config.rules[0].actions[0].value).toBe("Short/Inner");
  });
});
