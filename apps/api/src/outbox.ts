import type { FastifyInstance } from "fastify";
import { pool } from "./db.ts";
import { loadAccount } from "./accounts.ts";
import { deliverPrepared, type Prepared } from "./send.ts";
import { deleteDraft } from "./drafts.ts";
import { publish } from "./events.ts";

/**
 * Messages are queued for a few seconds before they are sent, which is what makes "Undo send" possible, and safe:
 * the finished message is stored in the database, so closing the tab (or restarting the server) cannot lose it or
 * stop it from being sent. Cancelling within the window simply removes it from the queue.
 */

type Log = { error: (...a: any[]) => void; info: (...a: any[]) => void };

/** Messages one person may have waiting (undo window and send later together). */
const MAX_QUEUED = () => Number(process.env.NCMAIL_OUTBOX_MAX) || 100;
/** Deliveries running at once. Each account has at most one, so a slow mail server only holds up its own account. */
const MAX_IN_FLIGHT = 8;
/** One delivery attempt, start to finish: inactivity timeouts alone do not end a server that keeps answering slowly. */
const SEND_DEADLINE_MS = 120_000;
/** A row still 'sending' after this long was being sent by a process that stopped. It is never sent again automatically. */
const STALE_SENDING = "5 minutes";
const MAYBE_SENT = "It may have been delivered: check Sent before sending it again.";

export async function queueOutbox(o: { accountId: string; prepared: Prepared; subject: string; delaySeconds: number; sendAt?: Date; draftUid?: number }) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows: [acc] } = await client.query("select owner from accounts where id = $1", [o.accountId]);
    const owner = acc?.owner ?? "";
    // one person's sends are counted one at a time, so parallel requests cannot pass the limit together
    await client.query("select pg_advisory_xact_lock(hashtext('outbox:' || $1))", [owner]);
    const { rows: [q] } = await client.query(
      "select count(*)::int as n from outbox o join accounts a on a.id = o.account_id where a.owner = $1 and o.status in ('pending','sending')", [owner]);
    if (q.n >= MAX_QUEUED()) throw Object.assign(new Error(`At most ${MAX_QUEUED()} messages can wait to be sent. Wait for some to go out, or cancel some first.`), { statusCode: 429 });
    const { rows: [r] } = await client.query(
      `insert into outbox (account_id, from_addr, to_addrs, subject, raw, send_at, draft_uid, copies)
       values ($1, $2, $3, $4, $5, coalesce($8::timestamptz, now() + make_interval(secs => $6)), $7, $9) returning id, send_at`,
      [o.accountId, o.prepared.envelopeFrom, o.prepared.envelopeTo, o.subject, o.prepared.raw, o.delaySeconds, o.draftUid ?? null, o.sendAt ?? null,
       o.prepared.copies?.length ? JSON.stringify(o.prepared.copies.map((c) => ({ to: c.to, raw: c.raw.toString("base64") }))) : null]);
    await client.query("commit");
    return { id: String(r.id), sendAt: r.send_at.toISOString() };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const inFlight = new Set<string>(); // accounts with a delivery running in this process

const untilAborted = <T>(p: Promise<T>, signal: AbortSignal) =>
  Promise.race([p, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);

async function deliverRow(r: any, log: Log) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`Sending took too long. ${MAYBE_SENT}`)), SEND_DEADLINE_MS);
  let delivered = false;
  try {
    const cfg = await loadAccount(r.account_id);
    const onDelivered = async () => {
      delivered = true;
      await pool.query("update outbox set status = 'sent', raw = null, copies = null where id = $1 and status = 'sending'", [r.id]);
      if (r.draft_uid) await deleteDraft(r.account_id, r.draft_uid).catch((e) => log.error(e, "could not remove sent draft"));
    };
    const copies = (r.copies ?? []).map((c: { to: string; raw: string }) => ({ to: c.to, raw: Buffer.from(c.raw, "base64") }));
    await untilAborted(deliverPrepared(cfg, { raw: r.raw, envelopeFrom: r.from_addr, envelopeTo: r.to_addrs, copies }, { signal: ac.signal, onDelivered }), ac.signal);
  } catch (e: any) {
    if (delivered) log.error({ err: e?.message, id: r.id }, "queued message was sent, but the copy in Sent was not saved");
    else {
      log.error({ err: e?.message, id: r.id }, "queued message could not be sent");
      await pool.query("update outbox set status = 'failed', error = $2 where id = $1 and status = 'sending'", [r.id, String(e?.message ?? e)])
        .catch((e2) => log.error(e2, "could not mark queued message as failed"));
    }
  } finally {
    clearTimeout(timer);
    inFlight.delete(r.account_id);
    publish({ type: "outbox", accountId: r.account_id });
  }
}

