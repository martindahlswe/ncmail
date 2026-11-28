import { addrOf, type Protocol, type SecurityInfo, type StoredKey } from "./types.ts";
import {
  assemblePgpEncrypted, assembleSigned, assembleSmimeEnveloped, entityOf, headerValue, parseContentType, parseHeaders, partBody,
  secureKindOf, splitMessage, splitMultipart, trimTrailingCrlf, type Header,
} from "./mime.ts";
import { pgpDecrypt, pgpEncrypt, pgpSign, pgpVerify } from "./pgp.ts";
import { readSigned, smimeDecrypt, smimeEncrypt, smimeSign } from "./smime.ts";
import { encryptionKey, knownKeys, ownEncryptionKey, privateKeys, signingKey } from "./store.ts";

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
export interface SecurityRequest { sign: boolean; encrypt: boolean; protocol: Protocol }
const label = (p: Protocol) => (p === "pgp" ? "PGP key" : "S/MIME certificate");

/** The encryption key for every recipient, or a 400 that names all recipients without one. */
export async function recipientKeys(owner: string, recipients: string[], protocol: Protocol): Promise<StoredKey[]> {
  const found: StoredKey[] = [], missing: string[] = [];
  for (const r of [...new Set(recipients.map(addrOf))]) {
    const k = await encryptionKey(owner, r, protocol);
    k ? found.push(k) : missing.push(r);
  }
  if (missing.length) throw httpError(400, `Cannot encrypt: no ${label(protocol)} for ${missing.join(", ")}. Import their ${protocol === "pgp" ? "public key" : "certificate"} under Settings > Security, or turn encryption off.`);
  return found;
}

/**
 * Sign and/or encrypt a finished message. The message's own headers stay readable (a mail server needs them to deliver it);
 * the content is wrapped as multipart/signed, multipart/encrypted (PGP/MIME) or application/pkcs7-mime (S/MIME).
 * Signing happens first, so what gets encrypted is the signed message.
 */
export async function protectMessage(owner: string, raw: Buffer, from: string, recipients: string[], req: SecurityRequest): Promise<Buffer> {
  if (!req.sign && !req.encrypt) return raw;
  const me = addrOf(from);
  let own: StoredKey | null = null;
  if (req.sign) {
    own = await signingKey(owner, me, req.protocol);
    if (!own) throw httpError(400, `You have no valid ${label(req.protocol)} for ${me}, so this message cannot be signed. Add one under Settings > Security.`);
  }
  const targets: StoredKey[] = [];
  if (req.encrypt) {
    targets.push(...await recipientKeys(owner, recipients, req.protocol));
    const self = await encryptionKey(owner, me, req.protocol); // so the copy in Sent stays readable to you
    if (self && !targets.some((t) => t.id === self.id)) targets.push(self);
  }

  let { outer, entity } = entityOf(raw);
  let msg = raw;
  if (own) {
    const bytes = trimTrailingCrlf(entity);
    msg = req.protocol === "pgp"
      ? assembleSigned(outer, entity, { protocol: "application/pgp-signature", micalg: "pgp-sha256", sigType: "application/pgp-signature", sigName: "signature.asc", signature: Buffer.from(await pgpSign(bytes, own)), sigEncoding: "7bit" })
      : assembleSigned(outer, entity, { protocol: "application/pkcs7-signature", micalg: "sha-256", sigType: "application/pkcs7-signature", sigName: "smime.p7s", signature: smimeSign(bytes, own), sigEncoding: "base64" });
    ({ outer, entity } = entityOf(msg));
  }
  if (req.encrypt) {
    msg = req.protocol === "pgp" ? assemblePgpEncrypted(outer, await pgpEncrypt(entity, targets)) : assembleSmimeEnveloped(outer, smimeEncrypt(entity, targets));
  }
  return msg;
}

/**
 * A draft of a message marked for encryption, encrypted to the sender's own key only, so the copy on the mail server is not
 * readable there. The headers stay readable, as on a sent message. Null when the sender has no own key to decrypt it with again.
 */
export async function encryptDraft(owner: string, raw: Buffer, from: string, protocol: Protocol): Promise<Buffer | null> {
  const self = await ownEncryptionKey(owner, addrOf(from), protocol);
  if (!self) return null;
  const { outer, entity } = entityOf(raw);
  return protocol === "pgp" ? assemblePgpEncrypted(outer, await pgpEncrypt(entity, [self])) : assembleSmimeEnveloped(outer, smimeEncrypt(entity, [self]));
}

/** Open a draft saved by encryptDraft. Plain drafts come back unchanged; one that cannot be decrypted is a 400. */
export async function openDraft(owner: string, raw: Buffer): Promise<{ raw: Buffer; encrypted: Protocol | null }> {
  const kind = secureKindOf(headerValue(parseHeaders(splitMessage(raw).head), "content-type"));
  if (kind !== "pgp-encrypted" && kind !== "smime-encrypted") return { raw, encrypted: null };
  const { inner, security } = await inspectSecure(owner, raw);
  if (security.encryption?.status !== "decrypted") throw httpError(400, "This draft is encrypted with a key you do not have here, so it cannot be edited.");
  return { raw: inner, encrypted: kind === "pgp-encrypted" ? "pgp" : "smime" };
}

