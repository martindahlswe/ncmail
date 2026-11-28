import { convert } from "html-to-text";

/**
 * The composer wraps the signature in <div data-signature="true">…</div> so we can find it again.
 * For the plain-text part of an email we use the address's configured plain-text signature when the
 * signature in the message is still the configured one; if the sender edited it, we convert what is
 * actually in the message so the two parts never disagree.
 */

const OPTS = {
  wordwrap: false as const,
  selectors: [{ selector: "a", options: { hideLinkHrefIfSameAsText: true } }, { selector: "img", format: "skip" }],
};
const MARK = "@@NCSIG@@";

/**
 * The signature block of a message: the editor's (data-signature="true") or one entered as HTML (data-signature="html"),
 * found with its closing tag counted, since HTML signatures nest <div>s of their own.
 */
export function findSignature(html: string): { start: number; end: number; inner: string; asHtml: boolean } | null {
  const open = /<div data-signature="(true|html)">/i.exec(html);
  if (!open) return null;
  const tags = /<div\b[^>]*>|<\/div\s*>/gi;
  tags.lastIndex = open.index + open[0].length;
  let depth = 1;
  for (let t = tags.exec(html); t; t = tags.exec(html)) {
    depth += t[0][1] === "/" ? -1 : 1;
    if (depth === 0) return { start: open.index, end: t.index + t[0].length, inner: html.slice(open.index + open[0].length, t.index), asHtml: open[1]!.toLowerCase() === "html" };
  }
  return null;
}

const norm = (h: string) => h.replace(/>\s+</g, "><").replace(/\s+/g, " ").trim();
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
/** Must match the client's textToHtml so a plain-only signature compares equal. */
export const textToHtml = (t: string) =>
  t.trim() ? t.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("") : "<p></p>";

export interface SignatureConfig { signatureHtml?: string; signatureText?: string }

export function toPlainText(html: string, sig?: SignatureConfig): string {
  const m = findSignature(html);
  if (!m) return convert(html, OPTS);
  const configuredHtml = sig?.signatureHtml || (sig?.signatureText ? textToHtml(sig.signatureText) : "");
  // an HTML signature cannot be edited in a message, so its plain-text version (when one is set) always fits
  const untouched = !!sig?.signatureText && (m.asHtml || norm(m.inner) === norm(configuredHtml));
  const sigText = untouched ? sig!.signatureText!.trim() : convert(m.inner, OPTS).trim();
  const body = convert(html.slice(0, m.start) + `<p>${MARK}</p>` + html.slice(m.end), OPTS);
  return body.replace(MARK, `-- \n${sigText}`);
}
