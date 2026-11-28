import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "./db.ts";
import { loadAccount } from "./accounts.ts";
import { withImap } from "./mail.ts";
import { ACCESS, accessOf, deleteAcl, getAcl, setAcl } from "./acl.ts";

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
// a user name on the mail server; never the special identifiers ("anyone", "authenticated", "owner", groups, negative rights)
const userId = z.string().trim().min(1).max(256)
  .refine((s) => !/[\s"\\]/.test(s) && !/^[-$]/.test(s) && !["anyone", "authenticated", "owner", "administrators"].includes(s.toLowerCase()),
    "Enter the other person's user name on the mail server");

async function ownFolder(id: string, owner: string) {
  const { rows: [f] } = await pool.query(
    "select f.id, f.path, f.account_id, f.namespace, f.selectable, f.rights, a.supports_acl, a.imap_username from folders f join accounts a on a.id = f.account_id where f.id = $1 and a.owner = $2", [id, owner]);
  if (!f) throw httpError(404, "Folder not found");
  // your own folders, or any folder where the server gives you the right to manage access ("a"), such as a public folder you look after
  const mayAdminister = f.namespace === "personal" || String(f.rights ?? "").includes("a");
  if (!f.selectable || !mayAdminister) throw httpError(400, "You cannot change who can use this folder.");
  if (!f.supports_acl) throw httpError(400, "Your mail server does not support sharing folders.");
  return f;
}

/** Sharing folders with other users of the same mail server (RFC 4314): your own, or ones the server lets you administer. */
export async function aclRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/api/folders/:id/acl", async (req) => {
    const f = await ownFolder(req.params.id, req.owner);
    const cfg = await loadAccount(f.account_id);
    const entries = await withImap(cfg.imap, (c) => getAcl(c, f.path));
    return entries
      .filter((e) => e.identifier.toLowerCase() !== String(f.imap_username).toLowerCase() && !/^(owner|anyone|authenticated)$/i.test(e.identifier))
      .map((e) => ({ user: e.identifier, access: accessOf(e.rights), rights: e.rights }));
  });

  app.put<{ Params: { id: string } }>("/api/folders/:id/acl", async (req) => {
    const { user, access } = z.object({ user: userId, access: z.enum(["read", "write"]) }).parse(req.body);
    const f = await ownFolder(req.params.id, req.owner);
    if (user.toLowerCase() === String(f.imap_username).toLowerCase()) throw httpError(400, "That is you.");
    const cfg = await loadAccount(f.account_id);
    await withImap(cfg.imap, (c) => setAcl(c, f.path, user, ACCESS[access]));
    return { user, access };
  });

  app.delete<{ Params: { id: string; user: string } }>("/api/folders/:id/acl/:user", async (req, reply) => {
    const user = userId.parse(req.params.user);
    const f = await ownFolder(req.params.id, req.owner);
    const cfg = await loadAccount(f.account_id);
    await withImap(cfg.imap, (c) => deleteAcl(c, f.path, user));
    reply.code(204);
  });
}
