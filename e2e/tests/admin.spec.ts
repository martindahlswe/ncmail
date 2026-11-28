import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * The Nextcloud app's admin Mail page (integration/nextcloud-app/ncmail/js/admin.js). There is no Nextcloud in CI, so the
 * real script and stylesheet run in a small stand-in page, and the routes the page calls are answered by a fake mail
 * service that keeps its state in memory.
 */
const APP = new URL("../../integration/nextcloud-app/ncmail/", import.meta.url).pathname;
const ORIGIN = "http://nextcloud.test";

const page$ = `<!doctype html><html><head><meta charset="utf-8"><title>Mail - Administration</title>
<link rel="stylesheet" href="/custom_apps/ncmail/css/admin.css"></head>
<body><script>window.OC = { requestToken: "test-token", generateUrl: (p) => "/index.php" + p, getCurrentUser: () => ({ uid: "admin" }) };</script>
<div class="section" id="ncmail-admin"><div id="ncmail-servers"></div></div>
<script src="/custom_apps/ncmail/js/admin.js"></script></body></html>`;

const corp = {
  id: "srv-corp", name: "Company mail", domains: ["example.com"], username: "email",
  imap: { host: "imap.example.com", port: 993, security: "tls" }, smtp: { host: "smtp.example.com", port: 465, security: "tls" },
};

interface Fake { view: any; saved: any[]; checks: any[] }
async function open(page: Page, init: { servers?: any[]; status?: any; fileServers?: any[]; versions?: any } = {}): Promise<Fake> {
  const fake: Fake = {
    view: { file: { configured: !!init.fileServers, allowCustom: true, servers: init.fileServers ?? [] }, admin: { allowCustom: true, servers: init.servers ?? [] }, status: init.status ?? {}, updatedAt: null, updatedBy: "" },
    saved: [], checks: [],
  };
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route(`${ORIGIN}/**`, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === "/settings/admin/ncmail") return route.fulfill({ contentType: "text/html", body: page$ });
    if (path === "/custom_apps/ncmail/js/admin.js") return route.fulfill({ contentType: "text/javascript", body: readFileSync(APP + "js/admin.js", "utf8") });
    if (path === "/custom_apps/ncmail/css/admin.css") return route.fulfill({ contentType: "text/css", body: readFileSync(APP + "css/admin.css", "utf8") });
    if (path.startsWith("/index.php/apps/ncmail/admin/mail-servers") && req.headers()["requesttoken"] !== "test-token") return json(route, { message: "CSRF check failed" }, 412);
    if (path === "/index.php/apps/ncmail/admin/versions") return json(route, init.versions ?? { app: { version: "0.4.2", minServiceVersion: "0.4.1" }, service: { version: "0.4.2", minAppVersion: "0.4.1" } });
    if (path === "/index.php/apps/ncmail/admin/mail-servers" && req.method() === "GET") return json(route, fake.view);
    if (path === "/index.php/apps/ncmail/admin/mail-servers" && req.method() === "PUT") {
      const { config } = req.postDataJSON();
      fake.saved.push(config);
      fake.view = { ...fake.view, admin: config, updatedAt: new Date().toISOString(), updatedBy: "admin" };
      return json(route, fake.view);
    }
    if (path.endsWith("/check")) {
      const body = req.postDataJSON();
      fake.checks.push(body);
      // the SMTP server does not answer on 465, but does on 587 with STARTTLS
      const smtp = body.smtp.port === 465
        ? { ok: false, message: "Nothing answers on port 465.", suggestion: { port: 587, security: "starttls" } }
        : { ok: true, message: "Answers, and the certificate is valid until 2027-06-01." };
      return json(route, { imap: { ok: true, message: "Answers, and the certificate is valid until 2027-06-01." }, smtp, sieve: null });
    }
    if (path.endsWith("/check-all")) return json(route, { status: { [corp.id]: { imap: { ok: true, message: "ok" }, smtp: { ok: true, message: "ok" }, sieve: null, checkedAt: new Date().toISOString() } } });
    if (path.endsWith("/discover")) {
      const { domain } = req.postDataJSON();
      if (domain !== "posteo.example") return json(route, { found: null });
      return json(route, {
        found: { source: "autoconfig", from: "autoconfig.posteo.example", name: "Posteo", username: "email", imap: { host: "posteo.example", port: 993, security: "tls" }, smtp: { host: "posteo.example", port: 465, security: "tls" } },
        status: { imap: { ok: true, message: "Answers" }, smtp: { ok: true, message: "Answers" }, sieve: null },
      });
    }
    return route.fulfill({ status: 404, body: "not found" });
  });
  await page.goto(`${ORIGIN}/settings/admin/ncmail`);
  await expect(page.getByRole("heading", { name: "Mail servers" })).toBeVisible();
  return fake;
}

