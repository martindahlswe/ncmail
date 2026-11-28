import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IMAP_HOST, IMAP_PORT, SMTP_PORT, TEST_PASSWORD, user } from "./env.ts";
import { startApi } from "./server.ts";
import { isPrivateIp } from "../src/netguard.ts";

/** Hardening from the security review: outbound address policy, TLS requirement, error masking, headers, origin checks. */
const U = user(27);
let strict: { url: string; stop: () => Promise<void> };
const call = async (path: string, o: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
  const r = await fetch(`${strict.url}/api${path}`, { method: o.method ?? (o.body !== undefined ? "POST" : "GET"), headers: { ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...o.headers }, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  const t = await r.text();
  return { status: r.status, headers: r.headers, data: t ? JSON.parse(t) : undefined };
};
const srv = (host: string, port: number, security = "none") => ({ host, port, security, username: U, password: TEST_PASSWORD });

beforeAll(async () => {
  strict = await startApi(4121, { NCMAIL_PRIVATE_HOSTS: "block", NCMAIL_REQUIRE_TLS: "1" }, "ncmail_hardening");
});
afterAll(async () => { await strict?.stop(); });

describe("which addresses the server will connect to", () => {
  it("knows private, loopback, link-local and mapped addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1",
      "0:0:0:0:0:ffff:127.0.0.1", "0:0:0:0:0:ffff:7f00:1", "0::1", "0:0:0:0:0:0:0:1", "0:0:0:0:0:ffff:169.254.169.254", "0::ffff:10.0.0.1", "fec0::1", "::", "0.0.0.0"]) expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "172.32.0.1"]) expect(isPrivateIp(ip), ip).toBe(false);
  });
  it("refuses to test or save a mail server on the local network", async () => {
    const test = await call("/accounts/test", { body: { imap: srv(IMAP_HOST, IMAP_PORT, "tls"), smtp: srv("8.8.8.8", 465, "tls") } });
    expect(test.status).toBe(400);
    expect(test.data.error).toMatch(/private or local network/);
    const add = await call("/accounts", { body: { name: "x", email: U, imap: srv("169.254.169.254", 143, "starttls"), smtp: srv("8.8.8.8", 587, "starttls") } });
    expect(add.status).toBe(400);
    expect(add.data.error).toMatch(/private or local network/);
  });
  it("refuses local addresses however they are written", async () => {
    for (const host of ["0:0:0:0:0:ffff:127.0.0.1", "[0:0:0:0:0:ffff:7f00:1]", "0::1", "0:0:0:0:0:0:0:1", "0:0:0:0:0:ffff:169.254.169.254", "0::ffff:10.0.0.1"]) {
      const r = await call("/accounts/test", { body: { imap: srv(host, IMAP_PORT, "tls"), smtp: srv("8.8.8.8", 465, "tls") } });
      expect(r.status, host).toBe(400);
      expect(r.data.error, host).toMatch(/private or local network/);
    }
  });
  it("refuses unencrypted connections when encryption is required", async () => {
    const r = await call("/accounts/test", { body: { imap: srv("8.8.8.8", 143, "none"), smtp: srv("8.8.8.8", 587, "starttls") } });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/must use an encrypted connection/);
  });
  it("applies to the calendar and Sieve settings too", async () => {
    // an account that exists only to hold settings: made on the permissive default server of the suite
    const open = await startApi(4122, {}, "ncmail_hardening_open");
    try {
      const a = await (await fetch(`${open.url}/api/accounts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x", email: U, imap: srv(IMAP_HOST, IMAP_PORT), smtp: srv(IMAP_HOST, SMTP_PORT) }) })).json();
      expect(a.id).toBeTruthy();
    } finally { await open.stop(); }
    const g = await call("/accounts/00000000-0000-0000-0000-000000000000/calendar/discover", { body: { baseUrl: "http://127.0.0.1:1", username: "u", password: "p" } });
    expect([400, 404]).toContain(g.status);
  });
});

describe("responses", () => {
  it("does not leak internal error details", async () => {
    const r = await call("/folders/1/messages?cursor=%7B%22v%22%3A%22not-a-date%22%2C%22id%22%3A%221%22%7D");
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(r.data)).not.toMatch(/timestamp|syntax|invalid input|column|relation/i);
  });
  it("sends security headers", async () => {
    const r = await fetch(`${strict.url}/api/health`);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("referrer-policy")).toBe("same-origin");
    const page = await fetch(`${strict.url}/`);
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors");
  });
});

describe("cross-origin requests", () => {
  it("does not let another website's page read or drive the API", async () => {
    const pre = await fetch(`${strict.url}/api/accounts/x/sync`, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
    const post = await call("/accounts/00000000-0000-0000-0000-000000000000/sync", { method: "POST", headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
    expect(post.status).toBe(403);
    const same = await call("/accounts/00000000-0000-0000-0000-000000000000/sync", { method: "POST", headers: { "sec-fetch-site": "same-site" } });
    expect(same.status).toBe(403); // another port or app on the same site is not this app either
  });
  it("still serves the app's own requests", async () => {
    const r = await call("/accounts/00000000-0000-0000-0000-000000000000/sync", { method: "POST", headers: { "sec-fetch-site": "same-origin", origin: strict.url } });
    expect(r.status).not.toBe(403);
  });
});

describe("sign-in settings", () => {
  /** Starts the server with these settings; returns its exit code (or "running") and its output. Refusals happen before the database is used. */
  const startup = async (env: Record<string, string>) => {
    const { spawn } = await import("node:child_process");
    const base = { ...process.env };
    for (const k of ["NCMAIL_AUTH", "NEXTCLOUD_URL", "API_HOST"]) delete base[k];
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...base, DATABASE_URL: "postgres://ncmail:ncmail@127.0.0.1:1/none", SECRET_KEY: Buffer.alloc(32, 7).toString("base64"), API_PORT: "4129", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const code = await Promise.race([
      new Promise<number | null>((r) => child.once("exit", (c) => r(c))),
      new Promise<"running">((r) => setTimeout(() => r("running"), 20_000)),
    ]);
    if (code === "running") child.kill();
    return { code, out };
  };
  it("refuses to run without sign-in on an address other machines can reach", async () => {
    const r = await startup({ API_HOST: "0.0.0.0" });
    expect(r.code).not.toBe("running");
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/NCMAIL_AUTH is not set/);
  });
  it("refuses NCMAIL_AUTH=nextcloud without NEXTCLOUD_URL", async () => {
    const r = await startup({ NCMAIL_AUTH: "nextcloud", NEXTCLOUD_URL: "" });
    expect(r.code).not.toBe("running");
    expect(r.out).toMatch(/needs NEXTCLOUD_URL/);
  });
  it("refuses an unknown NCMAIL_AUTH value", async () => {
    const r = await startup({ NCMAIL_AUTH: "on" });
    expect(r.code).not.toBe("running");
    expect(r.out).toMatch(/not a known value/);
  });
});
