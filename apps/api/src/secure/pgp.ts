import * as openpgp from "openpgp";
import { EMAIL, usable, type EncryptionInfo, type ParsedKey, type ParseResult, type SignatureInfo, type StoredKey } from "./types.ts";

const ARMOR = /-----BEGIN PGP (PUBLIC|PRIVATE) KEY BLOCK-----/;

const emailsOf = (userIds: string[]) => [...new Set(userIds.flatMap((u) => (u.match(EMAIL) ?? []).map((e) => e.toLowerCase())))];
const nameOf = (userIds: string[]) => userIds[0]?.replace(/<[^>]*>/, "").replace(/\(.*?\)/g, "").trim() ?? "";

/** Read keys from an OpenPGP file: ASCII-armored (.asc, .pgp, .key) or binary (.gpg, .pgp, .pub), one key or a whole keyring. */
export async function parsePgp(data: Buffer, passphrase?: string): Promise<ParseResult> {
  const keys: ParsedKey[] = [], errors: string[] = [];
  let needsPassword = false;
  let list: openpgp.Key[];
  try {
    const text = data.toString("utf8");
    if (ARMOR.test(text)) {
      // an armored file can hold several blocks (a keyring export, or a public key followed by a private one)
      const blocks = text.match(/-----BEGIN PGP (?:PUBLIC|PRIVATE) KEY BLOCK-----[\s\S]*?-----END PGP (?:PUBLIC|PRIVATE) KEY BLOCK-----/g) ?? [];
      list = (await Promise.all(blocks.map((b) => openpgp.readKeys({ armoredKeys: b })))).flat();
    } else list = await openpgp.readKeys({ binaryKeys: data });
  } catch (e: any) { return { keys, errors: [`Not a readable OpenPGP key (${e.message})`] }; }

  // a public and a private block for the same key are one key
  const byFp = new Map<string, openpgp.Key>();
  for (const k of list) { const fp = k.getFingerprint(); if (!byFp.has(fp) || k.isPrivate()) byFp.set(fp, k); }

  for (const k of byFp.values()) {
    try {
      const userIds = k.getUserIDs();
      let privateData: string | undefined;
      if (k.isPrivate()) {
        let priv = k as openpgp.PrivateKey;
        if (!priv.isDecrypted()) {
          if (!passphrase) { needsPassword = true; errors.push(`The key for ${userIds[0] ?? k.getFingerprint()} is protected by a passphrase`); continue; }
          try { priv = await openpgp.decryptKey({ privateKey: priv, passphrase }); }
          catch { needsPassword = true; errors.push("The passphrase is not correct"); continue; }
        }
        privateData = priv.armor();
      }
      const pub = k.isPrivate() ? (k as openpgp.PrivateKey).toPublic() : k;
      const exp = await k.getExpirationTime().catch(() => null);
      const revoked = await k.isRevoked().catch(() => false);
      if (revoked) { errors.push(`The key for ${userIds[0] ?? k.getFingerprint()} has been revoked`); continue; }
      const canEncrypt = await k.getEncryptionKey().then(() => true).catch(() => false);
      const canSign = privateData ? await k.getSigningKey().then(() => true).catch(() => false) : true;
      const algo = k.keyPacket.algorithm;
      keys.push({
        kind: "pgp", hasPrivate: !!privateData, emails: emailsOf(userIds), name: nameOf(userIds),
        fingerprint: k.getFingerprint().toUpperCase(),
        keyIds: [k.getKeyID().toHex(), ...k.getSubkeys().map((s) => s.getKeyID().toHex())].map((x) => x.toLowerCase()),
        notBefore: k.getCreationTime(), notAfter: exp instanceof Date ? exp : null, canSign, canEncrypt,
        publicData: pub.armor(), privateData, info: { algorithm: String(algo), userIds },
      });
    } catch (e: any) { errors.push(`Could not read a key (${e.message})`); }
  }
  return { keys, errors, needsPassword };
}

const readPrivate = (k: StoredKey) => openpgp.readPrivateKey({ armoredKey: k.privateData! });

/** Detached signature over exactly these bytes. */
export async function pgpSign(data: Buffer, key: StoredKey): Promise<string> {
  const sig = await openpgp.sign({
    message: await openpgp.createMessage({ binary: data }), signingKeys: await readPrivate(key), detached: true, format: "armored",
    config: { preferredHashAlgorithm: openpgp.enums.hash.sha256 },
  });
  return sig as string;
}