test("shows each server's state from its last check, and servers from the file as read-only", async ({ page }) => {
  await open(page, {
    servers: [corp],
    fileServers: [{ ...corp, id: "legacy", name: "Legacy relay", domains: [], smtp: { host: "10.0.0.12", port: 25, security: "none" } }],
    status: {
      [corp.id]: { imap: { ok: true, message: "ok", warning: "cert-soon", certExpires: new Date(Date.now() + 9 * 86_400_000).toISOString() }, smtp: { ok: true, message: "ok" }, sieve: null, checkedAt: new Date().toISOString() },
      legacy: { imap: { ok: true, message: "ok" }, smtp: { ok: true, message: "plain", warning: "plain" }, sieve: null, checkedAt: new Date().toISOString() },
    },
  });
  const table = page.getByRole("table", { name: "Mail servers" });
  await expect(table.getByRole("row").filter({ hasText: "Company mail" })).toContainText("Certificate expires soon");
  const legacy = table.getByRole("row").filter({ hasText: "Legacy relay" });
  await expect(legacy).toContainText("Outgoing not encrypted");
  await expect(legacy).toContainText("Change it there");
  await expect(legacy.getByRole("button")).toHaveCount(0); // no Edit or Remove for the file's servers
  // what people see, for an address the listed server is suggested for
  await expect(page.getByRole("complementary", { name: "What people see" })).toContainText("Company mail is set up for them");
});

test("adds a server found from a domain", async ({ page }) => {
  const fake = await open(page);
  await page.getByRole("button", { name: "Add mail server" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add mail server" });
  await dialog.getByLabel("Email domain").fill("posteo.example");
  await dialog.getByRole("button", { name: "Look up" }).click();
  await expect(dialog).toContainText("Found the servers for posteo.example");
  await expect(dialog.getByLabel("Name people see")).toHaveValue("Posteo");
  await dialog.getByRole("button", { name: "Add server" }).click();
  await expect(page.getByRole("status")).toContainText("Added Posteo.");
  expect(fake.saved.at(-1).servers).toEqual([expect.objectContaining({ name: "Posteo", domains: ["posteo.example"], imap: { host: "posteo.example", port: 993, security: "tls" } })]);
});

test("offers to enter the servers by hand when a domain publishes none", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Add mail server" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add mail server" });
  await dialog.getByLabel("Email domain").fill("nothing.example");
  await dialog.getByRole("button", { name: "Look up" }).click();
  await expect(dialog).toContainText("No published settings for nothing.example");
  await dialog.getByRole("button", { name: "Enter the servers myself" }).click();
  const panel = page.getByRole("dialog", { name: "Add mail server" });
  await expect(panel.getByRole("textbox", { name: "IMAP server" })).toHaveValue("imap.nothing.example");
  await expect(panel.getByRole("textbox", { name: "SMTP server" })).toHaveValue("smtp.nothing.example");
});

test("edits a server, checks it, and takes the suggested port", async ({ page }) => {
  const fake = await open(page, { servers: [corp] });
  await page.getByRole("button", { name: "Edit Company mail" }).click();
  const panel = page.getByRole("dialog", { name: "Edit Company mail" });
  // domains are tags: add one with Enter
  await panel.getByRole("textbox", { name: "Add a domain" }).fill("example.org");
  await panel.getByRole("textbox", { name: "Add a domain" }).press("Enter");
  await expect(panel.getByRole("button", { name: "Remove example.org" })).toBeVisible();
  await panel.getByRole("button", { name: "Check connection" }).click();
  await expect(panel).toContainText("Nothing answers on port 465.");
  await panel.getByRole("button", { name: "Use 587" }).click();
  await expect(panel.getByRole("spinbutton", { name: "SMTP port" })).toHaveValue("587");
  await expect(panel.getByRole("group", { name: "SMTP security" }).getByRole("button", { name: "STARTTLS" })).toHaveAttribute("aria-pressed", "true");
  await panel.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status")).toContainText("Saved Company mail.");
  expect(fake.saved.at(-1).servers[0]).toMatchObject({ domains: ["example.com", "example.org"], smtp: { port: 587, security: "starttls" } });
});

