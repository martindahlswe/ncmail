export type Protocol = "pgp" | "smime";

/** A key or certificate as read from a file, before it is stored. */
export interface ParsedKey {
  kind: Protocol;
  hasPrivate: boolean;
  /** Addresses the key or certificate is issued for (lower case). */
  emails: string[];
  name: string;
  fingerprint: string;
  keyIds: string[];
  notBefore: Date | null;
  notAfter: Date | null;
  canSign: boolean;
  canEncrypt: boolean;
  /** Armored public key, or PEM certificate followed by its chain. */
  publicData: string;
  /** Armored (unlocked) private key, or PKCS#8 PEM. Stored encrypted. */
  privateData?: string;
  info: Record<string, unknown>;
}

export interface ParseResult { keys: ParsedKey[]; errors: string[]; needsPassword?: boolean }

export type SignatureStatus =
  | "valid"            // checks out, and the signer is trusted or known to you
  | "untrusted"        // checks out, but nothing vouches for who the signer is
  | "mismatch"         // checks out, but the signer's address differs from the From address
  | "expired"          // checks out, but the certificate or key was not valid at the time
  | "invalid"          // does not check out: the message was altered, or the signature is broken
  | "unknown-key";     // cannot be checked: the signer's key is not in your key list

export interface SignatureInfo {
  protocol: Protocol;
  status: SignatureStatus;
  message: string;
  signer?: { name: string; email: string; fingerprint: string; emails: string[] };
  /** The signer's certificate/key, so it can be saved (S/MIME certificates travel inside the signature). */
  signerData?: string;
}

export interface EncryptionInfo {
  protocol: Protocol; status: "decrypted" | "no-key" | "failed"; message: string;
  /** S/MIME only: false when nothing proves the decrypted content came unchanged from the sender (no valid signature by them). */
  authenticated?: boolean;
}

export interface SecurityInfo { signature?: SignatureInfo; encryption?: EncryptionInfo }

/** A stored key as the engines need it. */
export interface StoredKey {
  id: string; kind: Protocol; hasPrivate: boolean; emails: string[]; name: string; fingerprint: string; keyIds: string[];
  notBefore: Date | null; notAfter: Date | null; canSign: boolean; canEncrypt: boolean; publicData: string; privateData?: string;
}
export const usable = (k: { notBefore: Date | null; notAfter: Date | null }, at = new Date()) =>
  (!k.notBefore || k.notBefore <= at) && (!k.notAfter || k.notAfter >= at);

export const addrOf = (s: string) => (s.match(/<([^>]+)>/)?.[1] ?? s).trim().toLowerCase();
export const EMAIL = /[^\s<>,;"()]+@[^\s<>,;"()]+\.[^\s<>,;"()]+/g;
