#!/usr/bin/env node
/**
 * Every check CI runs that this machine can run, in the same order, stopping at the first failure. Run it before pushing:
 *
 *   pnpm verify          typecheck, version check, the API tests, the build, the browser tests (Chromium and WebKit)
 *   pnpm verify:full     also the Nextcloud tests (one Nextcloud version) and the upgrade test from the latest release
 *
 * The test servers (testing/docker-compose.yml) are started when they are not running, and left running afterwards.
 * CI additionally runs the browser tests in Firefox, every supported Nextcloud version, the container image and a secret scan.
 */
import { spawnSync } from "node:child_process";

const full = process.argv.includes("--full");
const steps = [
  ["Typecheck", "pnpm", ["typecheck"]],
  ["Versions agree", "pnpm", ["version:check"]],
  ["Test servers", "pnpm", ["test:up"]],
  ["API tests", "pnpm", ["test"]],
  ["Build the web app", "pnpm", ["build"]],
  ["Browser tests (Chromium, WebKit)", "pnpm", ["--filter", "@ncmail/e2e", "exec", "playwright", "test", "--project=chromium", "--project=webkit"]],
  ...(full ? [
    ["Nextcloud tests (Nextcloud 34)", "pnpm", ["test:nextcloud"], { NC_VERSION: process.env.NC_VERSION ?? "34" }],
    ["Image for the upgrade test", "docker", ["build", "-q", "-t", "ncmail:upgrade-new", "."]],
    ["Upgrade from the latest release", "pnpm", ["test:upgrade"]],
  ] : []),
];

const started = Date.now();
for (const [name, cmd, args, env] of steps) {
  const t = Date.now();
  console.log(`\n▶ ${name}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...(env ?? {}) } });
  const secs = ((Date.now() - t) / 1000).toFixed(0);
  if (r.status !== 0) {
    console.error(`\n✗ ${name} failed (${secs} s). Fix it before pushing.`);
    process.exit(r.status ?? 1);
  }
  console.log(`✓ ${name} (${secs} s)`);
}
console.log(`\n✓ All checks passed in ${((Date.now() - started) / 60000).toFixed(1)} minutes${full ? "" : " (pnpm verify:full adds the Nextcloud and upgrade tests)"}.`);
