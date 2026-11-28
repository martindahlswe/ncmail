import { createHash } from "node:crypto";

/**
 * The composer keeps pictures in the text as data: URLs. Many mail programs do not show those, so before a message is
 * built each one becomes an inline MIME part (multipart/related) referenced as cid:. The same picture used twice (a
 * signature logo in the reply and in the quote) is sent once.
 */

/** Longest rich-text body accepted (pictures in the text included); requests stay under the server's 12 MB body limit. */
export const MAX_HTML = 11_000_000;

export interface InlineImage { filename: string; contentType: string; content: Buffer; cid: string; contentDisposition: "inline" }

/** A data: picture in the src attribute of one <img> tag (matched inside that tag only, so the work stays linear). */
const DATA_SRC = /(\ssrc=)(["'])data:(image\/(?:png|jpeg|jpg|gif|webp));base64,([A-Za-z0-9+/=\s]+)\2/i;
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp" };

export function extractInlineImages(html: string, domain = "ncmail.local"): { html: string; images: InlineImage[] } {
  const byHash = new Map<string, InlineImage>();
  const inline = (_m: string, head: string, q: string, type: string, b64: string) => {
    const content = Buffer.from(b64.replace(/\s+/g, ""), "base64");
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 24);
    let img = byHash.get(hash);
    if (!img) {
      const contentType = type.toLowerCase() === "image/jpg" ? "image/jpeg" : type.toLowerCase();
      img = { filename: `image-${byHash.size + 1}.${EXT[contentType]}`, contentType, content, cid: `${hash}@${domain}`, contentDisposition: "inline" };
      byHash.set(hash, img);
    }
    return `${head}${q}cid:${img.cid}${q}`;
  };
  // Walk the <img> tags one by one: each is searched only up to its own ">". (One regular expression over the whole HTML
  // backtracked quadratically on crafted input, which froze the service for everybody.)
  const lower = html.toLowerCase();
  let out = "", at = 0;
  for (;;) {
    const start = lower.indexOf("<img", at);
    if (start < 0) break;
    const end = html.indexOf(">", start);
    if (end < 0) break;
    const next = lower[start + 4];
    const tag = html.slice(start, end + 1);
    out += html.slice(at, start) + (next && /[\s/>]/.test(next) ? tag.replace(DATA_SRC, inline) : tag);
    at = end + 1;
  }
  out += html.slice(at);
  return { html: out, images: [...byHash.values()] };
}
