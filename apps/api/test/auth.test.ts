import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IMAP_HOST, IMAP_PORT, SMTP_PORT, TEST_PASSWORD, user } from "./env.ts";
import { deliver, resetMailbox, sleep, waitFor } from "./helpers.ts";
import { startApi } from "./server.ts";
import { testNextcloud } from "./handoff.ts";

/** Nextcloud vouches for users with signed tokens; accounts belong to the user who added them. */
const U = user(36);
let api: { url: string; stop: () => Promise<void> };
const ncs = testNextcloud();
const other = testNextcloud(); // somebody else's key

const call = async (path: string, o: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) => {
  const r = await fetch(`${api.url}/api${path}`, {
    method: o.method ?? (o.body !== undefined ? "POST" : "GET"),
    headers: { ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...(o.cookie ? { cookie: o.cookie } : {}), ...o.headers },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, data: text ? JSON.parse(text) : undefined, setCookie: r.headers.get("set-cookie") ?? "" };
};
const handoff = (token: string, cookie?: string) => call("/auth/handoff", { body: { token }, cookie });
const login = async (u: string) => (await handoff(ncs.token(u))).setCookie.split(";")[0]!;
/** A signed call as the Nextcloud app makes it. */
const fromNextcloud = async (method: string, path: string, body?: unknown, who = ncs) => {
  const s = who.signed(method, `/api${path}`, body, new URL(api.url).host);
  const r = await fetch(`${api.url}/api${path}`, { method, headers: s.headers, body: s.body });
  const t = await r.text();
  return { status: r.status, data: t ? JSON.parse(t) : undefined };
};

let alice = "", bob = "", acctId = "", inbox = "", msgId = "";

beforeAll(async () => {
  api = await startApi(4112, { NCMAIL_AUTH: "nextcloud", NEXTCLOUD_URL: "http://127.0.0.1:9", NCMAIL_HANDOFF_PUBLIC_KEY: ncs.publicKey }, "ncmail_auth_test");
  await resetMailbox(U);
  await deliver(U, "INBOX", { subject: "Alice's secret", text: "private" });
  alice = await login("alice"); bob = await login("bob");
  acctId = (await call("/accounts", { cookie: alice, body: {
    name: "Alice mail", email: U, imap: { host: IMAP_HOST, port: IMAP_PORT, security: "none", username: U, password: TEST_PASSWORD },
    smtp: { host: IMAP_HOST, port: SMTP_PORT, security: "none", username: U, password: TEST_PASSWORD } } })).data.id;
  await call(`/accounts/${acctId}/sync`, { method: "POST", cookie: alice });
  inbox = await waitFor(async () => (await call(`/accounts/${acctId}/folders`, { cookie: alice })).data?.find((f: any) => f.specialUse === "\\Inbox")?.id, { what: "folders" });
  await call(`/folders/${inbox}/sync`, { method: "POST", cookie: alice });
  msgId = await waitFor(async () => (await call(`/folders/${inbox}/messages`, { cookie: alice })).data.items[0]?.id, { what: "the message" });
}, 90_000);
afterAll(async () => { await call(`/accounts/${acctId}`, { method: "DELETE", cookie: alice }).catch(() => {}); await api?.stop(); });

describe("signing in through Nextcloud", () => {
  it("refuses everything until Nextcloud has vouched for you", async () => {
    const r = await call("/accounts");
    expect(r.status).toBe(401);
    expect(r.data.code).toBe("auth");
    expect((await call("/auth/me")).data).toMatchObject({ authRequired: true, user: null });
  });
  it("has no password sign-in any more", async () => {
    expect((await call("/auth/login", { body: { username: "alice", password: "alice-pw" } })).status).toBeGreaterThanOrEqual(401);
  });
  it("turns a signed token into a session for that user", async () => {
    const r = await handoff(ncs.token("alice"));
    expect(r.status).toBe(200);
    expect(r.setCookie).toMatch(/ncmail_session=.*HttpOnly/);
    expect((await call("/auth/me", { cookie: alice })).data).toMatchObject({ user: "alice", name: "alice Example", email: "alice@example.org" });
  });
  it("accepts each token once", async () => {
    const t = ncs.token("alice");
    expect((await handoff(t)).status).toBe(200);
    expect((await handoff(t)).status).toBe(401);
  });
  it("rejects tokens that are expired, altered, from another key, or valid too long", async () => {
    const past = Math.floor(Date.now() / 1000) - 600;
    expect((await handoff(ncs.token("alice", { iat: past, exp: past + 60 }))).status).toBe(401);
    expect((await handoff(ncs.token("alice", { exp: Math.floor(Date.now() / 1000) + 3600 }))).status).toBe(401);
    expect((await handoff(other.token("alice"))).status).toBe(401);
    const [v, payload, sig] = ncs.token("alice").split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), uid: "bob" })).toString("base64url");
    expect((await handoff(`${v}.${forged}.${sig}`)).status).toBe(401);
    expect((await handoff("garbage")).status).toBeGreaterThanOrEqual(400);
  });
  it("rejects tokens without an audience or with times that are not numbers", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect((await handoff(ncs.token("alice", { aud: undefined }))).status).toBe(401);
    expect((await handoff(ncs.token("alice", { aud: "not an address" }))).status).toBe(401);
    expect((await handoff(ncs.token("alice", { iat: undefined }))).status).toBe(401);
    expect((await handoff(ncs.token("alice", { iat: String(now) }))).status).toBe(401);
  });
  it("rejects a forged or tampered session cookie", async () => {
    expect((await call("/accounts", { cookie: "ncmail_session=eyJ1IjoiYWxpY2UiLCJlIjo5OTk5OTk5OTk5fQ.abc" })).status).toBe(401);
    expect((await call("/accounts", { cookie: alice.replace(/.$/, (c) => (c === "A" ? "B" : "A")) })).status).toBe(401);
  });
  it("renewing replaces the old session instead of adding to it", async () => {
    const first = await login("alice");
    const second = (await handoff(ncs.token("alice"), first)).setCookie.split(";")[0]!;
    expect((await call("/accounts", { cookie: second })).status).toBe(200);
    expect((await call("/accounts", { cookie: first })).status).toBe(401);
    alice = second;
  });
  it("signs out for real: the old cookie stops working", async () => {
    const mine = await login("alice");
    expect((await call("/accounts", { cookie: mine })).status).toBe(200);
    expect((await call("/auth/logout", { method: "POST", cookie: mine })).setCookie).toContain("Max-Age=0");
    expect((await call("/accounts", { cookie: mine })).status).toBe(401);
    expect((await call("/accounts", { cookie: alice })).status).toBe(200);
  });
  it("ends every session of a user when Nextcloud says they signed out", async () => {
    const a = await login("carol"), b = await login("carol");
    expect((await fromNextcloud("POST", "/internal/logout", { uid: "carol" })).status).toBe(200);
    expect((await call("/accounts", { cookie: a })).status).toBe(401);
    expect((await call("/accounts", { cookie: b })).status).toBe(401);
    expect((await call("/accounts", { cookie: alice })).status).toBe(200); // others are untouched
  });
  it("only believes server-to-server calls that Nextcloud signed", async () => {
    expect((await fromNextcloud("POST", "/internal/logout", { uid: "alice" }, other)).status).toBe(401); // another key
    expect((await call("/internal/logout", { body: { uid: "alice" } })).status).toBe(401);              // unsigned
    const s = ncs.signed("GET", "/api/internal/unread?uid=alice", undefined, new URL(api.url).host);
    const url = `${api.url}/api/internal/unread`;
    expect((await fetch(`${url}?uid=bob`, { headers: s.headers })).status).toBe(401);                   // signed for someone else
    expect((await fetch(`${url}?uid=alice`, { headers: s.headers })).status).toBe(200);
    expect((await fetch(`${url}?uid=alice`, { headers: s.headers })).status).toBe(401);                 // the same request cannot be replayed
    expect((await call("/accounts", { cookie: alice })).status).toBe(200);
  });
  it("accepts signatures over the target host, only for this host", async () => {
    const host = new URL(api.url).host;
    const url = `${api.url}/api/internal/unread?uid=alice`;
    expect((await fetch(url, { headers: ncs.signed("GET", "/api/internal/unread?uid=alice", undefined, host).headers })).status).toBe(200);
    expect((await fetch(url, { headers: ncs.signed("GET", "/api/internal/unread?uid=alice", undefined, "mail.other.example").headers })).status).toBe(401);
    const good = ncs.signed("GET", "/api/internal/unread?uid=alice", undefined, host).headers;
    const { "x-ncmail-sig-version": _v, ...unversioned } = good;
    expect((await fetch(url, { headers: unversioned })).status).toBe(401); // no version: the old format without the host is not accepted
    expect((await fetch(url, { headers: { ...ncs.signed("GET", "/api/internal/unread?uid=alice", undefined, host).headers, "x-ncmail-sig-version": "3" } })).status).toBe(401);
  });
  it("refuses a change carrying the session cookie through a proxy without Origin or Sec-Fetch-Site", async () => {
    const r = await call("/auth/logout", { method: "POST", cookie: alice, headers: { "x-forwarded-for": "203.0.113.7" } });
    expect(r.status).toBe(403);
    expect(r.data.code).toBe("origin");
    expect((await call("/accounts", { cookie: alice })).status).toBe(200); // still signed in
  });
  it("counts unread mail for the menu badge", async () => {
    const r = await fromNextcloud("GET", `/internal/unread?uid=alice`);
    expect(r.data.unread).toBeGreaterThanOrEqual(1);
    expect((await fromNextcloud("GET", `/internal/unread?uid=bob`)).data.unread).toBe(0);
  });
  it("finds mail for Nextcloud's search, only the user's own", async () => {
    const mine = await fromNextcloud("GET", `/internal/search?uid=alice&q=secret`);
    expect(mine.data.items.map((i: any) => i.subject)).toContain("Alice's secret");
    expect((await fromNextcloud("GET", `/internal/search?uid=bob&q=secret`)).data.items).toEqual([]);
  });
  it("keeps an app password handed over by Nextcloud, encrypted", async () => {
    expect((await fromNextcloud("POST", "/internal/link", { uid: "alice", loginName: "alice", appPassword: "abcdefgh-12345678" })).status).toBe(200); // gitleaks:allow (dummy test value)
    expect((await call("/nextcloud", { cookie: alice })).data).toMatchObject({ connected: true, user: "alice" });
    expect((await call("/nextcloud", { cookie: bob })).data.connected).toBe(false);
  });
  it("is not served to a browser tab, only into a frame", async () => {
    const tab = await fetch(`${api.url}/`, { headers: { "sec-fetch-dest": "document" } });
    expect(tab.status).toBe(403);
    expect(await tab.text()).toMatch(/Open Mail from Nextcloud/);
    expect((await fetch(`${api.url}/`, { headers: { "sec-fetch-dest": "iframe" } })).status).toBe(200);
  });
});

