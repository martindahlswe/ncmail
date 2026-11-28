import type { FullConfig } from "@playwright/test";
import { E2E_PORT, E2E_USER, SEED } from "./fixtures.ts";

/**
 * Starts the service the way the API tests do (apps/api/test/server.ts), on its own port and database, and seeds one
 * mailbox with a few messages. Needs the test mail servers (`pnpm test:up`) and a built web app (`pnpm build`).
 */
export default async function setup(_: FullConfig) {
  process.env.TEST_API_URL = `http://127.0.0.1:${E2E_PORT}`;
  // the API tests' own helpers (typed and checked with the API, so loaded by path here)
  const from = (f: string) => new URL(`../apps/api/test/${f}`, import.meta.url).href;
  const { startApi } = await import(from("server.ts"));
  const { addAccount, deliver, resetMailbox, waitFor, api } = await import(from("helpers.ts"));

  await resetMailbox(E2E_USER);
  const base = new Date("2026-11-20T09:00:00Z").getTime();
  await deliver(E2E_USER, "INBOX", SEED.map((m, i) => ({ ...m, date: new Date(base + i * 3_600_000), seen: i !== 1 })));

  const server = await startApi(E2E_PORT, { NCMAIL_INITIAL_SYNC_MONTHS: "0", NCMAIL_BG_TICK_MS: "1000", NCMAIL_BG_HEALTHY_MS: "4000" }, "ncmail_e2e");
  // a clean slate: accounts from an earlier run would keep their old mirror
  for (const a of (await api("/accounts")) as { id: string }[]) await api(`/accounts/${a.id}`, { method: "DELETE" });
  const acct = await addAccount(E2E_USER);
  const inbox = await acct.folder("INBOX");
  await waitFor(async () => ((await api(`/folders/${inbox.id}/messages`)) as { items: unknown[] }).items.length === SEED.length, { what: "the seeded inbox to mirror" });
  return () => server.stop();
}
