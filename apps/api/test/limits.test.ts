import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMAP_HOST, IMAP_PORT, SMTP_PORT, TEST_PASSWORD, user } from "./env.ts";
import { mailpit, waitFor } from "./helpers.ts";
import { startApi } from "./server.ts";

/** Resource limits: the upload quota, the size of one message's attachments, fair, bounded outbox delivery, accounts per user and live-update streams per user. */
const U = user(26);
const QUOTA = 1024 * 1024; // NCMAIL_UPLOAD_QUOTA_MB=1
const PART = 600 * 1024;
const uploadDir = mkdtempSync(join(tmpdir(), "ncmail-limits-"));
let srv: { url: string; stop: () => Promise<void> };
let silent: Server;
const sockets: Socket[] = [];
let quick: string, slow: string; // accounts: a normal outgoing server, and one that accepts connections but never answers

const call = async (path: string, o: { method?: string; body?: unknown } = {}) => {
  const r = await fetch(`${srv.url}/api${path}`, { method: o.method ?? (o.body !== undefined ? "POST" : "GET"), headers: o.body !== undefined ? { "content-type": "application/json" } : undefined, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  const t = await r.text();
  return { status: r.status, data: t ? JSON.parse(t) : undefined };
};
const upload = async (size: number) => {
  const form = new FormData();
  form.append("file", new Blob([Buffer.alloc(size, 65)], { type: "application/octet-stream" }), "data.bin");
  try {
    const r = await fetch(`${srv.url}/api/uploads`, { method: "POST", body: form });
    return { status: r.status, body: await r.json() as any };
  } catch { return { status: 0, body: undefined }; } // a refused upload may also end the connection
};
const clearUploads = async (ids: string[]) => { for (const id of ids) await fetch(`${srv.url}/api/uploads/${id}`, { method: "DELETE" }); };
const addAccount = async (name: string, smtpPort: number) => {
  const r = await call("/accounts", { body: { name, email: U,
    imap: { host: IMAP_HOST, port: IMAP_PORT, security: "none", username: U, password: TEST_PASSWORD },
    smtp: { host: IMAP_HOST, port: smtpPort, security: "none", username: U, password: TEST_PASSWORD } } });
  expect(r.status).toBe(201);
  return r.data.id as string;
};
const outbox = async () => (await call("/outbox")).data as any[];

beforeAll(async () => {
  silent = createServer((s) => { sockets.push(s); s.on("error", () => {}); }); // never greets
  await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
  srv = await startApi(4151, { NCMAIL_UPLOAD_QUOTA_MB: "1", NCMAIL_UPLOAD_DIR: uploadDir, NCMAIL_OUTBOX_MAX: "3", NCMAIL_MAX_ACCOUNTS: "2", NCMAIL_MAX_EVENT_STREAMS: "2" }, "ncmail_limits");
  for (const a of (await call("/accounts")).data as any[]) await call(`/accounts/${a.id}`, { method: "DELETE" });
  quick = await addAccount("Quick", SMTP_PORT);
  slow = await addAccount("Slow", (silent.address() as any).port);
});
afterAll(async () => {
  await srv?.stop();
  for (const s of sockets) s.destroy();
  silent?.close();
  rmSync(uploadDir, { recursive: true, force: true });
});

describe("upload quota", () => {
  it("counts an upload against the quota while it arrives", async () => {
    const first = await upload(PART);
    expect(first.status).toBe(201);
    const second = await upload(PART);
    expect(second.status).toBe(413);
    expect(readdirSync(uploadDir)).toEqual([first.body.id]);
    await clearUploads([first.body.id]);
  });

  it("keeps parallel uploads within the quota and leaves no partial files", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => upload(PART)));
    const ok = results.filter((r) => r.status === 201);
    // Bytes still arriving count too, so all five may be refused; never more than the quota may be kept.
    expect(ok.length * PART).toBeLessThanOrEqual(QUOTA);
    expect(results.filter((r) => r.status !== 201).every((r) => r.status === 413 || r.status === 0)).toBe(true);
    expect(readdirSync(uploadDir).sort()).toEqual(ok.map((r) => r.body.id).sort());
    await clearUploads(ok.map((r) => r.body.id));
    // Refused uploads release what they reserved.
    const after = await upload(PART);
    expect(after.status).toBe(201);
    await clearUploads([after.body.id]);
  });
});

