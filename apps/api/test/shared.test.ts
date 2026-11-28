import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { user } from "./env.ts";
import { addAccount, api, apiRaw, createMailbox, deliver, imap, messages, resetMailbox, syncFolder, waitFor, type Acct } from "./helpers.ts";
import { setAcl } from "../src/acl.ts";

/** Folders shared between users of the same mail server (IMAP namespaces and ACLs, RFC 2342 / RFC 4314). */
const OWNER = user(3), OTHER = user(4), CURATOR = user(9), READER = user(10);
let anna: Acct, ben: Acct, curator: Acct, reader: Acct;
let team: any;

/** Sync the account until its folder list shows what we expect (a sync runs in the background). */
const until = <T>(a: Acct, check: (folders: any[]) => T | false | undefined | null, what: string) =>
  // generous: under the full parallel suite the (emulated) test Dovecot can be slow to list shared folders
  waitFor(async () => { await api(`/accounts/${a.id}/sync`, { method: "POST" }); return check(await a.folders()); }, { what, timeout: 30_000, interval: 300 });
const sharedTeam = async () => (await ben.folders()).find((f: any) => f.path === "Shared/u03/Team");

beforeAll(async () => {
  await resetMailbox(OWNER); await resetMailbox(OTHER);
  await createMailbox(OWNER, "Team");
  await deliver(OWNER, "Team", { subject: "Team plans", text: "for everyone" });
  anna = await addAccount(OWNER);
  ben = await addAccount(OTHER);
  team = await anna.folder("Team");
  // a public folder (the test server's "Public/" namespace): everyone may read it, the curator may manage it
  await resetMailbox(CURATOR); await resetMailbox(READER);
  await imap(CURATOR, async (c) => {
    await c.mailboxCreate("Public/News").catch(() => {});
    const lock = await c.getMailboxLock("Public/News");
    try { if ((c.mailbox as any).exists > 0) await c.messageDelete("1:*"); } finally { lock.release(); }
  });
  await deliver(CURATOR, "Public/News", { subject: "Company news", text: "for all" });
  curator = await addAccount(CURATOR);
  reader = await addAccount(READER);
}, 90_000);
afterAll(async () => {
  for (const a of [anna, ben, curator, reader]) if (a) await api(`/accounts/${a.id}`, { method: "DELETE" });
  await resetMailbox(OWNER);
});

