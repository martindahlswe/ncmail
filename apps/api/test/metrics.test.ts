import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApi } from "./server.ts";

/** The metrics endpoint for ops: off by default, on its own port, counts only. */
let api: { url: string; stop: () => Promise<void> };
const METRICS = "http://127.0.0.1:4198/metrics";

beforeAll(async () => { api = await startApi(4197, { NCMAIL_METRICS_PORT: "4198" }, "ncmail_metrics"); }, 60_000);
afterAll(async () => { await api?.stop(); });

describe("metrics", () => {
  it("serves Prometheus text with the version, accounts, pools and the database", async () => {
    const r = await fetch(METRICS);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/^text\/plain; version=0\.0\.4/);
    const body = await r.text();
    expect(body).toMatch(/^ncmail_info\{version="[^"]+"\} 1$/m);
    for (const name of ["ncmail_accounts", "ncmail_users", "ncmail_sync_heavy", "ncmail_imap_pool_connections", "ncmail_db_pool_connections", "ncmail_event_loop_delay_seconds", "ncmail_outbox_messages", "ncmail_other_instances"]) {
      expect(body).toContain(`# TYPE ${name} `);
    }
    expect(body).toMatch(/^ncmail_database_up 1$/m);
    // every sample line is "name{labels} number"
    for (const line of body.split("\n").filter((l) => l && !l.startsWith("#"))) expect(line).toMatch(/^[a-z_]+(\{[^}]*\})? -?[0-9.e+-]+$/);
  });

  it("counts API requests, and never shows addresses", async () => {
    const before = await (await fetch(METRICS)).text();
    const count = (b: string) => Number(b.match(/^ncmail_http_requests_total\{method="GET",status="2xx"\} (\d+)$/m)?.[1] ?? 0);
    await fetch(`${api.url}/api/health`); await fetch(`${api.url}/api/health`);
    const after = await (await fetch(METRICS)).text();
    expect(count(after)).toBeGreaterThanOrEqual(count(before) + 2);
    expect(after).not.toMatch(/@/);
  });

  it("answers only GET /metrics, and is not on the API's port", async () => {
    expect((await fetch("http://127.0.0.1:4198/other")).status).toBe(404);
    expect((await fetch(METRICS, { method: "POST" })).status).toBe(404);
    // the API's port answers unknown paths with the web app's page, never with the metrics
    expect(await (await fetch(`${api.url}/metrics`)).text()).not.toContain("ncmail_info");
  });
});
