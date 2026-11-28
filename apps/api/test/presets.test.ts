import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMAP_HOST, IMAP_PORT, SMTP_PORT, TEST_PASSWORD, user } from "./env.ts";
import pg from "pg";
import { startApi } from "./server.ts";
import { waitFor } from "./helpers.ts";
import { testNextcloud } from "./handoff.ts";
import { parseAutoconfig } from "../src/discover.ts";

/** Mail servers set up by an administrator: offered to the user, enforced when locked, trusted even on a private network. */
const U = user(37);
const ncs = testNextcloud();
let locked: { url: string; stop: () => Promise<void> }, open: { url: string; stop: () => Promise<void> };
let cookie = "", cookie2 = "";
const dir = mkdtempSync(join(tmpdir(), "ncmail-presets-"));
const config = (allowCustom: boolean) => {
  const f = join(dir, `mail-${allowCustom}.json`);
  writeFileSync(f, JSON.stringify({ allowCustom, servers: [
    { id: "corp", name: "Company mail", domains: ["example.org"], username: "local", imap: { host: IMAP_HOST, port: IMAP_PORT, security: "none" }, smtp: { host: IMAP_HOST, port: SMTP_PORT, security: "none" } },
    { id: "other", name: "Other mail", domains: ["other.test"], imap: { host: "mail.other.test", port: 993, security: "tls" }, smtp: { host: "smtp.other.test", port: 465, security: "tls" } },
  ] }));
  return f;
};
const call = async (srv: { url: string }, path: string, cookie: string, body?: unknown) => {
  const r = await fetch(`${srv.url}/api${path}`, { method: body === undefined ? "GET" : "POST", headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); return { status: r.status, data: t ? JSON.parse(t) : undefined };
};
/** A signed call as the Nextcloud app makes it (the admin settings page goes through these). */
const admin = async (srv: { url: string }, method: string, path: string, body?: unknown) => {
  const sg = ncs.signed(method, path, body, new URL(srv.url).host);
  const r = await fetch(`${srv.url}${path}`, { method, headers: sg.headers, body: sg.body });
  const t = await r.text(); return { status: r.status, data: t ? JSON.parse(t) : undefined };
};
const env = (file: string) => ({ NCMAIL_AUTH: "nextcloud", NEXTCLOUD_URL: "http://127.0.0.1:9", NCMAIL_HANDOFF_PUBLIC_KEY: ncs.publicKey, NCMAIL_MAIL_CONFIG: file, NCMAIL_PRIVATE_HOSTS: "block", NCMAIL_ISPDB: "0", NCMAIL_SERVER_CHECK_HOURS: "0" });
const signIn = async (srv: { url: string }, uid: string) => (await fetch(`${srv.url}/api/auth/handoff`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: ncs.token(uid) }) })).headers.get("set-cookie")!.split(";")[0]!;
const acct = (imapHost = IMAP_HOST, port = IMAP_PORT) => ({ name: "Work", email: `${U}`, imap: { host: imapHost, port, security: "none", username: U, password: TEST_PASSWORD }, smtp: { host: imapHost, port: SMTP_PORT, security: "none", username: U, password: TEST_PASSWORD } });

beforeAll(async () => {
  locked = await startApi(4131, env(config(false)), "ncmail_presets_locked");
  open = await startApi(4132, env(config(true)), "ncmail_presets_open");
  cookie = await signIn(locked, "pat"); cookie2 = await signIn(open, "pat");
  await admin(open, "POST", "/api/internal/mail-servers", { uid: "admin", config: { allowCustom: true, servers: [] } }); // earlier runs leave theirs
  // heartbeats of servers from an earlier, interrupted run would look like other instances for a while
  const db = new pg.Client({ connectionString: "postgres://ncmail:ncmail@127.0.0.1:15432/ncmail_presets_open" });
  await db.connect();
  try { await db.query("delete from service_instances where seen_at < now() - interval '1 second' or started_at < now() - interval '1 minute'"); } finally { await db.end(); }
}, 60_000);
afterAll(async () => { await locked?.stop(); await open?.stop(); });