describe("shared folders", () => {
  it("knows the server can share, and that your own folders are yours", async () => {
    expect((await api<any[]>("/accounts")).find((a) => a.id === anna.id).supportsAcl).toBe(true);
    expect(team).toMatchObject({ namespace: "personal", sharedOwner: null, rights: null });
  });

  it("shares a folder read-only; it appears for the other user under Shared, owned by the first", async () => {
    await api(`/folders/${team.id}/acl`, { method: "PUT", body: { user: OTHER, access: "read" } });
    expect(await api(`/folders/${team.id}/acl`)).toEqual([{ user: OTHER, access: "read", rights: "lrs" }]);
    const f = await until(ben, (l) => l.find((x) => x.path === "Shared/u03/Team"), "the shared folder");
    expect(f).toMatchObject({ namespace: "other", sharedOwner: "u03", rights: "lrs", specialUse: null, selectable: true });
    const roots = (await ben.folders()).filter((x: any) => x.path === "Shared" || x.path === "Shared/u03");
    expect(roots.map((x: any) => [x.path, x.namespace, x.selectable])).toEqual(expect.arrayContaining([["Shared", "other", false], ["Shared/u03", "other", false]]));
    await syncFolder(f.id);
    expect(await waitFor(async () => { const l = (await messages(f.id)).map((m) => m.subject); return l.length ? l : false; }, { what: "the shared folder's messages" })).toEqual(["Team plans"]);
  });

  it("someone else's folders never act as your Sent or Trash", async () => {
    const sent = await anna.folder("Sent");
    await api(`/folders/${sent.id}/acl`, { method: "PUT", body: { user: OTHER, access: "read" } });
    const theirs = await until(ben, (l) => l.find((x) => x.path === "Shared/u03/Sent"), "the shared Sent folder");
    expect(theirs.specialUse).toBeNull();
    expect((await ben.folders()).filter((x: any) => x.specialUse === "\\Sent").map((x: any) => x.path)).toEqual(["Sent"]);
    await api(`/folders/${sent.id}/acl/${encodeURIComponent(OTHER)}`, { method: "DELETE" });
  });

  it("lets the owner allow changes, and shows it in the other user's rights", async () => {
    await api(`/folders/${team.id}/acl`, { method: "PUT", body: { user: OTHER, access: "write" } });
    expect((await api<any[]>(`/folders/${team.id}/acl`))[0]).toMatchObject({ user: OTHER, access: "write" });
    await until(ben, (l) => l.find((x) => x.path === "Shared/u03/Team" && x.rights?.includes("t")), "write rights");
    expect((await sharedTeam()).rights).toEqual(expect.stringMatching(/^(?=.*t)(?=.*e)(?=.*i)(?=.*w)/));
  });

  it("refuses sharing with everyone, with yourself, or someone else's folder", async () => {
    expect((await apiRaw(`/folders/${team.id}/acl`, { method: "PUT", body: { user: "anyone", access: "read" } })).status).toBe(400);
    expect((await apiRaw(`/folders/${team.id}/acl`, { method: "PUT", body: { user: OWNER, access: "read" } })).status).toBe(400);
    const theirs = await sharedTeam();
    expect((await apiRaw(`/folders/${theirs.id}/acl`)).status).toBe(400);
    expect((await apiRaw(`/folders/${theirs.id}/acl`, { method: "PUT", body: { user: OWNER, access: "write" } })).status).toBe(400);
  });

  it("forgets the mirrored mail when the owner leaves only the right to see the folder", async () => {
    const f = await sharedTeam();
    await syncFolder(f.id);
    const [m] = await waitFor(async () => { const l = await messages(f.id); return l.length ? l : false; }, { what: "the shared folder's messages" });
    expect((await apiRaw(`/messages/${m.id}`)).status).toBe(200); // the body is cached now
    await imap(OWNER, (c) => setAcl(c, "Team", OTHER, "l")); // done from another mail client: lookup only
    await until(ben, (l) => l.find((x) => x.path === "Shared/u03/Team" && x.rights === "l"), "lookup-only rights");
    expect(await messages(f.id)).toEqual([]);
    expect((await apiRaw(`/messages/${m.id}`)).status).toBe(404);
    expect((await api(`/accounts/${ben.id}/search?q=${encodeURIComponent("Team plans")}`)).items).toEqual([]);
    await api(`/folders/${team.id}/acl`, { method: "PUT", body: { user: OTHER, access: "read" } });
  });

  it("stops sharing: the folder disappears for the other user", async () => {
    await api(`/folders/${team.id}/acl/${encodeURIComponent(OTHER)}`, { method: "DELETE" });
    expect(await api(`/folders/${team.id}/acl`)).toEqual([]);
    await until(ben, (l) => !l.some((x) => x.path === "Shared/u03/Team"), "the folder to go away");
    expect(await sharedTeam()).toBeUndefined();
  });
});

describe("public folders", () => {
  let forCurator: any;

  it("are managed by whoever the server allows: the curator shares one, and it appears as public with those rights", async () => {
    forCurator = await until(curator, (l) => l.find((x) => x.path === "Public/News" && x.rights?.includes("a")), "the curator's rights");
    expect(forCurator).toMatchObject({ namespace: "shared", sharedOwner: null, specialUse: null });
    await api(`/folders/${forCurator.id}/acl`, { method: "PUT", body: { user: READER, access: "read" } });
    const news = await until(reader, (l) => l.find((x) => x.path === "Public/News"), "the public folder");
    expect(news).toMatchObject({ namespace: "shared", sharedOwner: null, rights: "lrs", specialUse: null, selectable: true });
    expect((await reader.folders()).find((x: any) => x.path === "Public")).toMatchObject({ namespace: "shared", selectable: false });
    await syncFolder(news.id);
    expect(await waitFor(async () => { const l = (await messages(news.id)).map((m) => m.subject); return l.length ? l : false; }, { what: "the public folder's messages" })).toEqual(["Company news"]);
  });

  it("cannot be managed by a reader", async () => {
    const news = (await reader.folders()).find((x: any) => x.path === "Public/News");
    expect((await apiRaw(`/folders/${news.id}/acl`)).status).toBe(400);
    expect((await apiRaw(`/folders/${news.id}/acl`, { method: "PUT", body: { user: CURATOR, access: "read" } })).status).toBe(400);
  });

  it("follow the curator's changes: write access, then none", async () => {
    await api(`/folders/${forCurator.id}/acl`, { method: "PUT", body: { user: READER, access: "write" } });
    await until(reader, (l) => l.find((x) => x.path === "Public/News" && x.rights?.includes("t")), "write rights on the public folder");
    await api(`/folders/${forCurator.id}/acl/${encodeURIComponent(READER)}`, { method: "DELETE" });
    await until(reader, (l) => !l.some((x) => x.path === "Public/News"), "the public folder to go away");
  });
});

