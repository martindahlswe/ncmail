import { expect, test, type Page } from "@playwright/test";
import { E2E_PORT, MAILPIT } from "../fixtures.ts";

/** A signature pasted as HTML (as signature generators and other mail programs give it) is kept as it is. */
const API = `http://127.0.0.1:${E2E_PORT}/api`;
const api = async <T = any>(path: string, init?: RequestInit): Promise<T> => (await fetch(`${API}${path}`, init)).json() as Promise<T>;
const SOURCE = `<table cellpadding="0" style="border-collapse:collapse"><tr><td style="padding-right:10px;border-right:2px solid #0b5394"><b style="color:#0b5394">Ada Lovelace</b></td><td style="padding-left:10px">Analytical Engines<br><a href="mailto:ada@example.org">ada@example.org</a></td></tr></table>`;

async function identity() {
  const [acct] = await api<{ id: string }[]>("/accounts");
  const [ident] = await api<{ id: string }[]>(`/accounts/${acct!.id}/identities`);
  return { url: `/accounts/${acct!.id}/identities/${ident!.id}` };
}
/** Paste into the focused editor the way a browser does, with what the clipboard holds. */
const paste = (page: Page, data: Record<string, string>) => page.locator(".ProseMirror").first().evaluate((el, d) => {
  const dt = new DataTransfer();
  for (const [type, value] of Object.entries(d)) dt.setData(type, value);
  // a paste event carrying this clipboard (Firefox ignores clipboardData given to the ClipboardEvent constructor)
  const ev = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", { value: dt });
  el.dispatchEvent(ev);
}, data);

test.afterEach(async () => {
  const { url } = await identity();
  await fetch(`${API}${url}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ signatureHtml: "", signatureIsHtml: false, signatureText: "" }) });
});

test("pasting HTML source into the signature keeps its layout, in messages too", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Account & settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: /Sender addresses/ }).click();
  await settings.getByRole("button", { name: "Add signature" }).first().click();
  await settings.locator(".ProseMirror").click();
  await paste(page, { "text/plain": SOURCE });

  // the box becomes the HTML source, with a preview of how it looks
  await expect(settings.getByRole("textbox", { name: "Signature HTML" })).toHaveValue(SOURCE);
  await expect(settings.getByText("Pasted as HTML")).toBeVisible();
  await expect(settings.frameLocator('iframe[title="Signature preview"]').getByText("Ada Lovelace")).toBeVisible();
  await settings.getByRole("button", { name: "Save signature" }).click();
  await expect.poll(async () => (await api<any[]>((await identity()).url.replace(/\/[^/]+$/, ""))).find((i) => i.signatureIsHtml)?.signatureHtml ?? "").toContain("border-collapse:collapse");
  await page.keyboard.press("Escape");
  await page.reload(); // the composer reads the sender addresses at start

  // a new message carries it as one block, shown as it will be sent
  const subject = `HTML signature ${Date.now().toString(36)}`;
  await page.getByRole("button", { name: "New message" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  await expect(composer.frameLocator('iframe[title="Signature"]').getByText("Analytical Engines")).toBeVisible();
  const to = composer.getByRole("textbox", { name: "To" });
  await to.fill("pat@example.net");
  await to.press("Enter");
  await composer.getByRole("textbox", { name: "Subject" }).fill(subject);
  await composer.locator(".ProseMirror").click();
  await page.keyboard.type("Hello.");
  await composer.getByRole("button", { name: "Send", exact: true }).click();

  // and it arrives with its table and styles
  let id = "";
  await expect.poll(async () => {
    const r = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`subject:"${subject}"`)}`)).json() as { messages: { ID: string }[] };
    return (id = r.messages?.[0]?.ID ?? "");
  }, { timeout: 20_000 }).not.toBe("");
  const msg = await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json() as { HTML: string; Text: string };
  expect(msg.HTML).toContain("border-collapse:collapse");
  expect(msg.HTML).toContain("Ada Lovelace");
  expect(msg.Text).toContain("Ada Lovelace"); // and in the plain-text part
});

test("copying a formatted signature from a web page keeps it as HTML too", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Account & settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: /Sender addresses/ }).click();
  await settings.getByRole("button", { name: "Add signature" }).first().click();
  await settings.locator(".ProseMirror").click();
  await paste(page, { "text/html": `<html><body><!--StartFragment-->${SOURCE}<!--EndFragment--></body></html>`, "text/plain": "Ada Lovelace Analytical Engines" });
  const box = settings.getByRole("textbox", { name: "Signature HTML" });
  await expect(box).toHaveValue(/^<table cellpadding="0" style="border-collapse:collapse">.*Ada Lovelace.*<\/table>$/);
  await expect(box).not.toHaveValue(/StartFragment|<body/);
  // and plain text still goes into the editor as text
  await settings.getByRole("button", { name: "Use the editor instead" }).click();
  await settings.locator(".ProseMirror").click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await paste(page, { "text/plain": "Best regards, Ada" });
  await expect(settings.getByRole("textbox", { name: "Signature HTML" })).toHaveCount(0);
});
