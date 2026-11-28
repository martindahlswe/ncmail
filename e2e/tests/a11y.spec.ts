import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * Automated accessibility checks (axe-core, WCAG 2.0 to 2.2, A and AA) of the main views: the inbox, an open message, the
 * composer and the settings, in light and dark. The message body itself is the sender's HTML, shown in a sandboxed frame,
 * so it is left out. What automated checks cannot cover is in docs/accessibility.md.
 */
const row = (page: Page, subject: string) => page.getByRole("region", { name: "Messages" }).getByText(subject, { exact: true });

async function violations(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).exclude('iframe[title="Message"]').analyze();
  return r.violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n${v.nodes.slice(0, 5).map((n) => `    ${n.target.join(" ")} ${n.failureSummary?.split("\n").slice(1, 2).join("") ?? ""}`).join("\n")}`);
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });
    test.beforeEach(async ({ page }) => {
      await page.goto("/");
      await expect(row(page, "Lunch on Friday?")).toBeVisible();
    });

    test("the inbox", async ({ page }) => {
      expect(await violations(page)).toEqual([]);
    });

    test("an open message", async ({ page }) => {
      await row(page, "Holiday plans").click();
      await expect(page.getByRole("heading", { name: "Holiday plans" })).toBeVisible();
      expect(await violations(page)).toEqual([]);
    });

    test("the composer", async ({ page }) => {
      await page.getByRole("button", { name: "New message" }).click();
      await expect(page.getByRole("dialog").first()).toBeVisible();
      expect(await violations(page)).toEqual([]);
    });

    test("the settings", async ({ page }) => {
      await page.getByRole("button", { name: "Account & settings" }).click();
      await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
      await page.waitForTimeout(300);
      expect(await violations(page)).toEqual([]);
    });
  });
}