describe("attachments of one message", () => {
  it("rejects the same upload referenced twice", async () => {
    const u = await upload(1000);
    const r = await call(`/accounts/${quick}/send`, { body: { to: ["friend@example.org"], subject: "twice", text: "x", attachments: [{ uploadId: u.body.id }, { uploadId: u.body.id }] } });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/added twice/);
    await clearUploads([u.body.id]);
  });

  it("refuses attachments that together exceed the per-message limit", async () => {
    const u = await upload(PART);
    const inline = { filename: "more.bin", contentBase64: Buffer.alloc(PART, 66).toString("base64") };
    const r = await call(`/accounts/${quick}/send`, { body: { to: ["friend@example.org"], subject: "too big", text: "x", attachments: [{ uploadId: u.body.id }, inline] } });
    expect(r.status).toBe(413);
    await clearUploads([u.body.id]);
  });

  it("limits how many attachments one message or draft can have", async () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ filename: `f${i}.txt`, contentBase64: "eA==" }));
    expect((await call(`/accounts/${quick}/send`, { body: { to: ["friend@example.org"], text: "x", attachments: many } })).status).toBe(400);
    expect((await call(`/accounts/${quick}/drafts`, { body: { text: "x", attachments: many } })).status).toBe(400);
  });
});

describe("outbox delivery", () => {
  it("delivers other accounts' mail while one account's server does not answer", async () => {
    const tag = Date.now();
    const a1 = (await call(`/accounts/${slow}/send`, { body: { to: ["friend@example.org"], subject: `Slow 1 ${tag}`, text: "x", delaySeconds: 1 } })).data;
    const a2 = (await call(`/accounts/${slow}/send`, { body: { to: ["friend@example.org"], subject: `Slow 2 ${tag}`, text: "x", delaySeconds: 1 } })).data;
    const t0 = Date.now();
    await call(`/accounts/${quick}/send`, { body: { to: ["friend@example.org"], subject: `Quick ${tag}`, text: "x", delaySeconds: 1 } });
    await mailpit.bySubject(`Quick ${tag}`);
    expect(Date.now() - t0).toBeLessThan(8000);

    // one delivery per account at a time: the second message of the slow account is still waiting, and can be undone
    const rows = await outbox();
    expect(rows.find((o) => o.id === a1.outboxId)?.status).toBe("sending");
    expect(rows.find((o) => o.id === a2.outboxId)?.status).toBe("pending");
    expect((await call(`/outbox/${a2.outboxId}/cancel`, { method: "POST" })).data).toEqual({ cancelled: true });

    // a server that never answers ends in a visible failure, not a stuck message
    const failed = await waitFor(async () => (await outbox()).find((o) => o.id === a1.outboxId && o.status === "failed"), { timeout: 30_000, what: "slow delivery to fail" });
    expect(failed.error).toBeTruthy();
    await call(`/outbox/${a1.outboxId}`, { method: "DELETE" });
  });

  it("limits how many messages one person can have waiting", async () => {
    const later = new Date(Date.now() + 7 * 86400_000).toISOString();
    const send = (i: number) => call(`/accounts/${quick}/send`, { body: { to: ["friend@example.org"], subject: `Later ${i}`, text: "x", sendAt: later } });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) { const r = await send(i); expect(r.status).toBe(200); ids.push(r.data.outboxId); }
    const over = await send(3);
    expect(over.status).toBe(429);
    expect(over.data.error).toMatch(/can wait to be sent/);
    for (const id of ids) await call(`/outbox/${id}/cancel`, { method: "POST" });
    expect((await send(4)).status).toBe(200);
    for (const o of await outbox()) if (o.status === "pending") await call(`/outbox/${o.id}/cancel`, { method: "POST" });
  });
});

describe("accounts per user", () => {
  it("refuses another account beyond NCMAIL_MAX_ACCOUNTS with a clear message", async () => {
    const r = await call("/accounts", { body: { name: "Third", email: U,
      imap: { host: IMAP_HOST, port: IMAP_PORT, security: "none", username: U, password: TEST_PASSWORD },
      smtp: { host: IMAP_HOST, port: SMTP_PORT, security: "none", username: U, password: TEST_PASSWORD } } });
    expect(r.status).toBe(409);
    expect(r.data.error).toMatch(/at most 2 mail accounts/);
    expect((await call("/accounts")).data).toHaveLength(2);
  });
});

describe("live-update streams per user", () => {
  const open = async () => {
    const ctl = new AbortController();
    const r = await fetch(`${srv.url}/api/events`, { signal: ctl.signal });
    return { status: r.status, close: () => ctl.abort(), body: r };
  };

  it("refuses more than NCMAIL_MAX_EVENT_STREAMS at once, and frees a slot when one closes", async () => {
    const a = await open(), b = await open();
    expect([a.status, b.status]).toEqual([200, 200]);
    const c = await open();
    expect(c.status).toBe(429);
    expect(((await c.body.json()) as any).error).toMatch(/Too many open Mail windows/);
    a.close();
    const d = await waitFor(async () => { const s = await open(); if (s.status === 200) return s; }, { timeout: 5000, what: "a stream slot to free up" });
    b.close(); d.close();
  });
});