describe("mail servers set up by an administrator", () => {
  it("are offered to the user, with the one for their address suggested", async () => {
    const r = await call(locked, "/mail-presets", cookie);
    expect(r.data.servers.map((s: any) => s.id)).toEqual(["corp", "other"]);
    expect(r.data.suggested).toBe("corp");               // the token's address is pat@example.org
    expect(r.data).toMatchObject({ allowCustom: false, user: { uid: "pat", email: "pat@example.org" } });
  });
  it("lock users to the listed servers when custom ones are not allowed", async () => {
    const r = await call(locked, "/accounts", cookie, acct("127.0.0.2", 1143));
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/administrator only allows/);
  });
  it("work even though they are on a private address (the administrator chose them)", async () => {
    const r = await call(locked, "/accounts", cookie, acct());
    expect(r.status).toBe(201);
  });
  it("are trusted on their own mail ports only, not on any other port of the same host", async () => {
    // the listed server is 127.0.0.1 on the IMAP and SMTP ports; the same host on the Sieve port is not listed
    const r = await call(open, "/accounts", cookie2, acct(IMAP_HOST, 14190));
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/private or local network/);
  });
  it("look up a domain's servers for people adding their own account, unless they are locked to the list", async () => {
    expect((await call(locked, "/mail-presets/lookup?email=pat@example.org", cookie)).status).toBe(403);
    expect((await call(open, "/mail-presets/lookup?email=", cookie2)).status).toBe(400);
    const r = await call(open, "/mail-presets/lookup?email=pat@nothing-here.invalid", cookie2);
    expect(r).toMatchObject({ status: 200, data: { domain: "nothing-here.invalid", found: null } });
  });
  it("let users enter their own servers when the administrator allows it", async () => {
    expect((await call(open, "/mail-presets", cookie2)).data.allowCustom).toBe(true);
    const r = await call(open, "/accounts", cookie2, acct("127.0.0.2", IMAP_PORT)); // not listed, and private: still refused by the address policy
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/private or local network/);
  });
});

