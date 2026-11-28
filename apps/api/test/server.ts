import { spawn } from "node:child_process";
import pg from "pg";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PG = process.env.TEST_PG_URL || "postgres://ncmail:ncmail@127.0.0.1:15432"; // the scale benchmark points this at its own server

/** Create a database if it does not exist (used to give a second server its own data). */
async function ensureDatabase(name: string) {
  const c = new pg.Client({ connectionString: `${PG}/ncmail_test` });
  await c.connect();
  try {
    const { rowCount } = await c.query("select 1 from pg_database where datname = $1", [name]);
    if (!rowCount) await c.query(`create database ${name}`);
  } finally { await c.end(); }
}

/**
 * Starts the real API server. `env` can change its behaviour (e.g. NCMAIL_NO_LIST_STATUS).
 * Pass `database` to give the server its own database; servers sharing one database also share (and sync) each other's accounts.
 */
export async function startApi(port: number, env: Record<string, string> = {}, database = "ncmail_test") {
  if (database !== "ncmail_test") await ensureDatabase(database);
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      DATABASE_URL: `${PG}/${database}`,
      SECRET_KEY: Buffer.alloc(32, 7).toString("base64"),
      API_PORT: String(port),
      NEXTCLOUD_URL: "",
      NCMAIL_PRIVATE_HOSTS: "allow", // the test mail servers are on 127.0.0.1
      NCMAIL_MAX_ACCOUNTS: "0", // the whole suite adds many accounts for one user; limits.test.ts sets its own
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  const echo = !!process.env.DEBUG_TEST_SERVER; // DEBUG_TEST_SERVER=1 pnpm test  prints the server's own log
  child.stdout?.on("data", (d) => { log += d; if (echo) process.stdout.write(`[api:${port}] ${d}`); });
  child.stderr?.on("data", (d) => { log += d; if (echo) process.stdout.write(`[api:${port}] ${d}`); });
  child.on("exit", (code) => { if (code) console.error(`API server on :${port} exited with ${code}\n${log.slice(-2000)}`); });

  const url = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    try { if ((await fetch(`${url}/api/health`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() - t0 > 60_000) { child.kill(); throw new Error(`API server on :${port} did not start.\n--- server output ---\n${log.slice(-2000)}`); }
    await sleep(400);
  }
  return {
    url,
    stop: async () => { child.kill("SIGTERM"); await Promise.race([new Promise((r) => child.once("exit", r)), sleep(5000)]); },
  };
}
