import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { ADMIN, APP_VERSION, CONTAINER, NC_VERSION, SERVICE_URL } from "./env.ts";

/** The Nextcloud app in a real Nextcloud of the version under test: install, menu entry and sign-in, admin page, sign-out. */
/** The add-account form's button: what a new user sees once the frame is signed in. */
const addAccount = (page: Page) => page.frameLocator(`iframe[src^="${SERVICE_URL}"]`).locator("button.btn.primary", { hasText: /^Add account$/ });
const occ = (...args: string[]) => execFileSync("docker", ["exec", "-u", "www-data", CONTAINER, "php", "occ", ...args], { encoding: "utf8" });

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/Account name or email|Login or email|Username or email/i).fill(ADMIN.user);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
  await page.getByLabel("Password", { exact: true }).press("Enter");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

test(`the app installs and is enabled in Nextcloud ${NC_VERSION}`, async () => {
  const apps = JSON.parse(occ("app:list", "--output=json")) as { enabled: Record<string, string> };
  expect(apps.enabled.ncmail).toBe(APP_VERSION);
});

test("Mail in the menu opens the app, signed in as the Nextcloud user", async ({ page }) => {
  await signIn(page);
  await page.goto("/apps/ncmail/");
  // the service's page in Nextcloud's frame, signed in through the token Nextcloud hands it: a new user is asked to add an account
  await expect(addAccount(page)).toBeVisible({ timeout: 30_000 });
  const me = await (await page.request.get(`${SERVICE_URL}/api/auth/me`)).json();
  expect(me).toMatchObject({ authRequired: true, user: ADMIN.user });
});

test("the admin Mail page talks to the service through signed calls", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings/admin/ncmail");
  await expect(page.getByRole("heading", { name: "Mail servers" })).toBeVisible();
  // the version note and the server list both come from signed calls to the service
  await expect(page.getByText(`Nextcloud app and mail service are both version ${APP_VERSION}.`)).toBeVisible();
  await expect(page.getByText("No mail servers yet")).toBeVisible();
});

test("signing out of Nextcloud ends the Mail session", async ({ page }) => {
  await signIn(page);
  await page.goto("/apps/ncmail/");
  await expect(addAccount(page)).toBeVisible({ timeout: 30_000 });
  expect((await (await page.request.get(`${SERVICE_URL}/api/auth/me`)).json()).user).toBe(ADMIN.user);
  const token = await page.evaluate(() => (window as any).OC.requestToken as string);
  await page.goto(`/logout?requesttoken=${encodeURIComponent(token)}`);
  await page.waitForURL((u) => u.pathname.startsWith("/login"));
  // Nextcloud tells the service (a signed call), which ends the session at once
  await expect.poll(async () => (await (await page.request.get(`${SERVICE_URL}/api/auth/me`)).json()).user, { timeout: 15_000 }).toBeNull();
});