async function processDue(log: Log) {
  await pool.query(
    `update outbox set status = 'failed', error = $1 where status = 'sending' and (claimed_at is null or claimed_at < now() - interval '${STALE_SENDING}')`,
    [`Sending was interrupted. ${MAYBE_SENT}`]);
  const free = MAX_IN_FLIGHT - inFlight.size;
  if (free > 0) {
    // the oldest due message of each account that is not already sending one, oldest first
    const { rows } = await pool.query(
      `update outbox set status = 'sending', claimed_at = now() where id in (
         select id from outbox where status = 'pending' and id in (
           select distinct on (account_id) id from outbox o
           where status = 'pending' and send_at <= now() and not (account_id = any($1::uuid[]))
             and not exists (select 1 from outbox s where s.account_id = o.account_id and s.status = 'sending')
           order by account_id, send_at, id)
         order by send_at limit $2 for update skip locked)
       returning *`, [[...inFlight], free]);
    for (const r of rows) { inFlight.add(r.account_id); void deliverRow(r, log); } // not awaited: deliveries run side by side
  }
  await pool.query("delete from outbox where status in ('sent','cancelled') and created_at < now() - interval '1 hour'");
}

export function startOutbox(log: Log) {
  let busy = false;
  const tick = async () => { if (busy) return; busy = true; try { await processDue(log); } catch (e) { log.error(e, "outbox failed"); } finally { busy = false; } };
  tick(); // anything that came due while the server was down
  setInterval(tick, 1000).unref();
}

export async function outboxRoutes(app: FastifyInstance) {
  // What is waiting, or failed (so a failure is never silent).
  app.get("/api/outbox", async (req) => {
    const { rows } = await pool.query(
      "select o.id, o.account_id, o.subject, o.to_addrs, o.send_at, o.status, o.error, (o.send_at - o.created_at > interval '2 minutes') as scheduled from outbox o join accounts a on a.id = o.account_id where a.owner = $1 and o.status in ('pending','sending','failed') order by o.send_at", [req.owner]);
    return rows.map((r) => ({ id: String(r.id), accountId: r.account_id, subject: r.subject, to: r.to_addrs, sendAt: r.send_at.toISOString(), status: r.status, error: r.error, scheduled: r.scheduled }));
  });

  // Undo send: only works while it is still waiting.
  app.post<{ Params: { id: string } }>("/api/outbox/:id/cancel", async (req) => {
    const { rowCount } = await pool.query("update outbox o set status = 'cancelled', raw = null, copies = null from accounts a where o.id = $1 and o.status = 'pending' and a.id = o.account_id and a.owner = $2", [req.params.id, req.owner]);
    if (!rowCount) throw Object.assign(new Error("It has already been sent"), { statusCode: 409 });
    return { cancelled: true };
  });

  // Send a waiting message right now (skip the remaining delay).
  app.post<{ Params: { id: string } }>("/api/outbox/:id/send-now", async (req) => {
    await pool.query("update outbox o set send_at = now() from accounts a where o.id = $1 and o.status = 'pending' and a.id = o.account_id and a.owner = $2", [req.params.id, req.owner]);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/outbox/:id", async (req, reply) => {
    await pool.query("delete from outbox o using accounts a where o.id = $1 and o.status = 'failed' and a.id = o.account_id and a.owner = $2", [req.params.id, req.owner]);
    reply.code(204);
  });
}
