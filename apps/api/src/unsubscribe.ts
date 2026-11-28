import type { FastifyInstance } from "fastify";
import { pool } from "./db.ts";
import { loadAccount } from "./accounts.ts";
import { downloadRaw, withImap } from "./mail.ts";
import { HEADERS_VERSION, parseSource } from "./content.ts";
import { guardUrl, httpRequest, type PlainResponse } from "./netguard.ts";
import { resolveIdentity } from "./identities.ts";
import { sendMail } from "./send.ts";
import { loadMessage } from "./routes.ts";
import { mailtoAddress, unsubscribeOffer, type Unsubscribe } from "./listunsub.ts";

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/** Unsubscribing from a mailing list: one click, a mail to the list, or the list's page (see listunsub.ts). */

/** The parsed headers of a message: from the body cache when it is current, else from the mail server. */
export async function headersOf(m: any): Promise<any> {
  const { rows: [b] } = await pool.query("select headers from message_bodies where message_id = $1", [m.id]);
  if (b?.headers?.v >= HEADERS_VERSION) return b.headers;
  const cfg = await loadAccount(m.account_id);
  const raw = await withImap(cfg.imap, async (c) => {
    const lock = await c.getMailboxLock(m.folder_path);
    try { return await downloadRaw(c, m.uid); } finally { lock.release(); }
  });
  return (await parseSource(raw)).cache.headers;
}

export async function unsubscribeRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string } }>("/api/messages/:id/unsubscribe", async (req) => {
    const m = await loadMessage(req.params.id, req.owner);
    const h = await headersOf(m);
    const u: Unsubscribe | null = h.unsubscribe ?? null;
    const offer = unsubscribeOffer(u, h.auth, m.folder_special, m.from_addr ?? "");
    if (!offer) throw httpError(400, "This message offers no way to unsubscribe.");

    if (offer.method === "one-click") {
      const url = new URL(u!.http!);
      const lookup = await guardUrl(url, "unsubscribe");
      let r: PlainResponse;
      try {
        r = await httpRequest(url, {
          method: "POST", lookup, timeoutMs: 10_000,
          headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "NCMail" },
          body: "List-Unsubscribe=One-Click",
        });
      } catch {
        throw httpError(502, `${url.hostname} did not answer. Try again later.`);
      }
      if (r.status >= 400) throw httpError(502, `${url.hostname} refused the request (${r.status}).`);
      return { done: true, method: offer.method, target: offer.target };
    }

    if (offer.method === "mail") {
      // one address, and our own fixed words: the header's subject, body and other recipients are not used
      const to = mailtoAddress(u!.mailto)!;
      const cfg = await loadAccount(m.account_id);
      // from the address the list writes to, when that is one of yours
      const rcpts = [...(m.to_addrs ?? []), ...(m.cc_addrs ?? [])].map((a: any) => String(a.address ?? "").toLowerCase());
      const { rows: ids } = await pool.query("select id, email from identities where account_id = $1", [cfg.id]);
      const mine = ids.find((i) => rcpts.includes(String(i.email).toLowerCase()));
      const from = await resolveIdentity(cfg.id, mine?.id);
      await sendMail(cfg, { name: from.name, email: from.email }, {
        to: [to], cc: [], bcc: [], subject: "unsubscribe",
        text: "unsubscribe", references: [], attachments: [],
      });
      return { done: true, method: offer.method, target: to };
    }

    return { done: false, method: offer.method, target: offer.target }; // the browser opens the page
  });
}