test("locks people to the listed servers", async ({ page }) => {
  // two servers: with only one, it is suggested to everybody whatever their address
  const fake = await open(page, { servers: [corp, { ...corp, id: "srv-lab", name: "Lab mail", domains: ["lab.example"] }] });
  await page.getByRole("radio", { name: /Only the servers listed here/ }).check();
  await expect(page.getByRole("status")).toContainText("only use the servers listed here");
  expect(fake.saved.at(-1).allowCustom).toBe(false);
  await page.getByRole("textbox", { name: "Preview for the address" }).fill("kim@elsewhere.example");
  await page.getByRole("textbox", { name: "Preview for the address" }).press("Tab");
  await expect(page.getByRole("complementary", { name: "What people see" })).toContainText("they cannot add it");
});

test.describe("the Nextcloud app's and the mail service's versions", () => {
  const app = (version: string) => ({ version, minServiceVersion: "0.4.1" });
  const service = (version: string, minAppVersion: string | null = "0.4.1") => ({ version, minAppVersion });

  test("says so quietly when they match", async ({ page }) => {
    await open(page, { versions: { app: app("0.4.2"), service: service("0.4.2") } });
    await expect(page.getByText("Nextcloud app and mail service are both version 0.4.2.")).toBeVisible();
  });
  test("says to update the Nextcloud app when it is too old for the service", async ({ page }) => {
    await open(page, { versions: { app: app("0.4.1"), service: service("0.6.0", "0.5.0") } });
    const note = page.getByRole("alert");
    await expect(note).toContainText("The Nextcloud app is too old for this mail service");
    await expect(note).toContainText("Update the Nextcloud app to 0.6.0.");
  });
  test("says to update the mail service when it is too old for the app", async ({ page }) => {
    await open(page, { versions: { app: app("0.4.2"), service: service("0.3.0", null) } });
    const note = page.getByRole("alert");
    await expect(note).toContainText("The mail service is too old for this Nextcloud app");
    await expect(note).toContainText("Update the mail service to 0.4.2.");
  });
  test("names the older side when they differ but work together", async ({ page }) => {
    await open(page, { versions: { app: app("0.4.2"), service: service("0.4.1", null) } });
    await expect(page.getByRole("status").filter({ hasText: "different versions" })).toContainText("update the mail service to 0.4.2");
  });
  test("warns when more than one mail service runs on the same database", async ({ page }) => {
    await open(page, { versions: { app: app("0.5.0"), service: { ...service("0.5.0"), otherInstances: [{ host: "mail-2", version: "0.5.0", startedAt: "2026-11-27T10:00:00Z", seenAt: "2026-11-27T10:05:00Z" }] } } });
    const note = page.getByRole("alert");
    await expect(note).toContainText("More than one mail service is running on the same database");
    await expect(note).toContainText("mail-2");
  });
  test("explains when the mail service cannot be reached", async ({ page }) => {
    await open(page, { versions: { app: app("0.4.2"), service: null, error: "The mail service at http://mail:4000 could not be reached." } });
    await expect(page.getByRole("alert")).toContainText("The mail service cannot be reached");
    await expect(page.getByRole("alert")).toContainText("http://mail:4000");
  });
});

test("passes automated accessibility checks, with the server list and with the add dialog open", async ({ page }) => {
  await open(page, { servers: [corp], status: { [corp.id]: { imap: { ok: true, message: "ok" }, smtp: { ok: true, message: "ok" }, sieve: null, checkedAt: new Date().toISOString() } } });
  // the stand-in page has none of Nextcloud's own layout (landmarks, language), so only the app's part is checked
  const check = async () => (await new AxeBuilder({ page }).include("#ncmail-admin").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze())
    .violations.map((v) => `${v.id}: ${v.help} ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(", ")}`);
  expect(await check()).toEqual([]);
  await page.getByRole("button", { name: "Add mail server" }).first().click();
  await expect(page.getByRole("dialog", { name: "Add mail server" })).toBeVisible();
  const dialog = async () => (await new AxeBuilder({ page }).include('[role="dialog"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze())
    .violations.map((v) => `${v.id}: ${v.help} ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(", ")}`);
  expect(await dialog()).toEqual([]);
});
