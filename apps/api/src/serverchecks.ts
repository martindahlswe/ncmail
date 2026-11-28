import { pool } from "./db.ts";
import { check, type ProbeResult } from "./mailprobe.ts";
import { safePresets, type MailServerPreset } from "./presets.ts";

/**
 * Connection checks of the mail servers set up for everybody, kept so the admin page can show each server's state (working,
 * certificate running out, not encrypted, not answering) without waiting. Re-run now and then in the background and on demand.
 */
export interface ServerStatus { imap: ProbeResult; smtp: ProbeResult; sieve: ProbeResult | null; checkedAt: string }

export async function checkServer(s: Pick<MailServerPreset, "imap" | "smtp" | "sieve">): Promise<Omit<ServerStatus, "checkedAt">> {
  const [imap, smtp, sieve] = await Promise.all([check("imap", s.imap), check("smtp", s.smtp), s.sieve ? check("sieve", s.sieve) : Promise.resolve(null)]);
  return { imap, smtp, sieve };
}

async function store(id: string, r: Omit<ServerStatus, "checkedAt">) {
  await pool.query(
    `insert into mail_server_status (server_id, result, checked_at) values ($1, $2, now())
     on conflict (server_id) do update set result = excluded.result, checked_at = now()`, [id, JSON.stringify(r)]);
}

/** Check every listed server (a few at a time) and forget the results of servers that are gone. */
let running: Promise<Record<string, ServerStatus>> | null = null;
export function checkAll(): Promise<Record<string, ServerStatus>> {
  return (running ??= (async () => {
    const servers = safePresets().servers;
    for (let i = 0; i < servers.length; i += 4) {
      await Promise.all(servers.slice(i, i + 4).map(async (s) => store(s.id, await checkServer(s))));
    }
    await pool.query("delete from mail_server_status where not (server_id = any($1::text[]))", [servers.map((s) => s.id)]);
    return statuses();
  })().finally(() => { running = null; }));
}

/** Check the given servers in the background (after they were added or changed). */
export function recheck(servers: MailServerPreset[]) {
  void (async () => { for (const s of servers) await store(s.id, await checkServer(s)).catch(() => {}); })();
}

export async function statuses(): Promise<Record<string, ServerStatus>> {
  const { rows } = await pool.query("select server_id, result, checked_at from mail_server_status");
  return Object.fromEntries(rows.map((r) => [r.server_id, { ...r.result, checkedAt: r.checked_at.toISOString() }]));
}

/** NCMAIL_SERVER_CHECK_HOURS (default 6, 0 = never): how often the listed servers are checked in the background. */
export function startServerChecks(log: { warn: (o: object, m: string) => void }) {
  const hours = Number(process.env.NCMAIL_SERVER_CHECK_HOURS ?? 6);
  if (!(hours > 0)) return;
  const run = () => checkAll().catch((e) => log.warn({ err: e?.message }, "checking the mail servers failed"));
  setTimeout(run, 60_000).unref();
  setInterval(run, hours * 3_600_000).unref();
}
