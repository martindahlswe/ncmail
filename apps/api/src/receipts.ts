import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "./db.ts";
import { loadAccount } from "./accounts.ts";
import { smtpTransport, withImap } from "./mail.ts";
import { resolveIdentity } from "./identities.ts";
import { loadMessage } from "./routes.ts";
import { headersOf } from "./unsubscribe.ts";
import { buildMdn, MDN_SENT, receiptOffer } from "./mdn.ts";
import { readReceiptsPref } from "./prefs.ts";

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/** The account's sender addresses, lower case. */
async function ownAddresses(accountId: string): Promise<{ id: string; email: string }[]> {
  const { rows } = await pool.query("select id, lower(email) as email from identities where account_id = $1", [accountId]);
  return rows;
}

/** Where a read receipt may go for this message (see mdn.ts), for the reader. */
export async function receiptFor(m: any, headers: any): Promise<string | null> {
  if (!headers?.receipt) return null;
  const own = await ownAddresses(m.account_id);
  return receiptOffer(headers.receipt, { flags: m.flags, folderSpecial: m.folder_special, fromMine: own.some((i) => i.email === String(m.from_addr ?? "").toLowerCase()) });
}

export async function receiptRoutes(app: FastifyInstance) {
  // Answer a read-receipt request: send the receipt, or decline. Either way the message is marked so it is not asked again.
  app.post<{ Params: { id: string } }>("/api/messages/:id/receipt", async (req) => {
    const { send } = z.object({ send: z.boolean() }).parse(req.body);
    const m = await loadMessage(req.params.id, req.owner);
    const headers = await headersOf(m);
    const to = await receiptFor(m, headers);
    if (!to) throw httpError(400, "This message does not ask for a read receipt, or it was already answered.");
    const cfg = await loadAccount(m.account_id);

    if (send && (await readReceiptsPref(req.owner)) === "never") throw httpError(400, "Read receipts are switched off in your settings.");
    if (send) {
      // from the address the message reached, like a reply
      const reached = [...(m.to_addrs ?? []), ...(m.cc_addrs ?? [])].map((a: any) => String(a.address ?? "").toLowerCase()).concat(headers.deliveredTo ?? []);
      const mine = (await ownAddresses(cfg.id)).find((i) => reached.includes(i.email));
      const from = await resolveIdentity(cfg.id, mine?.id);
      const raw = buildMdn({ from: { name: from.name, email: from.email }, to, subject: m.subject ?? "", originalMessageId: m.message_id ?? headers.messageId ?? null, originalDate: new Date(m.date) });
      const smtp = await smtpTransport(cfg.smtp);
      await smtp.sendMail({ envelope: { from: from.email, to: [to] }, raw });
    }

    await withImap(cfg.imap, async (c) => {
      const lock = await c.getMailboxLock(m.folder_path);
      try { await c.messageFlagsAdd(String(m.uid), [MDN_SENT], { uid: true }); } finally { lock.release(); }
    }).catch((e) => req.log.warn(e, "could not mark the receipt as answered")); // the server may not keep keywords
    await pool.query("update messages set flags = array_append(flags, $2) where id = $1 and not ($2 = any(flags))", [m.id, MDN_SENT]);
    return { ok: true, sent: send };
  });
}
