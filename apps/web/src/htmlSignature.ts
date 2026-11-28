import { Node } from "@tiptap/react";

/**
 * Signatures entered as HTML (pasted from a signature generator or another mail program: tables, inline styles, a logo).
 * The editor's own formatting is simpler and would rewrite them, so in a message such a signature is one block that keeps
 * its HTML as it is: shown in a frame where nothing can run, written out unchanged when the message is sent or saved.
 * The server cleaned the HTML when the signature was saved (signatureHtml.ts).
 */

/** The page the signature is shown in: the app's look for plain text, the signature's own styles for everything else. */
export const signatureDoc = (html: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>html,body{margin:0;padding:0;background:transparent}body{font:14px/1.45 system-ui,sans-serif;color:#222;overflow:hidden}img{max-width:100%;height:auto}</style></head><body>${html}</body></html>`;

/** A sandboxed frame (no scripts) that grows to the height of what it shows. */
export function signatureFrame(html: string, title = "Signature"): HTMLIFrameElement {
  const f = document.createElement("iframe");
  f.setAttribute("sandbox", "allow-same-origin"); // same origin only to read its height; scripts never run in it
  f.title = title;
  f.className = "html-sig-frame";
  const fit = () => { const h = f.contentDocument?.documentElement.scrollHeight; if (h) f.style.height = `${h}px`; };
  f.addEventListener("load", () => { fit(); f.contentDocument?.querySelectorAll("img").forEach((i) => i.addEventListener("load", fit)); });
  f.srcdoc = signatureDoc(html);
  return f;
}

/** Plain text of a signature, for the text part of a message. */
export function signaturePlain(html: string): string {
  const doc = new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h\d|table)>/gi, "\n$&"), "text/html");
  return (doc.body.textContent ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** HTML from the clipboard, or HTML source pasted as text, that the simple editor would flatten. Null when it is plain text. */
export function pastedSignatureHtml(data: DataTransfer | null): string | null {
  if (!data) return null;
  const text = data.getData("text/plain").trim();
  if (/^<(!doctype|html|body|table|div|p|span|a|img|font|br|center|style)\b/i.test(text) && /<\/?[a-z][^>]*>/i.test(text)) {
    return /^<(!doctype|html|body)\b/i.test(text) ? bodyOf(text) : text; // the source as they wrote it; a whole page: its body
  }
  const html = data.getData("text/html");
  if (html && /<(table|font)\b|\sstyle\s*=|\sbgcolor\s*=/i.test(html)) return bodyOf(html);
  return null;
}
const bodyOf = (html: string) => {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style, meta, link, title").forEach((n) => n.remove());
  return doc.body.innerHTML.replace(/<!--[\s\S]*?-->/g, "").trim();
};

// written out with a document of its own, so building the HTML of a message never loads the signature's pictures
const inert = typeof document !== "undefined" ? document.implementation.createHTMLDocument("") : null;

export const HtmlSignature = Node.create({
  name: "htmlSignature",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes: () => ({ html: { default: "", rendered: false, parseHTML: (el) => (el as HTMLElement).innerHTML } }),
  // someone else's signature inside quoted mail stays ordinary text
  parseHTML: () => [{ tag: 'div[data-signature="html"]', priority: 60, getAttrs: (el) => ((el as HTMLElement).parentElement?.closest("blockquote") ? false : null) }],
  renderHTML: ({ node }) => {
    const d = inert!.createElement("div");
    d.setAttribute("data-signature", "html");
    d.innerHTML = node.attrs.html as string;
    return d;
  },
  renderText: ({ node }) => signaturePlain(node.attrs.html as string),
  addNodeView: () => ({ node }) => {
    const dom = document.createElement("div");
    dom.className = "html-sig";
    dom.contentEditable = "false";
    dom.title = "Your signature. Change it in Settings > Sender addresses.";
    dom.append(signatureFrame(node.attrs.html as string));
    return { dom };
  },
});