describe("accounts belong to their Nextcloud user", () => {
  it("shows an account only to its owner", async () => {
    expect((await call("/accounts", { cookie: alice })).data.map((a: any) => a.id)).toEqual([acctId]);
    expect((await call("/accounts", { cookie: bob })).data).toEqual([]);
  });
  it("gives other users nothing from it: folders, messages, bodies, sync, send, keys, calendar", async () => {
    const tries: [string, Parameters<typeof call>[1]][] = [
      [`/accounts/${acctId}/folders`, {}], [`/folders/${inbox}`, {}], [`/folders/${inbox}/messages`, {}], [`/messages/${msgId}`, {}],
      [`/accounts/${acctId}/keys`, {}], [`/accounts/${acctId}/calendar`, {}], [`/accounts/${acctId}/identities`, {}],
      [`/accounts/${acctId}/sync`, { method: "POST" }], [`/accounts/${acctId}/send`, { body: { to: ["x@example.org"], subject: "hi", text: "x" } }],
      [`/accounts/${acctId}`, { method: "PATCH", body: { name: "stolen" } }], [`/messages/${msgId}`, { method: "DELETE" }],
      [`/threads/1?folderId=${inbox}`, {}],
    ];
    for (const [path, o] of tries) expect((await call(path, { ...o, cookie: bob })).status, path).toBe(404);
  });
  it("does not let bulk actions reach another user's messages or folders", async () => {
    expect((await call("/messages/bulk", { cookie: bob, body: { action: "delete", messageIds: [msgId] } })).status).toBe(404);
    expect((await call("/messages/bulk", { cookie: bob, body: { action: "delete", scope: "folder", folderId: inbox } })).status).toBe(404);
    expect((await call(`/folders/${inbox}/messages`, { cookie: alice })).data.items).toHaveLength(1); // still there
  });
  it("keeps contacts and the outbox per user", async () => {
    expect((await call("/outbox", { cookie: bob })).data).toEqual([]);
    expect((await call("/contacts?q=a", { cookie: bob })).data).toEqual([]);
    expect((await call(`/contacts?q=a&accountId=${acctId}`, { cookie: bob })).status).toBe(404);
  });
  it("hides only the caller's own sender addresses from suggestions", async () => {
    const before = (await call("/contacts?q=alice@", { cookie: alice })).data.map((c: any) => c.email);
    expect(before).toContain("alice@example.org");
    // another user claiming the same address as a sender identity does not hide it from alice
    const bobAcct = (await call("/accounts", { cookie: bob, body: {
      name: "Bob mail", email: "alice@example.org", imap: { host: IMAP_HOST, port: IMAP_PORT, security: "none", username: U, password: TEST_PASSWORD },
      smtp: { host: IMAP_HOST, port: SMTP_PORT, security: "none", username: U, password: TEST_PASSWORD } } })).data.id;
    try {
      expect((await call("/contacts?q=alice@", { cookie: alice })).data.map((c: any) => c.email)).toContain("alice@example.org");
    } finally {
      await call(`/accounts/${bobAcct}`, { method: "DELETE", cookie: bob });
    }
  });
  it("cannot be deleted by someone else", async () => {
    expect((await call(`/accounts/${acctId}`, { method: "DELETE", cookie: bob })).status).toBe(404);
    expect((await call("/accounts", { cookie: alice })).data).toHaveLength(1);
  });
  it("lets the owner use it normally", async () => {
    const m = await call(`/messages/${msgId}`, { cookie: alice });
    expect(m.status).toBe(200);
    expect(m.data.subject).toBe("Alice's secret");
  });
});