describe("mail servers set up in Nextcloud's admin settings", () => {
  const extra = { id: "srv-team", name: "Team mail", domains: ["@Team.Test", "team.test", ""], username: "email",
    imap: { host: IMAP_HOST, port: IMAP_PORT, security: "none" }, smtp: { host: IMAP_HOST, port: SMTP_PORT, security: "none" } };
  afterAll(async () => { await admin(open, "POST", "/api/internal/mail-servers", { uid: "admin", config: { allowCustom: true, servers: [] } }); });

  it("shows the file's servers and the saved ones separately", async () => {
    const r = await admin(open, "GET", "/api/internal/mail-servers");
    expect(r.status).toBe(200);
    expect(r.data.file).toMatchObject({ configured: true, allowCustom: true });
    expect(r.data.file.servers.map((s: any) => s.id)).toEqual(["corp", "other"]);
    expect(r.data.admin).toEqual({ allowCustom: true, servers: [] });
  });

  it("are saved, cleaned up, and offered to users next to the file's", async () => {
    const r = await admin(open, "POST", "/api/internal/mail-servers", { uid: "alex", config: { allowCustom: true, servers: [extra] } });
    expect(r.status).toBe(200);
    expect(r.data.admin.servers[0].domains).toEqual(["team.test"]); // lower case, no "@", no blanks or repeats
    expect(r.data.updatedBy).toBe("alex");
    const p = await call(open, "/mail-presets", cookie2);
    expect(p.data.servers.map((s: any) => s.id)).toEqual(["corp", "other", "srv-team"]);
  });

  it("can lock users to the list, even when the file allows their own", async () => {
    await admin(open, "POST", "/api/internal/mail-servers", { uid: "alex", config: { allowCustom: false, servers: [extra] } });
    expect((await call(open, "/mail-presets", cookie2)).data.allowCustom).toBe(false);
    const r = await call(open, "/accounts", cookie2, acct("127.0.0.2", 1143));
    expect(r.data.error).toMatch(/administrator only allows/);
  });

  it("refuse ids that repeat or clash with the file, bad hosts, and unsigned calls", async () => {
    expect((await admin(open, "POST", "/api/internal/mail-servers", { uid: "a", config: { servers: [extra, extra] } })).status).toBe(400);
    expect((await admin(open, "POST", "/api/internal/mail-servers", { uid: "a", config: { servers: [{ ...extra, id: "corp" }] } })).status).toBe(400);
    expect((await admin(open, "POST", "/api/internal/mail-servers", { uid: "a", config: { servers: [{ ...extra, imap: { ...extra.imap, host: "https://x/y" } }] } })).status).toBe(400);
    const r = await fetch(`${open.url}/api/internal/mail-servers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: { servers: [] } }) });
    expect(r.status).toBeGreaterThanOrEqual(401);
    expect((await call(open, "/internal/mail-servers", cookie2)).status).toBeGreaterThanOrEqual(401); // a signed-in user is not Nextcloud
  });

  it("checks that servers answer, without logging in", async () => {
    const r = await admin(open, "POST", "/api/internal/mail-servers/check", { imap: extra.imap, smtp: extra.smtp, sieve: { host: IMAP_HOST, port: 14190, security: "none" } });
    expect(r.data.imap).toMatchObject({ ok: true, message: expect.stringMatching(/without encryption/) });
    expect(r.data.smtp.ok).toBe(true);
    expect(r.data.sieve.ok).toBe(true);
    const bad = await admin(open, "POST", "/api/internal/mail-servers/check", { imap: { host: IMAP_HOST, port: 1, security: "tls" }, smtp: { host: IMAP_HOST, port: IMAP_PORT, security: "none" } });
    expect(bad.data.imap).toMatchObject({ ok: false, message: expect.stringMatching(/Nothing answers/) });
    expect(bad.data.smtp).toMatchObject({ ok: false, message: expect.stringMatching(/does not look like an SMTP/) }); // an IMAP server on the SMTP line
    expect(bad.data.sieve).toBeNull();
  });

  it("keep each listed server's last check for the page", async () => {
    const r = await admin(open, "POST", "/api/internal/mail-servers/check-all", {});
    expect(r.data.status.corp.imap.ok).toBe(true);
    expect(r.data.status.other.imap).toMatchObject({ ok: false, message: expect.stringMatching(/could not be found/) });
    expect(r.data.status.corp.checkedAt).toBeTruthy();
    const view = await admin(open, "GET", "/api/internal/mail-servers");
    expect(Object.keys(view.data.status)).toEqual(expect.arrayContaining(["corp", "other"]));
  });

  it("look up a domain's servers, and say so when there are none", async () => {
    expect((await admin(open, "POST", "/api/internal/mail-servers/discover", { domain: "not a domain" })).status).toBe(400);
    const r = await admin(open, "POST", "/api/internal/mail-servers/discover", { domain: "nothing-here.invalid" });
    expect(r.status).toBe(200);
    expect(r.data.found).toBeNull();
  });
});

describe("versions for the admin page", () => {
  it("says which version the service is, the oldest app it works with, and the app version it last saw", async () => {
    const health = await (await fetch(`${open.url}/api/health`)).json();
    expect(health).toMatchObject({ ok: true, version: expect.any(String), minAppVersion: expect.any(String) });
    const sg = ncs.signed("GET", "/api/internal/version", undefined, new URL(open.url).host);
    const r = await (await fetch(`${open.url}/api/internal/version`, { headers: { ...sg.headers, "x-ncmail-app-version": "0.4.2" } })).json();
    expect(r).toEqual({ version: health.version, minAppVersion: health.minAppVersion, appVersionSeen: "0.4.2", otherInstances: [] });
    expect((await call(open, "/internal/version", cookie2)).status).toBeGreaterThanOrEqual(401); // only Nextcloud may ask
  });
});

describe("one service instance per database", () => {
  const version = async () => {
    const sg = ncs.signed("GET", "/api/internal/version", undefined, new URL(open.url).host);
    return (await fetch(`${open.url}/api/internal/version`, { headers: sg.headers })).json();
  };
  it("reports a second instance on the same database, and stops when it is gone", async () => {
    expect((await version()).otherInstances).toEqual([]);
    const second = await startApi(4133, env(config(true)), "ncmail_presets_open");
    try {
      const others = (await version()).otherInstances;
      expect(others).toHaveLength(1);
      expect(others[0]).toMatchObject({ host: expect.any(String), version: expect.any(String) });
    } finally { await second.stop(); }
    // a clean stop removes its heartbeat, so a restart does not look like a second instance
    await waitFor(async () => (await version()).otherInstances.length === 0, { what: "the stopped instance to disappear" });
  });
});

describe("reading a domain's autoconfig file", () => {
  const xml = `<?xml version="1.0"?><clientConfig version="1.1"><emailProvider id="example.com">
    <displayName>Example &amp; Co mail</displayName>
    <incomingServer type="pop3"><hostname>pop.example.com</hostname><port>995</port><socketType>SSL</socketType></incomingServer>
    <incomingServer type="imap"><hostname>imap.%EMAILDOMAIN%</hostname><port>143</port><socketType>STARTTLS</socketType><username>%EMAILLOCALPART%</username></incomingServer>
    <incomingServer type="imap"><hostname>imap.%EMAILDOMAIN%</hostname><port>993</port><socketType>SSL</socketType><username>%EMAILLOCALPART%</username></incomingServer>
    <outgoingServer type="smtp"><hostname>smtp.example.com</hostname><port>587</port><socketType>STARTTLS</socketType><username>%EMAILADDRESS%</username></outgoingServer>
  </emailProvider></clientConfig>`;
  it("takes the most secure IMAP and SMTP servers and how people sign in", () => {
    expect(parseAutoconfig(xml, "example.com")).toEqual({
      imap: { host: "imap.example.com", port: 993, security: "tls" },
      smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
      username: "local", name: "Example & Co mail",
    });
  });
  it("gives up without both an IMAP and an SMTP server, or on odd host names", () => {
    expect(parseAutoconfig(xml.replace(/<outgoingServer[\s\S]*<\/outgoingServer>/, ""), "example.com")).toBeNull();
    expect(parseAutoconfig(xml.replace(/smtp\.example\.com/, "smtp example/com"), "example.com")).toBeNull();
  });
});
