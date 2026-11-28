// Re-encrypts every stored secret under the current SECRET_KEY. Run after moving the old key to SECRET_KEY_OLD:  pnpm rotate-key
// A value that cannot be re-encrypted is reported (table, key) and skipped; the script then exits non-zero.
import pg from "pg";
import { pathToFileURL } from "node:url";
import { decryptWith, encrypt } from "../src/crypto.ts";

const targets: [string, string, string][] = [
  ["accounts", "id", "imap_password_enc"], ["accounts", "id", "smtp_password_enc"],
  ["nextcloud_links", "owner", "password_enc"], ["calendar_links", "account_id", "password_enc"],
  ["sieve_settings", "account_id", "password_enc"], ["crypto_keys", "id", "private_enc"],
];

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export async function rotateSecrets(db: Db, log: (line: string) => void = console.error) {
  let changed = 0, kept = 0;
  const failed: { table: string; column: string; key: string }[] = [];
  for (const [table, pk, col] of targets) {
    const { rows } = await db.query(`select ${pk}::text as pk, ${col} as v from ${table} where ${col} is not null`);
    for (const r of rows) {
      try {
        const { plain, current } = decryptWith(r.v);
        if (current && r.v.startsWith("v1:")) { kept++; continue; }
        await db.query(`update ${table} set ${col} = $1 where ${pk}::text = $2`, [encrypt(plain), r.pk]);
        changed++;
      } catch (e: any) {
        failed.push({ table, column: col, key: r.pk });
        log(`Could not re-encrypt ${table}.${col} where ${pk} = ${r.pk}: ${e?.message ?? e}`);
      }
    }
  }
  return { changed, kept, failed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const { changed, kept, failed } = await rotateSecrets(db).finally(() => db.end());
  console.log(`Re-encrypted ${changed} secret(s); ${kept} were already under the current key.`);
  if (failed.length) {
    console.error(`${failed.length} secret(s) could not be re-encrypted (listed above). Keep SECRET_KEY_OLD until they are fixed or removed.`);
    process.exitCode = 1;
  } else console.log("Everything is under the current key. You can now remove SECRET_KEY_OLD.");
}
