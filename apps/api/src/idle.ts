import { guardedLookup } from "./netguard.ts";
import type { ImapFlow } from "imapflow";
import { pool } from "./db.ts";
import { loadAccount } from "./accounts.ts";
import { imapClient } from "./mail.ts";
import { syncAccount, syncFolder } from "./sync.ts";

/**
 * One long-lived IMAP connection per account sits in IDLE on the INBOX. The server announces changes
 * (EXISTS / EXPUNGE / FLAGS), we run the normal incremental sync, and sync publishes an event to the
 * browsers. Connections reconnect with backoff and do a catch-up sync each time they (re)establish.
 * Servers without IDLE are covered by the periodic background sync.
 */

interface Watcher { state: string; lastEvent?: string; stop: () => void }
const watchers = new Map<string, Watcher>();
type Log = { error: (...a: any[]) => void; info: (...a: any[]) => void };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msg = (e: any) => e?.responseText || e?.message || String(e);

async function inboxFolder(accountId: string) {
  const { rows } = await pool.query("select id, path from folders where account_id = $1 and special_use = '\\Inbox'", [accountId]);
  return rows[0] as { id: string; path: string } | undefined;
}

function watch(accountId: string, log: Log): Watcher {
  let stopped = false;
  let client: ImapFlow | null = null;
  const w: Watcher = { state: "starting", stop() { stopped = true; client?.close(); } };

  // Coalesce bursts of events; if more arrive during a sync, run once more afterwards.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false, again = false;
  const trigger = (folderId: string, why: string) => {
    w.lastEvent = `${why} @ ${new Date().toISOString()}`;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (running) { again = true; return; }
      running = true;
      try { do { again = false; await syncFolder(folderId); } while (again); }
      catch (e) { log.error(e, "idle-triggered sync failed"); }
      finally { running = false; }
    }, 300);
  };

  (async () => {
    let backoff = 2_000;
    while (!stopped) {
      try {
        const cfg = await loadAccount(accountId);
        let inbox = await inboxFolder(accountId);
        if (!inbox) { await syncAccount(accountId); inbox = await inboxFolder(accountId); }
        if (!inbox) throw new Error("INBOX not found");

        // autoIdleDelay: enter IDLE almost immediately (default is 15s of inactivity).
        const c = (client = imapClient(cfg.imap, await guardedLookup(cfg.imap.host, "mail server", undefined, cfg.imap.port), { autoIdleDelay: 1000 }));
        c.on("error", () => {});
        const closed = new Promise<void>((res) => c.once("close", () => res()));
        c.on("exists", () => trigger(inbox!.id, "exists"));
        c.on("expunge", () => trigger(inbox!.id, "expunge"));
        c.on("flags", () => trigger(inbox!.id, "flags"));
        await c.connect();
        // Open WITHOUT a lock: ImapFlow never starts IDLE while a mailbox lock is held.
        await c.mailboxOpen(inbox.path, { readOnly: true });
        w.state = c.capabilities.has("IDLE") ? "idle" : "polling (server has no IDLE)";
        backoff = 2_000;
        trigger(inbox.id, "connected (catch-up)");
        await closed;
        w.state = "disconnected";
      } catch (e) {
        w.state = `error: ${msg(e)}`;
        log.error({ accountId, err: msg(e) }, "IDLE watcher error");
      }
      if (stopped) break;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60_000);
    }
    w.state = "stopped";
  })();
  return w;
}

/** Start watchers for new accounts, stop them for removed ones. */
export async function reconcileIdle(log: Log) {
  const { rows } = await pool.query("select id from accounts");
  const ids = new Set<string>(rows.map((r) => r.id));
  for (const id of ids) if (!watchers.has(id)) watchers.set(id, watch(id, log));
  for (const [id, w] of watchers) if (!ids.has(id)) { w.stop(); watchers.delete(id); }
}

/** Drop and recreate one account's watcher (e.g. after its server settings or password changed). */
export function restartIdle(accountId: string, log: Log) {
  watchers.get(accountId)?.stop();
  watchers.delete(accountId);
  return reconcileIdle(log);
}

export function startIdle(log: Log) {
  reconcileIdle(log).catch((e) => log.error(e, "idle reconcile failed"));
  setInterval(() => reconcileIdle(log).catch(() => {}), 15_000).unref();
}

/** True while the account has a live IDLE connection. */
export const isIdleHealthy = (accountId: string) => watchers.get(accountId)?.state === "idle";

export const idleStatus = () => [...watchers].map(([accountId, w]) => ({ accountId, state: w.state, lastEvent: w.lastEvent }));