/**
 * A folder someone shared that the server keeps listing but will not open (seen on a real server after a shared mailbox was
 * renamed: other mail apps hide it). Here the owner's folder is broken on disk, so the test Dovecot lists it and refuses
 * every SELECT and STATUS with [SERVERBUG].
 */
describe("a shared folder the server lists but will not open", () => {
  const OWNER2 = user(40), VIEWER = user(39);
  let viewer: Acct;
  const onDisk = (cmd: string) => execFileSync("docker", ["exec", "ncmail-test-dovecot-1", "sh", "-c", cmd]);
  const brokenCur = (box: string) => `/srv/vmail/u40/Maildir/.${box}/cur`;
  /** Unreadable messages and no index to answer from: Dovecot still lists the folder but refuses SELECT and STATUS. */
  const breakBox = (...boxes: string[]) => onDisk(boxes.map((b) => `rm -f /srv/vmail/u40/Maildir/.${b}/dovecot.index*; chmod 000 ${brokenCur(b)}`).join("; "));

  beforeAll(async () => {
    await resetMailbox(OWNER2); await resetMailbox(VIEWER);
    for (const box of ["Empty", "Kept"]) await createMailbox(OWNER2, box);
    await deliver(OWNER2, "Kept", { subject: "Already mirrored", text: "stays" });
    await imap(OWNER2, async (c) => { await setAcl(c, "Empty", VIEWER, "lrs"); await setAcl(c, "Kept", VIEWER, "lrs"); });
    viewer = await addAccount(VIEWER);
    await until(viewer, (fs) => fs.some((f) => f.path === "Shared/u40/Empty") && fs.find((f) => f.path === "Shared/u40/Kept"), "both shared folders listed");
    const kept = (await viewer.folders()).find((f: any) => f.path === "Shared/u40/Kept");
    await syncFolder(kept.id);
    await waitFor(async () => (await messages(kept.id)).length === 1 || undefined, { what: "Kept mirrored" });
  }, 90_000);
  afterAll(async () => {
    onDisk(`chmod 700 ${brokenCur("Empty")} ${brokenCur("Kept")} 2>/dev/null || true`);
    if (viewer) await api(`/accounts/${viewer.id}`, { method: "DELETE" });
    await resetMailbox(OWNER2); await resetMailbox(VIEWER);
  });

  it("leaves it out of the folder list while it holds no mail, and brings it back once it opens", async () => {
    breakBox("Empty");
    await until(viewer, (fs) => !fs.some((f) => f.path === "Shared/u40/Empty") || undefined, "the broken empty folder hidden");
    onDisk(`chmod 700 ${brokenCur("Empty")}`);
    await until(viewer, (fs) => fs.some((f) => f.path === "Shared/u40/Empty") || undefined, "the folder back once it opens");
  });

  it("keeps showing one whose mail is already mirrored", async () => {
    breakBox("Kept", "Empty");
    // once the empty one is hidden, the same checks have run on Kept
    await until(viewer, (fs) => !fs.some((f) => f.path === "Shared/u40/Empty") || undefined, "the broken empty folder hidden");
    const kept = (await viewer.folders()).find((f: any) => f.path === "Shared/u40/Kept");
    expect(kept).toBeTruthy();
    expect((await messages(kept.id)).map((m: any) => m.subject)).toEqual(["Already mirrored"]);
    // opening it shows why, in words (not imapflow's "Command failed")
    await syncFolder(kept.id).catch(() => {});
    const err = (await viewer.folders()).find((f: any) => f.path === "Shared/u40/Kept").syncError;
    expect(err).toMatch(/internal error with this folder/);
    expect(err).not.toMatch(/Command failed/);
    onDisk(`chmod 700 ${brokenCur("Kept")} ${brokenCur("Empty")}`);
  });
});
