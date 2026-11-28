import type { ServerConfig } from "@ncmail/shared";
import { pool } from "./db.ts";
import { decrypt } from "./crypto.ts";

export interface AccountConfig {
  id: string;
  name: string;
  email: string;
  imap: ServerConfig;
  smtp: ServerConfig;
}

/** An account with its passwords. Request handlers pass the caller as `owner`, so another user's account is "not found". */
export async function loadAccount(id: string, owner?: string): Promise<AccountConfig> {
  const { rows } = owner === undefined
    ? await pool.query("select * from accounts where id = $1", [id])
    : await pool.query("select * from accounts where id = $1 and owner = $2", [id, owner]);
  const r = rows[0];
  if (!r) throw Object.assign(new Error("Account not found"), { statusCode: 404 });
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    imap: { host: r.imap_host, port: r.imap_port, security: r.imap_security, username: r.imap_username, password: decrypt(r.imap_password_enc) },
    smtp: { host: r.smtp_host, port: r.smtp_port, security: r.smtp_security, username: r.smtp_username, password: decrypt(r.smtp_password_enc) },
  };
}