// ------------------------------------------------------------------ reading
const join = (outer: Header[], part: Buffer) => Buffer.concat([Buffer.from(outer.map((h) => h.raw).join("\r\n") + "\r\n", "latin1"), part]);

/**
 * Open a protected message: decrypt it if it is encrypted, check any signature, and return the message to show
 * (the inner content, with the outer headers) together with what was found. Plain messages come back unchanged.
 */
export async function inspectSecure(owner: string, raw: Buffer, depth = 0): Promise<{ inner: Buffer; security: SecurityInfo }> {
  const { head, body } = splitMessage(raw);
  const hs = parseHeaders(head);
  const kind = secureKindOf(headerValue(hs, "content-type"));
  if (!kind || depth > 2) return { inner: raw, security: {} };
  const outer = hs.filter((h) => !/^content-/i.test(h.name));
  const from = addrOf(headerValue(hs, "from") ?? "");
  const { params } = parseContentType(headerValue(hs, "content-type"));

  try {
    if (kind === "pgp-signed" || kind === "smime-signed") {
      const parts = splitMultipart(body, params.boundary ?? "");
      if (parts.length < 2) throw new Error("the signature part is missing");
      const known = await knownKeys(owner);
      const sigBody = partBody(parts[1]!).body;
      const signature = kind === "pgp-signed" ? await pgpVerify(parts[0]!, sigBody.toString("utf8"), known.filter((k) => k.kind === "pgp"), from)
        : readSigned(sigBody).verify(parts[0]!, known.filter((k) => k.kind === "smime"), from);
      const nested = await inspectSecure(owner, join(outer, parts[0]!), depth + 1);
      return { inner: nested.inner, security: { ...nested.security, signature } };
    }
    if (kind === "smime-opaque-signed") {
      const cms = readSigned(partBody(Buffer.concat([Buffer.from(hs.filter((h) => /^content-/i.test(h.name)).map((h) => h.raw).join("\r\n") + "\r\n\r\n", "latin1"), body])).body);
      const known = (await knownKeys(owner)).filter((k) => k.kind === "smime");
      const signature = cms.verify(null, known, from);
      const nested = await inspectSecure(owner, join(outer, cms.content ?? Buffer.alloc(0)), depth + 1);
      return { inner: nested.inner, security: { ...nested.security, signature } };
    }
    if (kind === "pgp-encrypted") {
      const parts = splitMultipart(body, params.boundary ?? "");
      if (parts.length < 2) throw new Error("the encrypted part is missing");
      const r = await pgpDecrypt(partBody(parts[1]!).body.toString("utf8"), await privateKeys(owner, "pgp"), (await knownKeys(owner)).filter((k) => k.kind === "pgp"), from);
      if (!("data" in r)) return { inner: raw, security: { encryption: r.info } };
      const nested = await inspectSecure(owner, join(outer, r.data), depth + 1);
      return { inner: nested.inner, security: { encryption: r.info, signature: nested.security.signature ?? r.signature, ...(nested.security.encryption ? {} : {}) } };
    }
    // smime-encrypted
    const der = partBody(Buffer.concat([Buffer.from(hs.filter((h) => /^content-/i.test(h.name)).map((h) => h.raw).join("\r\n") + "\r\n\r\n", "latin1"), body])).body;
    const plain = smimeDecrypt(der, await privateKeys(owner, "smime"));
    if (plain === "no-key") return { inner: raw, security: { encryption: { protocol: "smime", status: "no-key", message: "This message is encrypted for a certificate you do not have." } } };
    const nested = await inspectSecure(owner, join(outer, plain), depth + 1);
    // CMS enveloped data carries no integrity check: only a valid signature by the sender vouches for what was decrypted
    const sig = nested.security.signature;
    const authenticated = sig?.status === "valid" && !!from && !!sig.signer?.emails.includes(from);
    const message = authenticated ? "Decrypted with your certificate." : "Decrypted with your certificate, but it is not signed by the sender, so it may have been changed on the way. Remote content is not loaded.";
    return { inner: nested.inner, security: { encryption: { protocol: "smime", status: "decrypted", message, authenticated }, signature: sig } };
  } catch (e: any) {
    const protocol: Protocol = kind.startsWith("pgp") ? "pgp" : "smime";
    const msg = `This ${protocol === "pgp" ? "PGP" : "S/MIME"} message could not be processed (${e.message}).`;
    return { inner: raw, security: kind.includes("encrypted") ? { encryption: { protocol, status: "failed", message: msg } } : { signature: { protocol, status: "invalid", message: msg } } };
  }
}
