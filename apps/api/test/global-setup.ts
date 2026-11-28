import { ImapFlow } from "imapflow";
import { API_URL, IMAP_HOST, IMAP_PORT, TEST_PASSWORD, user } from "./env.ts";
import { startApi } from "./server.ts";

/**
 * Starts the real API server against the throwaway Postgres + Dovecot + Mailpit from `pnpm test:up`.
 * Tests then talk to it over HTTP, exactly like the web app does.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(label: string, fn: () => Promise<boolean>, ms = 60_000) {
  const t0 = Date.now();
  let last: unknown;
  while (Date.now() - t0 < ms) {
    try { if (await fn()) return; } catch (e) { last = e; }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}. Is the test stack running? Start it with: pnpm test:up\n${last ?? ""}`);
}

export default async function setup() {
  await until("test Dovecot (IMAP on :11143)", async () => {
    const c = new ImapFlow({ host: IMAP_HOST, port: IMAP_PORT, secure: false, doSTARTTLS: false, auth: { user: user(1), pass: TEST_PASSWORD }, logger: false });
    c.on("error", () => {});
    await c.connect(); await c.logout();
    return true;
  });

  // Fast background refresh so tests can observe it (production defaults are 30 s tick, 3 min / 1 min cadence).
  const server = await startApi(Number(new URL(API_URL).port), {
    NCMAIL_SNOOZE_TICK_MS: "1000",
    NCMAIL_IMAP_MAX_AGE_MS: "1500", // pooled connections are replaced quickly, so server-side caches (shared folders) refresh in tests
    // sync window and import limit: tests use small numbers so they are visible; the default window is "everything" so other tests see whole mailboxes
    NCMAIL_INITIAL_SYNC_MONTHS: "0", NCMAIL_CAP_MIN_MESSAGES: "5", NCMAIL_HEAVY_ROWS: "10", NCMAIL_MAX_HEAVY_SYNCS: "1", NCMAIL_BG_TICK_MS: "1000", NCMAIL_BG_HEALTHY_MS: "4000", NCMAIL_BG_DEGRADED_MS: "2000",
  });

  // Clean slate: accounts from an earlier run would otherwise hold IDLE connections and old data.
  const accounts: { id: string }[] = await (await fetch(`${API_URL}/api/accounts`)).json();
  for (const a of accounts) await fetch(`${API_URL}/api/accounts/${a.id}`, { method: "DELETE" });

  return () => server.stop();
}
