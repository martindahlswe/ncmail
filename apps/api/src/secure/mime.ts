import { randomBytes } from "node:crypto";

/**
 * The small amount of MIME handling that signing and encryption need: split a message into headers and body, wrap the
 * content in multipart/signed or multipart/encrypted (or S/MIME's application/pkcs7-mime), and take such wrappers apart again.
 * Signatures cover exact bytes, so everything here works on Buffers with CRLF line ends and never re-encodes anything.
 */

export interface Header { name: string; value: string; raw: string }
const CRLF = "\r\n";
const crlf = (s: string) => s.replace(/\r?\n/g, CRLF);

export function splitMessage(raw: Buffer): { head: string; body: Buffer } {
  const crlf2 = raw.indexOf("\r\n\r\n"), lf2 = raw.indexOf("\n\n");
  const useCr = crlf2 >= 0 && (lf2 < 0 || crlf2 <= lf2);
  const at = useCr ? crlf2 : lf2;
  if (at < 0) return { head: raw.toString("latin1"), body: Buffer.alloc(0) };
  return { head: raw.subarray(0, at).toString("latin1"), body: raw.subarray(at + (useCr ? 4 : 2)) };
}

/** Header block -> list of headers; folded lines are joined into one value, and `raw` keeps the original text for re-emitting. */
export function parseHeaders(head: string): Header[] {
  const out: Header[] = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length) { const h = out[out.length - 1]!; h.value += " " + line.trim(); h.raw += CRLF + line; continue; }
    const i = line.indexOf(":");
    if (i > 0) out.push({ name: line.slice(0, i), value: line.slice(i + 1).trim(), raw: line });
  }
  return out;
}

export const headerValue = (hs: Header[], name: string) => hs.find((h) => h.name.toLowerCase() === name)?.value;

/** "multipart/signed; protocol=\"x\"; boundary=abc" -> { type, params } */
export function parseContentType(v: string | undefined): { type: string; params: Record<string, string> } {
  const [t = "", ...rest] = (v ?? "").split(";");
  const params: Record<string, string> = {};
  for (const p of rest.join(";").matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|([^;\s]+))/g)) params[p[1]!.toLowerCase()] = p[2] ?? p[3] ?? "";
  return { type: t.trim().toLowerCase(), params };
}

/** Split a multipart body at its boundary lines. Each returned part is the exact bytes between the delimiters. */
export function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const text = body.toString("latin1");
  const marker = `--${boundary}`;
  const parts: Buffer[] = [];
  let pos = -1, start = -1;
  const re = new RegExp(`(^|\\r?\\n)${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(--)?[ \\t]*(?=\\r?\\n|$)`, "g");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (start >= 0) parts.push(Buffer.from(text.slice(start, m.index), "latin1"));
    pos = m.index + m[0].length;
    if (m[2]) { start = -1; break; }
    // skip the line break after the boundary
    start = pos + (text.startsWith("\r\n", pos) ? 2 : text.startsWith("\n", pos) ? 1 : 0);
  }
  return parts;
}

/** The entity (headers + body) that gets signed or encrypted: the message minus its envelope headers. */
export function entityOf(raw: Buffer): { outer: Header[]; entity: Buffer } {
  const { head, body } = splitMessage(raw);
  const hs = parseHeaders(head);
  const content = hs.filter((h) => /^content-/i.test(h.name));
  const outer = hs.filter((h) => !/^content-/i.test(h.name));
  const entityHead = content.map((h) => h.raw).join(CRLF);
  return { outer, entity: Buffer.concat([Buffer.from(entityHead + CRLF + CRLF, "latin1"), Buffer.from(crlf(body.toString("latin1")), "latin1")]) };
}

export const trimTrailingCrlf = (b: Buffer) => { let n = b.length; while (n >= 2 && b[n - 2] === 13 && b[n - 1] === 10) n -= 2; return b.subarray(0, n); };
const boundary = () => `ncmail-${randomBytes(12).toString("hex")}`;
const headBlock = (outer: Header[]) => outer.map((h) => h.raw).join(CRLF) + CRLF;
const b64lines = (b: Buffer) => (b.toString("base64").match(/.{1,76}/g) ?? []).join(CRLF);

