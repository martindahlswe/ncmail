import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "./db.ts";

/** Reusable messages: a name, an optional subject and a rich-text body, kept per person (not per mail account). */
const input = z.object({
  name: z.string().trim().min(1).max(200),
  subject: z.string().max(998).default(""),
  html: z.string().max(200_000).default(""),
});
// changes: only what is sent (no defaults, so renaming keeps the subject and text)
const change = z.object({ name: z.string().trim().min(1).max(200), subject: z.string().max(998), html: z.string().max(200_000) }).partial();
const out = (r: any) => ({ id: r.id, name: r.name, subject: r.subject, html: r.html });
const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

export async function templateRoutes(app: FastifyInstance) {
  app.get("/api/templates", async (req) => {
    const { rows } = await pool.query("select * from templates where owner = $1 order by lower(name), created_at", [req.owner]);
    return rows.map(out);
  });

  app.post("/api/templates", async (req, reply) => {
    const t = input.parse(req.body);
    const { rows: [n] } = await pool.query("select count(*)::int as n from templates where owner = $1", [req.owner]);
    if (n.n >= 500) throw httpError(400, "You already have 500 templates. Remove some first.");
    const { rows: [r] } = await pool.query(
      "insert into templates (owner, name, subject, html) values ($1, $2, $3, $4) returning *", [req.owner, t.name, t.subject, t.html]);
    reply.code(201);
    return out(r);
  });

  app.patch<{ Params: { id: string } }>("/api/templates/:id", async (req) => {
    const t = change.parse(req.body);
    const { rows: [r] } = await pool.query(
      `update templates set name = coalesce($3, name), subject = coalesce($4, subject), html = coalesce($5, html)
        where id = $1 and owner = $2 returning *`, [req.params.id, req.owner, t.name ?? null, t.subject ?? null, t.html ?? null]);
    if (!r) throw httpError(404, "Not found");
    return out(r);
  });

  app.delete<{ Params: { id: string } }>("/api/templates/:id", async (req, reply) => {
    const { rowCount } = await pool.query("delete from templates where id = $1 and owner = $2", [req.params.id, req.owner]);
    if (!rowCount) throw httpError(404, "Not found");
    reply.code(204);
  });
}
