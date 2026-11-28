import { execFileSync } from "node:child_process";
import type { FullConfig } from "@playwright/test";
import { ADMIN, APP_DIR, CONTAINER, NC_URL, NC_VERSION, SERVICE_PORT, SERVICE_URL } from "./env.ts";

const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const occ = (...args: string[]) => docker("exec", "-u", "www-data", CONTAINER, "php", "occ", ...args);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A throwaway Nextcloud of the version under test with the Mail app mounted, and the mail service with Nextcloud sign-in.
 * Needs Docker and the test mail servers (`pnpm test:up`; the service keeps its data in their PostgreSQL).
 */
export default async function setup(_: FullConfig) {
  try { docker("rm", "-f", CONTAINER); } catch { /* none */ }
  console.log(`[nextcloud] starting Nextcloud ${NC_VERSION}`);
  docker("run", "-d", "--name", CONTAINER, "-p", "127.0.0.1:8099:80", "--add-host", "host.docker.internal:host-gateway",
    "-e", "SQLITE_DATABASE=nextcloud", "-e", `NEXTCLOUD_ADMIN_USER=${ADMIN.user}`, "-e", `NEXTCLOUD_ADMIN_PASSWORD=${ADMIN.password}`,
    "-e", "NEXTCLOUD_TRUSTED_DOMAINS=127.0.0.1 localhost",
    "-v", `${APP_DIR}:/var/www/html/custom_apps/ncmail:ro`, `nextcloud:${NC_VERSION}-apache`);
  const t0 = Date.now();
  for (;;) {
    try { if (/"installed":true/.test(occ("status", "--output=json"))) break; } catch { /* still installing */ }
    if (Date.now() - t0 > 360_000) { console.error(docker("logs", "--tail", "60", CONTAINER)); throw new Error(`Nextcloud ${NC_VERSION} did not finish installing`); }
    await sleep(2000);
  }
  console.log(`[nextcloud] installed: ${JSON.parse(occ("status", "--output=json")).versionstring}`);
  occ("config:system:set", "allow_local_remote_servers", "--type=boolean", "--value=true");
  for (const app of ["firstrunwizard", "nextcloud_announcements", "recommendations", "dashboard"]) { try { occ("app:disable", app); } catch { /* not installed */ } }
  try { occ("app:enable", "ncmail"); }
  catch (e: any) { throw new Error(`Nextcloud ${NC_VERSION} would not enable the app: ${String(e.stdout || e.stderr || e.message).trim()}`); }
  occ("config:app:set", "ncmail", "url", `--value=${SERVICE_URL}`);
  occ("config:app:set", "ncmail", "serverUrl", `--value=http://host.docker.internal:${SERVICE_PORT}`); // the container reaches the service on the host

  // the mail service, signed in through Nextcloud (it fetches Nextcloud's signing key itself)
  const from = (f: string) => new URL(`../../apps/api/test/${f}`, import.meta.url).href;
  const { startApi } = await import(from("server.ts"));
  const service = await startApi(SERVICE_PORT, {
    NCMAIL_AUTH: "nextcloud", NEXTCLOUD_URL: NC_URL, NCMAIL_PUBLIC_URL: SERVICE_URL, API_HOST: "0.0.0.0", NCMAIL_SERVER_CHECK_HOURS: "0",
  }, "ncmail_nc");
  return async () => {
    await service.stop();
    if (!process.env.KEEP_NEXTCLOUD) { try { docker("rm", "-f", CONTAINER); } catch { /* gone */ } }
  };
}