describe("checks follow the route the request reaches, however its path is spelled", () => {
  /** A request to an exact path as sent (no /api prefix added, percent-escapes kept). */
  const at = async (path: string, o: { method?: string; body?: unknown; cookie?: string } = {}) => {
    const r = await fetch(`${api.url}${path}`, {
      method: o.method ?? (o.body !== undefined ? "POST" : "GET"),
      headers: { ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...(o.cookie ? { cookie: o.cookie } : {}) },
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
    const t = await r.text();
    return { status: r.status, text: t };
  };
  /** A TCP listener standing in for a mail server, counting the connections it gets. */
  const listener = async () => {
    const { createServer } = await import("node:net");
    let connections = 0;
    const s = createServer((c) => { connections++; c.destroy(); });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    return { port: (s.address() as any).port as number, connections: () => connections, close: () => new Promise((r) => s.close(r)) };
  };

  it("asks for a session on API routes with escaped path characters", async () => {
    for (const p of [`/%61pi/messages/${msgId}`, `/api/m%65ssages/${msgId}`, `/%61pi/accounts`, `/api/%61ccounts/${acctId}/folders`]) {
      const r = await at(p);
      expect(r.status, p).toBe(401);
      expect(r.text, p).not.toContain("Alice's secret");
    }
  });
  it("requires Nextcloud's signature on every internal route", async () => {
    expect((await at("/%61pi/internal/unread?uid=alice")).status).toBe(401);
    expect((await at("/api/%69nternal/search?uid=alice&q=secret")).status).toBe(401);
    expect((await at("/api/%69nternal/notifications", { method: "POST", body: {} })).status).toBe(401);
    expect((await at("/api/%69nternal/logout", { body: { uid: "alice" } })).status).toBe(401);
    expect((await call("/accounts", { cookie: alice })).status).toBe(200); // still signed in
    expect((await at("/%61pi/internal/link", { body: { uid: "alice", loginName: "someone", appPassword: "zzzzzzzz-00000000" } })).status).toBe(401); // gitleaks:allow (dummy test value)
    expect((await call("/nextcloud", { cookie: alice })).data).toMatchObject({ connected: true, user: "alice" }); // unchanged
  });
  it("checks ownership on escaped paths too", async () => {
    for (const p of [`/api/m%65ssages/${msgId}`, `/%61pi/messages/${msgId}`, `/api/%61ccounts/${acctId}/folders`, `/api/f%6flders/${inbox}`]) {
      const r = await at(p, { cookie: bob });
      expect(r.status, p).toBe(404);
      expect(r.text, p).not.toContain("Alice's secret");
    }
    const patch = await at(`/api/%61ccounts/${acctId}`, { method: "PATCH", cookie: bob, body: { name: "x", email: U, imap: { host: IMAP_HOST, port: IMAP_PORT, security: "none", username: U, password: "" }, smtp: { host: IMAP_HOST, port: SMTP_PORT, security: "none", username: U, password: "" } } });
    expect(patch.status).toBe(404);
    expect((await call("/accounts", { cookie: alice })).data[0].name).toBe("Alice mail");
  });
  it("never uses another user's stored passwords to test a connection", async () => {
    const l = await listener();
    try {
      const body = { accountId: acctId, imap: { host: "127.0.0.1", port: l.port, security: "none", username: U, password: "" }, smtp: { host: "127.0.0.1", port: l.port, security: "none", username: U, password: "" } };
      expect((await at("/api/%61ccounts/test", { cookie: bob, body })).status).toBe(404);
      expect((await at("/api/accounts/test", { cookie: bob, body })).status).toBe(404);
      expect((await at("/%61pi/accounts/test", { body })).status).toBe(401);
      await sleep(300);
      expect(l.connections()).toBe(0);
    } finally { await l.close(); }
  });
  it("does not serve paths that only resemble API routes", async () => {
    for (const p of ["/api//accounts", "/api%2Faccounts", "/API/accounts"]) {
      const r = await at(p, { cookie: alice });
      expect(r.status, p).toBe(404);
      expect(r.text, p).not.toContain("Alice mail");
    }
  });
});

describe("a user removed from Nextcloud", () => {
  it("leaves nothing behind for a later user with the same id", async () => {
    const dave = await login("dave");
    const created = await call("/accounts", { cookie: dave, body: {
      name: "Dave mail", email: U, imap: { host: IMAP_HOST, port: IMAP_PORT, security: "none", username: U, password: TEST_PASSWORD },
      smtp: { host: IMAP_HOST, port: SMTP_PORT, security: "none", username: U, password: TEST_PASSWORD } } });
    expect(created.status).toBe(201);
    expect((await call("/templates", { cookie: dave, body: { name: "Reply", subject: "Re", html: "<p>x</p>" } })).status).toBe(201);
    expect((await call("/prefs", { method: "PATCH", cookie: dave, body: { notifyNewMail: false } })).status).toBe(200);
    expect((await fromNextcloud("POST", "/internal/link", { uid: "dave", loginName: "dave", appPassword: "abcdefgh-12345678" })).status).toBe(200); // gitleaks:allow (dummy test value)

    expect((await fromNextcloud("POST", "/internal/user-deleted", { uid: "dave" }, other)).status).toBe(401); // signed calls only
    expect((await fromNextcloud("POST", "/internal/user-deleted", { uid: "dave" })).status).toBe(200);
    expect((await call("/accounts", { cookie: dave })).status).toBe(401); // the session ended

    const again = await login("dave");
    expect((await call("/accounts", { cookie: again })).data).toEqual([]);
    expect((await call(`/accounts/${created.data.id}/folders`, { cookie: again })).status).toBe(404);
    expect((await call("/templates", { cookie: again })).data).toEqual([]);
    expect((await call("/prefs", { cookie: again })).data).toEqual({ notifyNewMail: true, readReceipts: "ask" });
    expect((await call("/nextcloud", { cookie: again })).data.connected).toBe(false);
    expect((await call("/idle", { cookie: again })).data).toEqual([]);
    expect((await call("/accounts", { cookie: alice })).data.map((a: any) => a.id)).toEqual([acctId]); // others are untouched
  });
  it("keeps everything when the user only signs out", async () => {
    expect((await fromNextcloud("POST", "/internal/logout", { uid: "alice" })).status).toBe(200);
    alice = await login("alice");
    expect((await call("/accounts", { cookie: alice })).data.map((a: any) => a.id)).toEqual([acctId]);
  });
});

// last: it blocks further sign-ins from this address for a while
describe("repeated bad sign-in tokens", () => {
  it("slows down someone who keeps sending bad tokens", async () => {
    let last = 0;
    for (let i = 0; i < 35; i++) last = (await handoff(other.token("mallory"))).status;
    expect(last).toBe(429);
  });
});
