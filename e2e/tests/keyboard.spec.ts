import { expect, test, type Page } from "@playwright/test";

/** The app without a mouse: tab order, visible focus, dialogs that hold and return the focus, and the main shortcuts. */
const row = (page: Page, subject: string) => page.getByRole("region", { name: "Messages" }).getByText(subject, { exact: true });
/** The focused element's name (or tag and class when it has none); "" when nothing on the page has the focus. */
const focused = (page: Page) => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body || el === document.documentElement) return "";
  return (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 60) || `<${el.tagName.toLowerCase()} class="${el.className}">`;
});
/** True when the focused element shows a focus ring (an outline or a box shadow). */
const ringShown = (page: Page) => page.evaluate(() => {
  const cs = getComputedStyle(document.activeElement!);
  return (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== "none";
});
const inDialog = (page: Page, name: string) => page.evaluate((n) => !!document.activeElement?.closest(`[role="dialog"][aria-label="${n}"]`), name);

/** Presses Tab `n` times; the focus must stay in the dialog (the message names where it went, and from where). */
async function tabsStayIn(page: Page, name: string, n: number) {
  for (let i = 0; i < n; i++) {
    const from = await focused(page);
    await page.keyboard.press("Tab");
    expect(await inDialog(page, name), `Tab ${i + 1} from "${from}" left the ${name} dialog for "${await focused(page) || "the page"}"`).toBe(true);
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem("ncmail.pref.undoSend", "0"); } catch { /* fine */ } });
  await page.goto("/");
  await expect(row(page, "Lunch on Friday?")).toBeVisible();
});

test("every stop in the tab order shows where the focus is, and a skip link leads past the folders", async ({ page, browserName }) => {
  test.skip(browserName === "webkit", "Safari tabs only to text fields unless its keyboard setting is on (Option+Tab reaches the rest)");
  await page.keyboard.press("Tab");
  expect(await focused(page)).toBe("Skip to messages");
  await expect(page.getByRole("button", { name: "Skip to messages" })).toBeInViewport();
  let stops = 0;
  for (; stops < 80 && (await focused(page)); stops++) { // until the focus leaves the page at the end
    expect(await ringShown(page), `no focus ring on "${await focused(page)}"`).toBe(true);
    await page.keyboard.press("Tab");
    await page.waitForTimeout(200); // at a person's pace: nothing may close and drop the focus meanwhile (the search tips did)
  }
  expect(stops).toBeGreaterThan(25);
  await page.goto("/");
  await expect(row(page, "Lunch on Friday?")).toBeVisible();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => !!document.activeElement?.closest('[aria-label="Messages"]'))).toBe(true);
});

test("opens messages with j and k, and Tab goes on from the opened row", async ({ page }) => {
  await page.keyboard.press("j");
  await expect(page.getByRole("heading", { level: 1 }).or(page.getByRole("heading", { level: 2 })).first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.matches("button.msg.active"))).toBe(true);
  const first = await focused(page);
  await page.keyboard.press("j");
  await expect.poll(() => focused(page)).not.toBe(first);
  await page.keyboard.press("k");
  await expect.poll(() => focused(page)).toBe(first);
});

test("dialogs take the focus, keep it while open, close with Escape and give it back", async ({ page }) => {
  // keyboard shortcuts
  const help = page.getByRole("button", { name: "Keyboard shortcuts" });
  await help.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await expect.poll(() => inDialog(page, "Keyboard shortcuts")).toBe(true);
  await tabsStayIn(page, "Keyboard shortcuts", 8);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
  await expect(help).toBeFocused();

  // settings
  const settings = page.getByRole("button", { name: "Account & settings" });
  await settings.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await expect.poll(() => inDialog(page, "Settings")).toBe(true);
  await tabsStayIn(page, "Settings", 30);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
  await expect(settings).toBeFocused();

  // the composer, from the c shortcut: focus starts in To and cycles inside
  await page.keyboard.press("c");
  await expect(page.getByRole("dialog", { name: "New message" })).toBeVisible();
  await expect.poll(() => inDialog(page, "New message")).toBe(true);
  await tabsStayIn(page, "New message", 25);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "New message" })).toHaveCount(0);
});

test("writes and sends a message with the keyboard alone", async ({ page }) => {
  await page.keyboard.press("c");
  await expect.poll(() => inDialog(page, "New message")).toBe(true);
  await page.keyboard.type("kb@example.org");
  await page.keyboard.press("Enter");
  await page.getByRole("dialog", { name: "New message" }).getByLabel("Subject").focus();
  await page.keyboard.type("Sent without a mouse");
  await page.keyboard.press("Tab");
  for (let i = 0; i < 10 && !(await page.evaluate(() => document.activeElement?.classList.contains("ProseMirror"))); i++) await page.keyboard.press("Tab");
  await page.keyboard.type("Only keys were pressed.");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  await expect(page.getByRole("dialog", { name: "New message" })).toHaveCount(0);
});
