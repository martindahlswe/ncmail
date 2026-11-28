import { pool } from "../db.ts";
import { encrypt, decrypt } from "../crypto.ts";
import type { ParsedKey, Protocol, StoredKey } from "./types.ts";
import { usable } from "./types.ts";

/** Keys and certificates live in Postgres; private key material is encrypted with SECRET_KEY like account passwords. */

const rowToKey = (r: any, withPrivate = false): StoredKey => ({
  id: r.id, kind: r.kind, hasPrivate: r.has_private, emails: r.emails, name: r.name, fingerprint: r.fingerprint, keyIds: r.key_ids,
  notBefore: r.not_before, notAfter: r.not_after, canSign: r.can_sign, canEncrypt: r.can_encrypt, publicData: r.public_data,
  privateData: withPrivate && r.private_enc ? decrypt(r.private_enc) : undefined,
});

/**
 * Store a key. `fromMessage` marks a certificate kept from a signed message: it then only adds its addresses to an
 * existing row, and an imported key for the same address keeps priority over it.
 */
export async function saveKey(accountId: string, k: ParsedKey, opts: { fromMessage?: boolean } = {}): Promise<{ id: string; created: boolean }> {
  const { rows: [r] } = await pool.query(
    `insert into crypto_keys (account_id, kind, has_private, emails, name, fingerprint, key_ids, not_before, not_after, can_sign, can_encrypt, public_data, private_enc, info, from_message)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     on conflict (account_id, kind, fingerprint) do update set
       has_private = crypto_keys.has_private or excluded.has_private,
       private_enc = coalesce(excluded.private_enc, crypto_keys.private_enc),
       emails = case when excluded.from_message then array(select distinct e from unnest(crypto_keys.emails || excluded.emails) e) else excluded.emails end,
       from_message = crypto_keys.from_message and excluded.from_message,
       name = excluded.name, public_data = excluded.public_data, info = excluded.info,
       can_sign = excluded.can_sign, can_encrypt = excluded.can_encrypt, not_before = excluded.not_before, not_after = excluded.not_after
     returning id, (xmax = 0) as created`,
    [accountId, k.kind, k.hasPrivate, k.emails, k.name, k.fingerprint, k.keyIds, k.notBefore, k.notAfter, k.canSign, k.canEncrypt, k.publicData,
     k.privateData ? encrypt(k.privateData) : null, JSON.stringify(k.info), !!opts.fromMessage]);
  return { id: r.id, created: r.created };
}

export async function listKeys(accountId: string): Promise<(StoredKey & { info: any; createdAt: Date })[]> {
  const { rows } = await pool.query("select * from crypto_keys where account_id = $1 order by created_at desc", [accountId]);
  return rows.map((r) => ({ ...rowToKey(r), info: r.info, createdAt: r.created_at }));
}

export async function deleteKey(id: string, owner: string) { return (await pool.query("delete from crypto_keys k using accounts a where k.id = $1 and a.id = k.account_id and a.owner = $2", [id, owner])).rowCount; }

/** Your own usable key for sending as this address. */
export async function signingKey(owner: string, email: string, kind: Protocol): Promise<StoredKey | null> {
  const { rows } = await pool.query(
    "select k.* from crypto_keys k join accounts a on a.id = k.account_id where a.owner = $3 and k.kind = $1 and k.has_private and k.can_sign and $2 = any(k.emails) order by k.created_at desc", [kind, email.toLowerCase(), owner]);
  const r = rows.map((x) => rowToKey(x, true)).find((k) => usable(k));
  return r ?? null;
}

/** A key to encrypt to this address: someone's public key, or your own. One kept from a received message never outranks an imported one. */
export async function encryptionKey(owner: string, email: string, kind: Protocol): Promise<StoredKey | null> {
  const { rows } = await pool.query(
    "select k.* from crypto_keys k join accounts a on a.id = k.account_id where a.owner = $3 and k.kind = $1 and k.can_encrypt and $2 = any(k.emails) order by k.has_private desc, k.from_message, k.created_at desc", [kind, email.toLowerCase(), owner]);
  return rows.map((x) => rowToKey(x)).find((k) => usable(k)) ?? null;
}

/** Your own key for this address that you can both encrypt to and decrypt with (for drafts kept encrypted). */
export async function ownEncryptionKey(owner: string, email: string, kind: Protocol): Promise<StoredKey | null> {
  const { rows } = await pool.query(
    "select k.* from crypto_keys k join accounts a on a.id = k.account_id where a.owner = $3 and k.kind = $1 and k.has_private and k.can_encrypt and $2 = any(k.emails) order by k.created_at desc", [kind, email.toLowerCase(), owner]);
  return rows.map((x) => rowToKey(x)).find((k) => usable(k)) ?? null;
}

/** Everything that can be used to check a signature (public parts only). */
export async function knownKeys(owner: string): Promise<StoredKey[]> {
  const { rows } = await pool.query("select k.* from crypto_keys k join accounts a on a.id = k.account_id where a.owner = $1", [owner]);
  return rows.map((r) => rowToKey(r));
}
/** Your private keys, for decrypting. */
export async function privateKeys(owner: string, kind: Protocol): Promise<StoredKey[]> {
  const { rows } = await pool.query("select k.* from crypto_keys k join accounts a on a.id = k.account_id where a.owner = $2 and k.kind = $1 and k.has_private", [kind, owner]);
  return rows.map((r) => rowToKey(r, true));
}
