import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { pool } from "./db.ts";
import { SERVICE_VERSION } from "./compat.ts";

/**
 * One service instance per database is the supported setup: some coordination lives inside the process (the per-account
 * lock around folder changes, the IMAP IDLE connections, the guard against syncing a folder twice at once). Each instance
 * writes a heartbeat; when another one is alive in the same database, this is logged and shown on the admin Mail page.
 */
const ID = randomUUID();
const BEAT_MS = 30_000;
/** An instance counts as running while its heartbeat is younger than this. */
const ALIVE = "interval '90 seconds'";

export interface OtherInstance { host: string; version: string; startedAt: string; seenAt: string }

export async function otherInstances(): Promise<OtherInstance[]> {
  const { rows } = await pool.query(
    `select host, version, started_at, seen_at from service_instances where id <> $1 and seen_at > now() - ${ALIVE} order by started_at`, [ID]);
  return rows.map((r) => ({ host: r.host, version: r.version, startedAt: r.started_at.toISOString(), seenAt: r.seen_at.toISOString() }));
}

export async function startHeartbeat(log: { warn: (o: object, m: string) => void }) {
  const beat = () => pool.query(
    `insert into service_instances (id, host, version) values ($1, $2, $3)
     on conflict (id) do update set seen_at = now()`, [ID, hostname(), SERVICE_VERSION]);
  let warned = "";
  const check = async () => {
    const others = await otherInstances();
    const key = others.map((o) => `${o.host}@${o.startedAt}`).join(",");
    if (others.length && key !== warned) {
      log.warn({ others: others.map((o) => ({ host: o.host, version: o.version, startedAt: o.startedAt })) },
        "Another NCMail service instance is using this database. Only one instance per database is supported: stop the others (docs/deployment.md).");
    }
    warned = key;
  };
  await beat();
  await check();
  setInterval(() => {
    beat().then(check).catch(() => {});
    pool.query(`delete from service_instances where seen_at < now() - interval '1 day'`).catch(() => {});
  }, BEAT_MS).unref();
  // A clean stop removes the heartbeat at once, so a restart does not look like a second instance. Listening for a signal
  // replaces Node's default of exiting, so after removing it (at most two seconds), the process ends with that signal as before.
  const leave = (signal: NodeJS.Signals) => {
    const end = () => process.kill(process.pid, signal);
    setTimeout(end, 2000).unref();
    pool.query("delete from service_instances where id = $1", [ID]).catch(() => {}).finally(end);
  };
  process.once("SIGTERM", leave);
  process.once("SIGINT", leave);
}
