import type { FastifyInstance } from "fastify";
import { createServer, type Server } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { bgPool, pool } from "./db.ts";
import { SERVICE_VERSION } from "./compat.ts";
import { syncStatus } from "./sync.ts";
import { idleStatus } from "./idle.ts";
import { imapPoolStats } from "./mail.ts";
import { allStreams } from "./events.ts";
import { otherInstances } from "./instances.ts";
import { statuses } from "./serverchecks.ts";

/**
 * Metrics for ops in Prometheus' text format, off by default. With NCMAIL_METRICS_PORT set, a separate small HTTP server
 * answers GET /metrics on NCMAIL_METRICS_HOST (default 127.0.0.1), never on the public API's port. Counts only: no
 * addresses, subjects, user ids or server names of people's accounts.
 */
const requests = new Map<string, number>(); // "GET 2xx" -> count
let durationSum = 0, durationCount = 0;
const loop = monitorEventLoopDelay({ resolution: 20 });

/** Count every API request by method and status class, and their total duration. */
export function countRequests(app: FastifyInstance) {
  app.addHook("onResponse", async (req, reply) => {
    const key = `${req.method} ${Math.floor(reply.statusCode / 100)}xx`;
    requests.set(key, (requests.get(key) ?? 0) + 1);
    durationSum += reply.elapsedTime / 1000; durationCount++;
  });
}

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
type Sample = [labels: Record<string, string | number>, value: number];
function metric(out: string[], name: string, type: "gauge" | "counter", help: string, samples: Sample[]) {
  out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  for (const [labels, value] of samples) {
    const l = Object.entries(labels).map(([k, v]) => `${k}="${esc(String(v))}"`).join(",");
    out.push(`${name}${l ? `{${l}}` : ""} ${Number.isFinite(value) ? value : 0}`);
  }
}

export async function renderMetrics(): Promise<string> {
  const out: string[] = [];
  const one = (v: number): Sample[] => [[{}, v]];
  metric(out, "ncmail_info", "gauge", "The running version.", [[{ version: SERVICE_VERSION }, 1]]);
  metric(out, "ncmail_uptime_seconds", "gauge", "Seconds since the service started.", one(process.uptime()));
  const mem = process.memoryUsage();
  metric(out, "ncmail_memory_bytes", "gauge", "Process memory.", [[{ kind: "rss" }, mem.rss], [{ kind: "heap_used" }, mem.heapUsed], [{ kind: "external" }, mem.external]]);
  metric(out, "ncmail_event_loop_delay_seconds", "gauge", "Event loop delay since the last scrape (high values mean the service is overloaded).",
    [[{ quantile: "0.5" }, loop.percentile(50) / 1e9], [{ quantile: "0.99" }, loop.percentile(99) / 1e9], [{ quantile: "1" }, loop.max / 1e9]]);
  loop.reset();

  metric(out, "ncmail_http_requests_total", "counter", "API requests by method and status class.",
    [...requests].map(([k, v]) => { const [method, status] = k.split(" "); return [{ method: method!, status: status! }, v] as Sample; }));
  metric(out, "ncmail_http_request_duration_seconds_sum", "counter", "Total time spent answering API requests.", one(durationSum));
  metric(out, "ncmail_http_request_duration_seconds_count", "counter", "API requests timed.", one(durationCount));
  metric(out, "ncmail_live_streams", "gauge", "Open live-update connections (Mail windows and tabs).", one(allStreams()));

  const sync = syncStatus();
  metric(out, "ncmail_sync_heavy", "gauge", "Big imports: the limit, running now, waiting for a slot, and the most ever running at once.",
    [[{ state: "limit" }, sync.limit], [{ state: "running" }, sync.running], [{ state: "waiting" }, sync.waiting], [{ state: "peak" }, sync.peak]]);
  const idle = new Map<string, number>();
  for (const w of idleStatus()) idle.set(w.state.split(" ")[0]!, (idle.get(w.state.split(" ")[0]!) ?? 0) + 1);
  metric(out, "ncmail_imap_idle_accounts", "gauge", "Accounts by the state of their live (IDLE) connection.", [...idle].map(([state, n]) => [{ state }, n] as Sample));
  const imap = imapPoolStats();
  metric(out, "ncmail_imap_pool_connections", "gauge", "Pooled IMAP connections.", [[{ state: "in_use" }, imap.inUse], [{ state: "idle" }, imap.idle]]);
  metric(out, "ncmail_db_pool_connections", "gauge", "Database connections, for requests and for background work.", [
    [{ pool: "requests", state: "total" }, pool.totalCount], [{ pool: "requests", state: "idle" }, pool.idleCount], [{ pool: "requests", state: "waiting" }, pool.waitingCount],
    [{ pool: "background", state: "total" }, bgPool.totalCount], [{ pool: "background", state: "idle" }, bgPool.idleCount], [{ pool: "background", state: "waiting" }, bgPool.waitingCount],
  ]);

  try {
    const { rows: [c] } = await pool.query(`select (select count(*) from accounts)::int as accounts, (select count(distinct owner) from accounts)::int as users,
      (select count(*) from outbox where status in ('pending','sending'))::int as outbox, (select count(*) from outbox where status = 'failed')::int as failed`);
    metric(out, "ncmail_accounts", "gauge", "Mail accounts.", one(c.accounts));
    metric(out, "ncmail_users", "gauge", "Nextcloud users with at least one mail account.", one(c.users));
    metric(out, "ncmail_outbox_messages", "gauge", "Messages waiting to be sent (undo send, send later) and ones that failed.", [[{ state: "waiting" }, c.outbox], [{ state: "failed" }, c.failed]]);
    const st = Object.values(await statuses());
    const parts = st.flatMap((s) => [s.imap, s.smtp, s.sieve].filter(Boolean) as { ok: boolean; warning?: string }[]);
    metric(out, "ncmail_mail_server_checks", "gauge", "Results of the last checks of the administrator's mail servers, by state.", [
      [{ state: "ok" }, parts.filter((p) => p.ok && !p.warning).length], [{ state: "warning" }, parts.filter((p) => p.ok && p.warning).length], [{ state: "failing" }, parts.filter((p) => !p.ok).length],
    ]);
    metric(out, "ncmail_other_instances", "gauge", "Other service instances on the same database (should be 0).", one((await otherInstances()).length));
    metric(out, "ncmail_database_up", "gauge", "Whether the database answered.", one(1));
  } catch {
    metric(out, "ncmail_database_up", "gauge", "Whether the database answered.", one(0));
  }
  return out.join("\n") + "\n";
}

/** The metrics server, when NCMAIL_METRICS_PORT is set. */
export function startMetrics(log: { info: (o: object, m: string) => void }): Server | null {
  const port = Number(process.env.NCMAIL_METRICS_PORT);
  if (!port) return null;
  const host = process.env.NCMAIL_METRICS_HOST || "127.0.0.1";
  loop.enable();
  const server = createServer((req, res) => {
    if (req.method !== "GET" || (req.url ?? "").split("?")[0] !== "/metrics") { res.writeHead(404).end(); return; }
    renderMetrics().then((body) => { res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" }).end(body); })
      .catch(() => { res.writeHead(500).end(); });
  });
  server.listen(port, host, () => log.info({ host, port }, "metrics at /metrics"));
  server.unref();
  return server;
}
