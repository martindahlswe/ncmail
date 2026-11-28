import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "./db.ts";

/** Whether read-receipt requests are offered ("ask", the default) or never answered ("never"). */
export async function readReceiptsPref(owner: string): Promise<"ask" | "never"> {
  const { rows: [p] } = await pool.query("select read_receipts from user_prefs where owner = $1", [owner]);
  return p?.read_receipts === "never" ? "never" : "ask";
}

/** Choices of the signed-in person that are not tied to one mail account. */
export async function prefsRoutes(app: FastifyInstance) {
  const out = (p: any) => ({ notifyNewMail: p ? p.notify_new_mail : true, readReceipts: p?.read_receipts === "never" ? "never" : "ask" });

  app.get("/api/prefs", async (req) => {
    const { rows: [p] } = await pool.query("select notify_new_mail, read_receipts from user_prefs where owner = $1", [req.owner]);
    return out(p);
  });

  // only what is sent changes
  app.patch("/api/prefs", async (req) => {
    const b = z.object({ notifyNewMail: z.boolean(), readReceipts: z.enum(["ask", "never"]) }).partial().parse(req.body);
    const { rows: [p] } = await pool.query(
      `insert into user_prefs (owner, notify_new_mail, read_receipts) values ($1, coalesce($2, true), coalesce($3, 'ask'))
       on conflict (owner) do update set notify_new_mail = coalesce($2, user_prefs.notify_new_mail), read_receipts = coalesce($3, user_prefs.read_receipts)
       returning notify_new_mail, read_receipts`, [req.owner, b.notifyNewMail ?? null, b.readReceipts ?? null]);
    if (b.notifyNewMail === false) await pool.query("delete from new_mail where owner = $1 and delivered_at is null", [req.owner]);
    return out(p);
  });
}
