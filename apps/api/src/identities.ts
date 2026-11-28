import type { FastifyInstance } from "fastify";
import { identityInputSchema, type Identity } from "@ncmail/shared";
import { z } from "zod";
import { pool } from "./db.ts";
import { cleanSignatureHtml } from "./signatureHtml.ts";

export const identityOut = (r: any): Identity => ({
  id: r.id, accountId: r.account_id, name: r.name, email: r.email, isDefault: r.is_default,
  signatureHtml: r.signature_html ?? "", signatureText: r.signature_text ?? "", signatureIsHtml: !!r.signature_is_html, replyTo: r.reply_to ?? "",
});

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/** Look up an identity of the account; falls back to the account's default. */
export async function resolveIdentity(accountId: string, identityId?: string) {
  const { rows } = await pool.query(
    `select * from identities where account_id = $1 and ($2::uuid is null or id = $2) order by is_default desc limit 1`,
    [accountId, identityId ?? null]);
  if (!rows[0]) throw httpError(400, "Unknown sender identity for this account");
  return identityOut(rows[0]);
}

export async function identityRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/api/accounts/:id/identities", async (req) => {
    const { rows } = await pool.query(
      "select * from identities where account_id = $1 order by is_default desc, created_at", [req.params.id]);
    return rows.map(identityOut);
  });

  app.post<{ Params: { id: string } }>("/api/accounts/:id/identities", async (req, reply) => {
    const { name, email, signatureHtml, signatureText, signatureIsHtml, replyTo } = identityInputSchema.parse(req.body);
    try {
      const { rows } = await pool.query(
        `insert into identities (account_id, name, email, is_default, signature_html, signature_text, reply_to, signature_is_html)
         values ($1,$2,$3, not exists (select 1 from identities where account_id = $1), $4, $5, $6, $7) returning *`,
        [req.params.id, name, email, signatureHtml ? cleanSignatureHtml(signatureHtml) : "", signatureText ?? "", replyTo ?? "", !!signatureIsHtml]);
      reply.code(201);
      return identityOut(rows[0]);
    } catch (e: any) {
      if (e.code === "23505") throw httpError(409, "That address is already configured for this account");
      if (e.code === "23503") throw httpError(404, "Account not found");
      throw e;
    }
  });

  app.patch<{ Params: { id: string; identityId: string } }>("/api/accounts/:id/identities/:identityId", async (req) => {
    const body = identityInputSchema.partial().extend({ isDefault: z.boolean().optional() }).parse(req.body);
    const { id, identityId } = req.params;
    const client = await pool.connect();
    try {
      await client.query("begin");
      const { rows: [cur] } = await client.query("select * from identities where id = $1 and account_id = $2 for update", [identityId, id]);
      if (!cur) throw httpError(404, "Identity not found");
      if (body.isDefault) {
        await client.query("update identities set is_default = false where account_id = $1", [id]);
      } else if (body.isDefault === false && cur.is_default) {
        throw httpError(400, "Pick another identity as default instead");
      }
      const { rows: [row] } = await client.query(
        `update identities set name = coalesce($3, name), email = coalesce($4, email),
           is_default = case when $5::boolean is true then true else is_default end,
           signature_html = coalesce($6, signature_html), signature_text = coalesce($7, signature_text),
           reply_to = coalesce($8, reply_to), signature_is_html = coalesce($9, signature_is_html)
         where id = $1 and account_id = $2 returning *`,
        [identityId, id, body.name ?? null, body.email ?? null, body.isDefault ?? null,
          body.signatureHtml == null ? null : cleanSignatureHtml(body.signatureHtml), body.signatureText ?? null, body.replyTo ?? null, body.signatureIsHtml ?? null]);
      await client.query("commit");
      return identityOut(row);
    } catch (e: any) {
      await client.query("rollback");
      if (e.code === "23505") throw httpError(409, "That address is already configured for this account");
      throw e;
    } finally {
      client.release();
    }
  });

  app.delete<{ Params: { id: string; identityId: string } }>("/api/accounts/:id/identities/:identityId", async (req, reply) => {
    const { id, identityId } = req.params;
    const { rows } = await pool.query("select * from identities where account_id = $1 order by created_at", [id]);
    const target = rows.find((r) => r.id === identityId);
    if (!target) throw httpError(404, "Identity not found");
    if (rows.length === 1) throw httpError(400, "An account needs at least one sender address");
    await pool.query("delete from identities where id = $1", [identityId]);
    if (target.is_default) {
      const next = rows.find((r) => r.id !== identityId)!;
      await pool.query("update identities set is_default = true where id = $1", [next.id]);
    }
    reply.code(204);
  });
}
