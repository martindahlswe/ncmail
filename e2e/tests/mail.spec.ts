import { expect, test, type Page } from "@playwright/test";
import { E2E_PORT, MAILPIT } from "../fixtures.ts";

/** The core of the web app: reading, writing, and acting on messages. Each test leaves the mailbox as it found it. */

const API = `http://127.0.0.1:${E2E_PORT}/api`;
const api = async <T = any>(path: string, init?: RequestInit): Promise<T> => (await fetch(`${API}${path}`, init)).json() as Promise<T>;
async function inboxMessages() {
  const [acct] = await api<{ id: string }[]>("/accounts");
  const inbox = (await api<any[]>(`/accounts/${acct!.id}/folders`)).find((f) => f.specialUse === "\\Inbox");
  return (await api<{ items: any[] }>(`/folders/${inbox.id}/messages?threads=0`)).items;
}
const row = (page: Page, subject: string) => page.getByRole("region", { name: "Messages" }).getByText(subject, { exact: true });

test.beforeEach(async ({ page }) => {
  // send at once (no undo-send wait), so the sending test does not have to sit through the countdown
  await page.addInitScript(() => { try { localStorage.setItem("ncmail.pref.undoSend", "0"); } catch { /* fine */ } });
  await page.goto("/");
  await expect(row(page, "Lunch on Friday?")).toBeVisible();
});

test("lists the inbox and opens a message", async ({ page }) => {
  for (const s of ["Weekly status: a long table", "Lunch on Friday?", "Invoice 1042", "Holiday plans"]) await expect(row(page, s)).toBeVisible();
  await row(page, "Holiday plans").click();
  await expect(page.frameLocator('iframe[title="Message"]').getByText("Are you around in the last week of December?")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Holiday plans" })).toBeVisible();
});

test("marks a message read when opened, and unread again", async ({ page }) => {
  const seen = async () => (await inboxMessages()).find((m) => m.subject === "Lunch on Friday?")!.seen;
  expect(await seen()).toBe(false);
  await row(page, "Lunch on Friday?").click();
  await expect(page.frameLocator('iframe[title="Message"]').getByText("Shall we try the new place")).toBeVisible();
  await expect.poll(seen).toBe(true);
  await page.getByRole("button", { name: "Mark as unread" }).click();
  await expect.poll(seen).toBe(false);
});

test("keeps a long table message still while the pointer moves over it", async ({ page }) => {
  await row(page, "Weekly status: a long table").click();
  const frame = page.locator('iframe[title="Message"]');
  await expect(page.frameLocator('iframe[title="Message"]').getByText("Point 16:")).toBeAttached();
  await page.waitForTimeout(500); // let the first sizing settle
  const box = (await frame.boundingBox())!;
  const heights = new Set<number>();
  for (let i = 0; i < 12; i++) {
    await page.mouse.move(box.x + 100 + (i * 37) % Math.max(50, box.width - 200), Math.min(box.y + 80 + i * 25, 850));
    await page.waitForTimeout(60);
    heights.add(await frame.evaluate((f: HTMLIFrameElement) => f.getBoundingClientRect().height));
  }
  expect([...heights]).toHaveLength(1);
  // the frame shows the whole message: it never scrolls by itself and cuts nothing off
  const inner = await frame.evaluate((f: HTMLIFrameElement) => { const d = f.contentDocument!.documentElement; return { scroll: d.scrollHeight, client: d.clientHeight }; });
  expect(inner.scroll).toBeLessThanOrEqual(inner.client + 1);
});

test("writes and sends a message", async ({ page }) => {
  const subject = `Browser test ${Date.now().toString(36)}`;
  await page.getByRole("button", { name: "New message" }).click();
  const to = page.getByRole("textbox", { name: "To" });
  await to.fill("pat@example.net");
  await to.press("Enter");
  await page.getByRole("textbox", { name: "Subject" }).fill(subject);
  await page.locator(".ProseMirror").click();
  await page.keyboard.type("Hello from the browser tests.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  // the test SMTP server (Mailpit) receives it
  await expect.poll(async () => {
    const r = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`subject:"${subject}"`)}`)).json() as { messages: { To: { Address: string }[] }[] };
    return r.messages?.[0]?.To?.[0]?.Address ?? null;
  }, { timeout: 20_000 }).toBe("pat@example.net");
});

test("deletes a message and brings it back with Undo", async ({ page }) => {
  await row(page, "Invoice 1042").click();
  await expect(page.frameLocator('iframe[title="Message"]').getByText("details of invoice 1042")).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(row(page, "Invoice 1042")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(row(page, "Invoice 1042")).toBeVisible();
  await expect.poll(async () => (await inboxMessages()).some((m) => m.subject === "Invoice 1042")).toBe(true);
});

test("looks up the mail servers when someone adds their own account", async ({ page }) => {
  // the lookup goes to the internet: answer it here, as the service would for a provider that publishes its settings
  await page.route("**/api/mail-presets/lookup?**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    domain: "posteo.example", found: { source: "autoconfig", from: "autoconfig.posteo.example", name: "Posteo", username: "email",
      imap: { host: "posteo.example", port: 993, security: "tls" }, smtp: { host: "posteo.example", port: 587, security: "starttls" } },
  }) }));
  await page.getByRole("button", { name: /Account & settings/ }).click();
  await page.getByRole("button", { name: /Add account/ }).first().click();
  const email = page.getByRole("textbox", { name: "Email address" });
  await email.fill("pat@posteo.example");
  await email.blur();
  await expect(page.getByRole("status").filter({ hasText: "Found the servers for Posteo" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Incoming mail (IMAP) server" })).toHaveValue("posteo.example");
  await expect(page.getByRole("textbox", { name: "Outgoing mail (SMTP) server" })).toHaveValue("posteo.example");
  await expect(page.getByRole("spinbutton", { name: "Outgoing mail (SMTP) port" })).toHaveValue("587");
  await expect(page.getByRole("textbox", { name: "Incoming mail (IMAP) username" })).toHaveValue("pat@posteo.example");
});
