import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db.ts";
import { parsePgp } from "./pgp.ts";
import { parseSmime } from "./smime.ts";
import { deleteKey, encryptionKey, listKeys, ownEncryptionKey, saveKey, signingKey } from "./store.ts";
import { addrOf, usable, type ParsedKey, type Protocol } from "./types.ts";

const importBody = z.object({
  files: z.array(z.object({ name: z.string(), contentBase64: z.string() })).min(1).max(50),
  password: z.string().optional(),
});

/** OpenPGP packets start with a byte whose top bit is set; DER (certificates, PKCS#7/12) starts with 0x30. */
function looksPgp(name: string, data: Buffer): boolean {
  const head = data.subarray(0, 4096).toString("latin1");
  if (/-----BEGIN PGP /.test(head)) return true;
  if (/-----BEGIN /.test(head)) return false;
  return data.length > 0 && data[0] !== 0x30 && (data[0]! & 0x80) !== 0;
}

export async function secureRoutes(app: FastifyInstance) {
  // ---- import: any number of files; PGP and S/MIME are told apart by content, not by file name ----
  app.post<{ Params: { id: string } }>("/api/accounts/:id/keys/import", { bodyLimit: 30 * 1024 * 1024 }, async (req) => {
    const b = importBody.parse(req.body);
    const accountId = req.params.id;
    const { rows: ids } = await pool.query("select email from identities where account_id = $1", [accountId]);
    const mine = new Set<string>(ids.map((r) => r.email.toLowerCase()));

    const files = b.files.map((f) => ({ name: f.name, data: Buffer.from(f.contentBase64, "base64") }));
    const parsed: ParsedKey[] = [], errors: string[] = [];
    let needsPassword = false;
    for (const f of files.filter((f) => looksPgp(f.name, f.data))) {
      const r = await parsePgp(f.data, b.password);
      parsed.push(...r.keys); errors.push(...r.errors.map((e) => `${f.name}: ${e}`)); needsPassword ||= !!r.needsPassword;
    }
    const smimeFiles = files.filter((f) => !looksPgp(f.name, f.data));
    if (smimeFiles.length) {
      const r = parseSmime(smimeFiles, b.password);
      parsed.push(...r.keys); errors.push(...r.errors); needsPassword ||= !!r.needsPassword;
    }

    const imported: any[] = [];
    for (const k of parsed) {
      // Your own key must belong to one of this account's sender addresses; keys for other people are always fine.
      if (k.hasPrivate && !k.emails.some((e) => mine.has(e))) {
        errors.push(`The ${k.kind === "pgp" ? "key" : "certificate"} for ${k.emails.join(", ") || k.name} has a private key, but none of this account's sender addresses (${[...mine].join(", ")}) match. Add that address under Sender addresses first, or import only its public part as a contact.`);
        continue;
      }
      const r = await saveKey(accountId, k);
      imported.push({ id: r.id, kind: k.kind, name: k.name, emails: k.emails, fingerprint: k.fingerprint, hasPrivate: k.hasPrivate, created: r.created });
    }
    return { imported, errors, needsPassword };
  });

  // ---- list: your keys grouped under the sender address they are for, and other people's keys ----
  app.get<{ Params: { id: string } }>("/api/accounts/:id/keys", async (req) => {
    const { rows: ids } = await pool.query("select id, name, email from identities where account_id = $1 order by is_default desc, email", [req.params.id]);
    const keys = await listKeys(req.params.id);
    const view = (k: (typeof keys)[number]) => {
      const now = new Date();
      return {
        id: k.id, kind: k.kind, hasPrivate: k.hasPrivate, name: k.name, emails: k.emails, fingerprint: k.fingerprint,
        notBefore: k.notBefore, notAfter: k.notAfter, canSign: k.canSign, canEncrypt: k.canEncrypt,
        status: !usable(k, now) ? (k.notAfter && k.notAfter < now ? "expired" : "not-yet-valid") : "valid",
        info: k.info,
      };
    };
    const own = keys.filter((k) => k.hasPrivate);
    const emails = new Set(ids.map((i) => i.email.toLowerCase()));
    return {
      identities: ids.map((i) => ({ identityId: i.id, name: i.name, email: i.email, keys: own.filter((k) => k.emails.includes(i.email.toLowerCase())).map(view) })),
      contacts: keys.filter((k) => !k.hasPrivate).map(view),
      hidden: own.filter((k) => !k.emails.some((e) => emails.has(e))).length, // keys whose address is no longer one of yours
    };
  });

  app.delete<{ Params: { id: string } }>("/api/keys/:id", async (req, reply) => {
    await deleteKey(req.params.id, req.owner);
    reply.code(204);
  });

  // ---- what can this message use? Asked while composing. ----
  app.get<{ Params: { id: string }; Querystring: { identityId?: string; to?: string } }>("/api/accounts/:id/security", async (req) => {
    const { rows } = await pool.query("select email from identities where account_id = $1 and ($2::uuid is null or id = $2) order by is_default desc limit 1", [req.params.id, req.query.identityId ?? null]);
    const from = (rows[0]?.email ?? "").toLowerCase();
    const protos: Protocol[] = ["pgp", "smime"];
    const sign: Record<string, boolean> = {};
    const drafts: Record<string, boolean> = {}; // whether drafts can be kept encrypted to your own key
    for (const p of protos) { sign[p] = !!(await signingKey(req.owner, from, p)); drafts[p] = !!(await ownEncryptionKey(req.owner, from, p)); }
    const recipients = [...new Set((req.query.to ?? "").split(",").map(addrOf).filter((a) => a.includes("@")))];
    const rcpt = [];
    for (const r of recipients) rcpt.push({ email: r, pgp: !!(await encryptionKey(req.owner, r, "pgp")), smime: !!(await encryptionKey(req.owner, r, "smime")) });
    return { from, sign, drafts, recipients: rcpt };
  });
}
