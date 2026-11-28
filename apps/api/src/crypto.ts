import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for stored secrets (mail passwords, app passwords, private keys).
 * Stored form: "v1:" + base64(iv | tag | ciphertext). Older values have no prefix and are read the same way.
 * To change the key: put the new one in SECRET_KEY and the previous one(s) in SECRET_KEY_OLD (comma separated),
 * restart, run `pnpm rotate-key`, then remove SECRET_KEY_OLD.
 */
const parse = (v: string) => {
  const b = Buffer.from(v.trim(), "base64");
  if (b.length !== 32) throw new Error("SECRET_KEY must be 32 bytes, base64 (openssl rand -base64 32)");
  return b;
};
const key = () => parse(process.env.SECRET_KEY ?? "");
const oldKeys = () => (process.env.SECRET_KEY_OLD ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(parse);

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return "v1:" + Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}

const open = (k: Buffer, raw: Buffer) => {
  // iv (12) + tag (16) at least; a full-length tag is required, so a truncated one cannot be forged more easily
  if (raw.length < 28) throw new Error("too short");
  const d = createDecipheriv("aes-256-gcm", k, raw.subarray(0, 12), { authTagLength: 16 });
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
};

/** `current` tells the caller whether the value is already under the current key (for rotation). */
export function decryptWith(blob: string): { plain: string; current: boolean } {
  const raw = Buffer.from(blob.replace(/^v1:/, ""), "base64");
  try { return { plain: open(key(), raw), current: true }; } catch { /* try the previous keys */ }
  for (const k of oldKeys()) { try { return { plain: open(k, raw), current: false }; } catch { /* next */ } }
  // One message for every failure: it does not say why (wrong key, damaged value).
  throw new Error("A stored secret could not be read. Check SECRET_KEY (and SECRET_KEY_OLD after changing it).");
}
export const decrypt = (blob: string) => decryptWith(blob).plain;
