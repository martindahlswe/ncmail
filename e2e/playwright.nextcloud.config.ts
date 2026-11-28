import { defineConfig, devices } from "@playwright/test";

/**
 * The Nextcloud app inside a real Nextcloud: NC_VERSION=33 pnpm test:nextcloud
 * nextcloud/setup.ts starts nextcloud:<NC_VERSION>-apache (SQLite, port 8099) with integration/nextcloud-app/ncmail mounted,
 * and the mail service with Nextcloud sign-in on port 4400. CI runs it for every Nextcloud version info.xml declares.
 */
export default defineConfig({
  testDir: "./nextcloud",
  globalSetup: "./nextcloud/setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report-nextcloud" }]] : "list",
  outputDir: "test-results-nextcloud",
  use: { baseURL: "http://127.0.0.1:8099", trace: "retain-on-failure", screenshot: "only-on-failure", viewport: { width: 1440, height: 900 } },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
});
