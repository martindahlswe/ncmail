import sanitizeHtml from "sanitize-html";

/**
 * A signature someone pasted as HTML (often a table with inline styles and a logo, made by a signature generator or copied
 * from another mail program). It goes into every message they send and is shown inside the app, so it keeps what mail
 * programs render (layout, colours, fonts, links, pictures) and loses what could run or reach out on its own: scripts,
 * event handlers, frames, forms, styles that load things, and links other than web, mail and phone ones.
 */
const TAGS = [
  "a", "b", "i", "u", "s", "em", "strong", "small", "big", "sub", "sup", "span", "font", "div", "p", "br", "hr", "center",
  "blockquote", "pre", "code", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col", "img",
];
const LAYOUT = ["style", "align", "valign", "width", "height", "bgcolor", "dir", "title"];

export function cleanSignatureHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: TAGS,
    allowedAttributes: {
      "*": LAYOUT,
      a: ["href", ...LAYOUT],
      img: ["src", "alt", "border", ...LAYOUT],
      font: ["color", "face", "size", ...LAYOUT],
      table: ["border", "cellpadding", "cellspacing", "role", ...LAYOUT],
      td: ["colspan", "rowspan", "nowrap", ...LAYOUT],
      th: ["colspan", "rowspan", "nowrap", ...LAYOUT],
      col: ["span", ...LAYOUT],
    },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["http", "https", "data", "cid"] },
    allowProtocolRelative: false,
    // styles that fetch something (url(...), @import, expression()) are dropped; everything else in style= stays
    transformTags: {
      "*": (tagName, attribs) => {
        if (attribs.style && /url\s*\(|expression\s*\(|@import|behavio(u)?r\s*:|-moz-binding/i.test(attribs.style)) {
          const { style: _drop, ...rest } = attribs;
          return { tagName, attribs: rest };
        }
        return { tagName, attribs };
      },
    },
    // data: pictures only as pictures, never as links
    exclusiveFilter: (frame) => frame.tag === "img" && /^data:/i.test(frame.attribs.src ?? "") && !/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(frame.attribs.src ?? ""),
  }).trim();
}
