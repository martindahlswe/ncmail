import sanitizeHtml from "sanitize-html";
import { simpleParser, type ParsedMail } from "mailparser";
import { parseListPost, parseUnsubscribe } from "./listunsub.ts";
import { parseReceiptRequest } from "./mdn.ts";
import { secureKindOf } from "./secure/mime.ts";
import { parseAuth } from "./phishing.ts";

const STYLE_PROPS = [
  "color", "background-color", "background", "font", "font-family", "font-size", "font-weight", "font-style",
  "text-align", "text-decoration", "line-height", "letter-spacing", "vertical-align", "white-space",
  "width", "max-width", "min-width", "height", "padding", "padding-top", "padding-right", "padding-bottom",
  "padding-left", "margin", "margin-top", "margin-right", "margin-bottom", "margin-left", "border",
  "border-top", "border-right", "border-bottom", "border-left", "border-color", "border-style", "border-width",
  "border-radius", "border-collapse", "border-spacing", "display", "list-style-type",
];
// CSS escapes (backslashes) are refused so a value cannot hide a url() or a keyword from these checks
const SAFE_VALUE = /^(?!.*(?:expression|javascript:|@import|behavior|\\)).*$/i;
/** An image address that is not inline in the message (http(s), protocol-relative, relative). */
const REMOTE_SRC = /^(?!\s*data:)\s*\S/i;
/** CSS that loads something (url(), image-set(), src()), other than an inline data: URL. */
const CSS_LOAD = /\b(?:url|image-set|src|image)\s*\(/i;
const CSS_DATA_URL = /\burl\s*\(\s*(["']?)\s*data:[^)]*?\1\s*\)/gi;
const decodeAttr = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const styleLoadsRemote = (html: string) =>
  [...html.matchAll(/\sstyle="([^"]*)"/gi)].some(([, v]) => CSS_LOAD.test(decodeAttr(v!).replace(CSS_DATA_URL, "")));

// without remote content: no url() or image-set() in styles either
const SAFE_LOCAL_VALUE = /^(?!.*(?:expression|javascript:|@import|behavior|\\|url\s*\(|image-set)).*$/i;

/**
 * Sanitise email HTML. Remote images (img src and CSS url()) are normally NOT stripped here: the viewer's CSP blocks them
 * until allowed, and hasRemoteImages says whether there are any to allow. With `allowRemote: false` they are removed
 * outright, so no viewer (or print) can load them.
 */
export function sanitizeEmailHtml(html: string, opts: { allowRemote?: boolean } = {}): { html: string; hasRemoteImages: boolean } {
  const allowRemote = opts.allowRemote ?? true;
  let hasRemoteImages = false;
  const out = sanitizeHtml(html, {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, "img", "center", "font", "u", "s", "small", "big", "h1", "h2", "span", "div"],
    allowedAttributes: {
      "*": ["style", "align", "valign", "bgcolor", "width", "height", "border", "cellpadding", "cellspacing", "colspan", "rowspan", "dir", "lang"],
      a: ["href", "name", "target", "rel"], // target/rel are set by the transform below; they must survive the allow-list
      img: ["src", "alt", "width", "height"],
      font: ["color", "face", "size"],
    },
    allowedStyles: { "*": Object.fromEntries(STYLE_PROPS.map((p) => [p, [allowRemote ? SAFE_VALUE : SAFE_LOCAL_VALUE]])) },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["http", "https", "data"] },
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noopener noreferrer" }),
      img: (tag, attribs) => {
        if (REMOTE_SRC.test(attribs.src ?? "")) {
          hasRemoteImages = true;
          if (!allowRemote) { const { src: _, ...rest } = attribs; return { tagName: tag, attribs: rest }; }
        }
        return { tagName: tag, attribs };
      },
    },
  });
  return { html: out, hasRemoteImages: hasRemoteImages || styleLoadsRemote(out) };
}

/** Bumped when the cached headers gain something (v6: List-Post, read-receipt request); older bodies are fetched again. */
export const HEADERS_VERSION = 6;

export interface AttachmentMeta { idx: number; filename: string; contentType: string; size: number; inline: boolean }

/** Parse a raw RFC822 source into what we cache: html (cid images inlined as data URIs), text, attachment list. */
export async function parseSource(source: NodeJS.ReadableStream | Buffer) {
  const p: ParsedMail = await simpleParser(source as any);
  let html = typeof p.html === "string" ? p.html : "";
  const attachments: AttachmentMeta[] = [];
  // Pictures are written into the HTML once per reference: a small message could otherwise name one picture thousands of
  // times and make the reader's copy huge. Past this many bytes of inlined pictures, the rest stay as cid: references.
  let inlineBudget = 20 * 1024 * 1024;
  p.attachments.forEach((a, idx) => {
    // mailparser already turns cid: images into data: URIs (and flags them `related`); otherwise we do it below.
    let inline = !!a.cid && a.related === true;
    if (a.cid && html.includes(`cid:${a.cid}`)) {
      inline = true;
      const parts = html.split(`cid:${a.cid}`);
      const data = `data:${a.contentType};base64,${a.content.toString("base64")}`;
      const cost = (parts.length - 1) * data.length;
      if (a.contentType.startsWith("image/") && a.size <= 1_500_000 && cost <= inlineBudget) {
        html = parts.join(data);
        inlineBudget -= cost;
      }
    }
    if (/pkcs7-signature|pgp-signature/i.test(a.contentType)) inline = true; // the signature itself is not an attachment
    attachments.push({ idx, filename: a.filename ?? `attachment-${idx + 1}`, contentType: a.contentType, size: a.size, inline });
  });
  const ct: any = p.headers.get("content-type");
  const secure = ct ? secureKindOf(`${ct.value}; ${Object.entries(ct.params ?? {}).map(([k, v]) => `${k}="${v}"`).join("; ")}`) : null;
  const addr = (v: any) => (v?.value ?? []).map((x: any) => ({ name: x.name ?? "", address: x.address ?? "" }));
  // which of your addresses the server delivered it to (says which alias got mail that came by Bcc or a forward)
  const emailsIn = (v: unknown): string[] =>
    typeof v === "string" ? v.match(/[^\s<>"',;:]+@[^\s<>"',;]+/g) ?? []
    : Array.isArray(v) ? v.flatMap(emailsIn)
    : v && typeof v === "object" ? ("address" in v ? emailsIn((v as any).address) : "value" in v ? emailsIn((v as any).value) : "text" in v ? emailsIn((v as any).text) : [])
    : [];
  const deliveredTo = [...new Set(["delivered-to", "x-original-to", "envelope-to"].flatMap((h) => emailsIn(p.headers.get(h))).map((a) => a.toLowerCase()))];
  return {
    parsed: p,
    cache: {
      html: html || null,
      text: p.text ?? "",
      attachments,
      headers: {
        messageId: p.messageId ?? null,
        references: Array.isArray(p.references) ? p.references : p.references ? [p.references] : [],
        replyTo: addr(p.replyTo),
        deliveredTo,
        unsubscribe: parseUnsubscribe(p.headerLines as any),
        listPost: parseListPost(p.headerLines as any),
        receipt: parseReceiptRequest(p.headerLines as any),
        v: HEADERS_VERSION,
        auth: parseAuth(p.headers.get("authentication-results"), p.headers.get("received-spf")),
        ...(secure ? { secure } : {}),
      },
    },
  };
}
