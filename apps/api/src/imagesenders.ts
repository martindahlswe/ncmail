import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "./db.ts";

/**
 * Senders whose remote images load without asking, per person: an address, or "@domain" for everyone at a domain.
 * The reader decides per message (never in Junk, never when the sender checks failed, never for unverified decrypted
 * content: see imagesTrustable).
 */

const MAX = 2000;
const ADDRESS = /^[^\s@<>()",;:\\]+@[a-z0-9.-]+\.[a-z0-9-]+$/;
const DOMAIN = /^@[a-z0-9.-]+\.[a-z0-9-]+$/;
const sender = z.string().trim().toLowerCase().max(320).refine((s) => ADDRESS.test(s) || DOMAIN.test(s), "Not an address or @domain");
const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/**
 * Whether remote images of a message may load automatically for an allowed sender: not in Junk, not for decrypted content
 * that is not verified, and only when the receiving server confirmed the From domain (senderAuthenticated). A forged From
 * with no or unrelated sender checks must not be able to load a tracking picture as a trusted sender.
 */
export function imagesTrustable(o: { folderSpecial: string | null; authWarnings: number; unverified: boolean; authenticated: boolean }): boolean {
  return o.folderSpecial !== "\\Junk" && o.authWarnings === 0 && !o.unverified && o.authenticated;
}

export async function imageSenderRoutes(app: FastifyInstance) {
  app.get("/api/image-senders", async (req) => {
    const { rows } = await pool.query("select sender from image_senders where owner = $1 order by ltrim(sender, '@')", [req.owner]);
    return rows.map((r) => r.sender as string);
  });

  app.post("/api/image-senders", async (req, reply) => {
    const s = z.object({ sender }).parse(req.body).sender;
    const { rows: [n] } = await pool.query("select count(*)::int as n from image_senders where owner = $1", [req.owner]);
    if (n.n >= MAX) throw httpError(400, `You already allow images from ${MAX} senders. Remove some first.`);
    await pool.query("insert into image_senders (owner, sender) values ($1, $2) on conflict do nothing", [req.owner, s]);
    reply.code(201);
    return { sender: s };
  });

  app.delete<{ Params: { sender: string } }>("/api/image-senders/:sender", async (req, reply) => {
    await pool.query("delete from image_senders where owner = $1 and sender = $2", [req.owner, req.params.sender.toLowerCase()]);
    reply.code(204);
  });
}
