import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests of the web app against the real service and the throwaway mail servers of `pnpm test:up`.
 * setup.ts starts its own API (port 4200, database ncmail_e2e) serving the built web app, and seeds one mailbox.
 * The three engines run one after another against the same mailbox, so every test leaves it as it found it.
 */
export default defineConfig({
  testDir: "./tests",
  globalSetup: "./setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:4200",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "firefox", use: { ...devices["Desktop Firefox"], viewport: { width: 1440, height: 900 } } },
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 900 } } },
  ],
});