/** multipart/signed around `entity`; `signature` is the detached signature over the entity's bytes. */
export function assembleSigned(outer: Header[], entity: Buffer, o: { protocol: string; micalg: string; sigType: string; sigName: string; signature: Buffer; sigEncoding: "base64" | "7bit" }): Buffer {
  const b = boundary();
  const signed = trimTrailingCrlf(entity);
  const sigPart = o.sigEncoding === "base64" ? b64lines(o.signature) : o.signature.toString("latin1").replace(/\r?\n/g, CRLF).replace(/(\r\n)+$/, "");
  return Buffer.concat([
    Buffer.from(headBlock(outer) + `Content-Type: multipart/signed; protocol="${o.protocol}"; micalg=${o.micalg}; boundary="${b}"${CRLF}${CRLF}`, "latin1"),
    Buffer.from(`This is a cryptographically signed message in MIME format.${CRLF}${CRLF}--${b}${CRLF}`, "latin1"),
    signed,
    Buffer.from(`${CRLF}--${b}${CRLF}Content-Type: ${o.sigType}; name="${o.sigName}"${CRLF}Content-Disposition: attachment; filename="${o.sigName}"${CRLF}` +
      (o.sigEncoding === "base64" ? `Content-Transfer-Encoding: base64${CRLF}` : "") + `${CRLF}${sigPart}${CRLF}--${b}--${CRLF}`, "latin1"),
  ]);
}

/** RFC 3156: multipart/encrypted with a control part and the armored ciphertext. */
export function assemblePgpEncrypted(outer: Header[], armored: string): Buffer {
  const b = boundary();
  return Buffer.from(headBlock(outer) +
    `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${b}"${CRLF}${CRLF}` +
    `This is an OpenPGP/MIME encrypted message (RFC 4880 and 3156)${CRLF}${CRLF}--${b}${CRLF}` +
    `Content-Type: application/pgp-encrypted${CRLF}Content-Description: PGP/MIME version identification${CRLF}${CRLF}Version: 1${CRLF}${CRLF}--${b}${CRLF}` +
    `Content-Type: application/octet-stream; name="encrypted.asc"${CRLF}Content-Description: OpenPGP encrypted message${CRLF}Content-Disposition: inline; filename="encrypted.asc"${CRLF}${CRLF}` +
    `${armored.replace(/\r?\n/g, CRLF).replace(/(\r\n)+$/, "")}${CRLF}--${b}--${CRLF}`, "latin1");
}

/** S/MIME enveloped-data: the whole message body is one base64 PKCS#7 blob. */
export function assembleSmimeEnveloped(outer: Header[], der: Buffer): Buffer {
  return Buffer.from(headBlock(outer) +
    `Content-Type: application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"${CRLF}Content-Transfer-Encoding: base64${CRLF}` +
    `Content-Disposition: attachment; filename="smime.p7m"${CRLF}${CRLF}${b64lines(der)}${CRLF}`, "latin1");
}

/** Decode a MIME part (headers + body) to its body bytes, undoing base64 / quoted-printable. */
export function partBody(part: Buffer): { headers: Header[]; body: Buffer } {
  const { head, body } = splitMessage(part);
  const headers = parseHeaders(head);
  const enc = (headerValue(headers, "content-transfer-encoding") ?? "7bit").toLowerCase();
  if (enc === "base64") return { headers, body: Buffer.from(body.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, ""), "base64") };
  if (enc === "quoted-printable") {
    const s = body.toString("latin1").replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    return { headers, body: Buffer.from(s, "latin1") };
  }
  return { headers, body };
}

/** What kind of protected message is this? Decided from the top-level headers alone, so it is cheap to cache. */
export type SecureKind = "pgp-signed" | "smime-signed" | "pgp-encrypted" | "smime-encrypted" | "smime-opaque-signed";
export function secureKindOf(contentType: string | undefined): SecureKind | null {
  const { type, params } = parseContentType(contentType);
  if (type === "multipart/signed") {
    const p = (params.protocol ?? "").toLowerCase();
    return p.includes("pgp-signature") ? "pgp-signed" : p.includes("pkcs7-signature") ? "smime-signed" : null;
  }
  if (type === "multipart/encrypted" && (params.protocol ?? "").toLowerCase().includes("pgp-encrypted")) return "pgp-encrypted";
  if (type === "application/pkcs7-mime" || type === "application/x-pkcs7-mime") {
    return (params["smime-type"] ?? "").toLowerCase() === "signed-data" ? "smime-opaque-signed" : "smime-encrypted";
  }
  return null;
}
