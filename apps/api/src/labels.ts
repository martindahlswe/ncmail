import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "./db.ts";

/**
 * Labels are IMAP keywords ("$ncl_<slug>") on the messages themselves, so other mail clients keep them and they work across folders.
 * The table only holds each label's display name and colour. Saved searches are named queries.
 */
export const LABEL_PREFIX = "$ncl_";
export const slugify = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
export const labelsOf = (flags: string[]) => flags.filter((f) => f.startsWith(LABEL_PREFIX)).map((f) => f.slice(LABEL_PREFIX.length));

const COLORS = ["#e11d48", "#ea580c", "#ca8a04", "#16a34a", "#0d9488", "#2563eb", "#7c3aed", "#c026d3", "#64748b"];

export async function labelRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/api/accounts/:id/labels", async (req) => {
    const { rows } = await pool.query("select slug, name, color from labels where account_id = $1 order by lower(name)", [req.params.id]);
    return rows;
  });
  app.post<{ Params: { id: string } }>("/api/accounts/:id/labels", async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(1).max(40), color: z.string().regex(/^#[0-9a-f]{6}$/i).optional() }).parse(req.body);
    const slug = slugify(b.name);
    if (!slug) throw Object.assign(new Error("Use letters or numbers in the label name"), { statusCode: 400 });
    const { rows: [n] } = await pool.query("select count(*)::int c from labels where account_id = $1", [req.params.id]);
    const { rows: [r] } = await pool.query(
      `insert into labels (account_id, slug, name, color) values ($1,$2,$3,$4)
       on conflict (account_id, slug) do update set name = excluded.name, color = coalesce($5, labels.color) returning slug, name, color`,
      [req.params.id, slug, b.name, b.color ?? COLORS[n.c % COLORS.length], b.color ?? null]);
    reply.code(201);
    return r;
  });
  app.patch<{ Params: { id: string; slug: string } }>("/api/accounts/:id/labels/:slug", async (req) => {
    const b = z.object({ name: z.string().trim().min(1).max(40).optional(), color: z.string().regex(/^#[0-9a-f]{6}$/i).optional() }).parse(req.body);
    const { rows: [r] } = await pool.query("update labels set name = coalesce($3, name), color = coalesce($4, color) where account_id = $1 and slug = $2 returning slug, name, color", [req.params.id, req.params.slug, b.name ?? null, b.color ?? null]);
    if (!r) throw Object.assign(new Error("No such label"), { statusCode: 404 });
    return r;
  });
  app.delete<{ Params: { id: string; slug: string } }>("/api/accounts/:id/labels/:slug", async (req, reply) => {
    await pool.query("delete from labels where account_id = $1 and slug = $2", [req.params.id, req.params.slug]);
    reply.code(204);
  });

  // ---- saved searches ----
  app.get<{ Params: { id: string } }>("/api/accounts/:id/saved-searches", async (req) =>
    (await pool.query("select id::text, name, query from saved_searches where account_id = $1 order by lower(name)", [req.params.id])).rows);
  app.post<{ Params: { id: string } }>("/api/accounts/:id/saved-searches", async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(1).max(60), query: z.string().trim().min(1).max(500) }).parse(req.body);
    const { rows: [r] } = await pool.query("insert into saved_searches (account_id, name, query) values ($1,$2,$3) returning id::text, name, query", [req.params.id, b.name, b.query]);
    reply.code(201);
    return r;
  });
  app.delete<{ Params: { id: string; sid: string } }>("/api/accounts/:id/saved-searches/:sid", async (req, reply) => {
    if (!/^\d+$/.test(req.params.sid)) throw Object.assign(new Error("Not found"), { statusCode: 404 });
    await pool.query("delete from saved_searches where account_id = $1 and id = $2", [req.params.id, req.params.sid]);
    reply.code(204);
  });
}