export async function pgpEncrypt(data: Buffer, recipients: StoredKey[]): Promise<string> {
  const keys = await Promise.all(recipients.map((r) => openpgp.readKey({ armoredKey: r.publicData })));
  return (await openpgp.encrypt({ message: await openpgp.createMessage({ binary: data }), encryptionKeys: keys, format: "armored" })) as string;
}

export interface PgpDecrypted { data: Buffer; info: EncryptionInfo; signature?: SignatureInfo }

/** Decrypt with whichever of your private keys the message was encrypted to. */
export async function pgpDecrypt(armored: string, mine: StoredKey[], known: StoredKey[], from: string): Promise<PgpDecrypted | { info: EncryptionInfo }> {
  let message: openpgp.Message<any>;
  try { message = await openpgp.readMessage({ armoredMessage: armored }); }
  catch (e: any) { return { info: { protocol: "pgp", status: "failed", message: `The encrypted part is damaged (${e.message})` } }; }
  const ids = message.getEncryptionKeyIDs().map((i) => i.toHex().toLowerCase());
  const candidates = mine.filter((k) => k.hasPrivate && k.privateData && k.keyIds.some((id) => ids.includes(id)));
  if (!candidates.length) return { info: { protocol: "pgp", status: "no-key", message: "This message is encrypted for a key you do not have." } };
  try {
    const verificationKeys = await Promise.all(known.map((k) => openpgp.readKey({ armoredKey: k.publicData })));
    const r = await openpgp.decrypt({ message, decryptionKeys: await Promise.all(candidates.map(readPrivate)), verificationKeys, format: "binary" });
    const data = Buffer.from(r.data as Uint8Array);
    let signature: SignatureInfo | undefined;
    if (r.signatures.length) signature = await judgeSignature(r.signatures, known, from);
    return { data, info: { protocol: "pgp", status: "decrypted", message: "Decrypted with your key." }, signature };
  } catch (e: any) { return { info: { protocol: "pgp", status: "failed", message: `Could not be decrypted (${e.message})` } }; }
}

/** Check a detached signature over `signed`. `known` are the public keys you have for people (and yourself). */
export async function pgpVerify(signed: Buffer, armoredSignature: string, known: StoredKey[], from: string): Promise<SignatureInfo> {
  try {
    const signature = await openpgp.readSignature({ armoredSignature });
    const verificationKeys = await Promise.all(known.map((k) => openpgp.readKey({ armoredKey: k.publicData })));
    const r = await openpgp.verify({ message: await openpgp.createMessage({ binary: signed }), signature, verificationKeys });
    return await judgeSignature(r.signatures, known, from);
  } catch (e: any) { return { protocol: "pgp", status: "invalid", message: `The signature could not be read (${e.message})` }; }
}

async function judgeSignature(sigs: any[], known: StoredKey[], from: string): Promise<SignatureInfo> {
  const s = sigs[0];
  if (!s) return { protocol: "pgp", status: "invalid", message: "The signature is empty." };
  const keyId = s.keyID.toHex().toLowerCase();
  const key = known.find((k) => k.keyIds.includes(keyId));
  try { await s.verified; }
  catch (e: any) {
    if (!key) return { protocol: "pgp", status: "unknown-key", message: `Signed with a key you do not have (${keyId.toUpperCase()}), so it cannot be checked. Import the sender's public key to check it.` };
    const expired = /expired/i.test(e.message ?? "");
    return { protocol: "pgp", status: expired ? "expired" : "invalid", message: expired ? "The signature is correct, but the key had expired." : `The signature does not match the message (${e.message}). It may have been altered.`,
      signer: signerOf(key) };
  }
  if (!key) return { protocol: "pgp", status: "unknown-key", message: "Signed with a key you do not have." };
  const signer = signerOf(key);
  if (!key.emails.includes(from.toLowerCase())) {
    return { protocol: "pgp", status: "mismatch", signer, message: `The signature is correct, but the key belongs to ${key.emails.join(", ") || "someone else"}, not the sender (${from}).` };
  }
  return { protocol: "pgp", status: "valid", signer, message: "The signature is correct and the key is in your key list." };
}

const signerOf = (k: StoredKey) => ({ name: k.name, email: k.emails[0] ?? "", fingerprint: k.fingerprint, emails: k.emails });
export { usable };
