import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import { ownerOf } from "./auth.ts";

/** Pushed to every connected browser whenever a sync finished (from IDLE, polling, or a user action). */
export type ServerEvent = { type: "sync"; accountId: string; folderId?: string } | { type: "outbox"; accountId: string }

const bus = new EventEmitter();
bus.setMaxListeners(200);
export const publish = (e: ServerEvent) => bus.emit("event", e);

/** Open live-update streams per user (each holds a socket and a bus listener); more tabs than this get a 429. */
const maxStreams = () => { const n = Number(process.env.NCMAIL_MAX_EVENT_STREAMS); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10; };
/** A client that reads slower than events arrive is disconnected instead of buffering without end; it reconnects and reloads. */
const MAX_BUFFERED = 64 * 1024;
const streams = new Map<string, number>();
export const openStreams = (owner: string) => streams.get(owner) ?? 0;
/** All open live-update streams, for the metrics endpoint. */
export const allStreams = () => [...streams.values()].reduce((a, b) => a + b, 0);

export async function eventRoutes(app: FastifyInstance) {
  app.get("/api/events", (req, reply) => {
    const owner = req.owner;
    if (openStreams(owner) >= maxStreams()) {
      return reply.code(429).header("retry-after", "60").send({ error: "Too many open Mail windows. Close some to get live updates in this one." });
    }
    streams.set(owner, openStreams(owner) + 1);
    reply.hijack();
    const res = reply.raw;
    let closed = false;
    const write = (chunk: string) => {
      if (closed) return;
      if (res.writableLength > MAX_BUFFERED) { res.destroy(); return; }
      res.write(chunk);
    };
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no", // keep proxies (nginx) from buffering the stream
    });
    write("retry: 3000\n\n");
    const owners = new Map<string, string>();
    const send = async (e: ServerEvent) => { // only events about this user's own accounts
      let o = owners.get(e.accountId);
      if (o === undefined) { o = await ownerOf(e.accountId).catch(() => "\u0000"); owners.set(e.accountId, o); }
      if (o === owner) write(`data: ${JSON.stringify(e)}\n\n`);
    };
    bus.on("event", send);
    const keepAlive = setInterval(() => write(": keep-alive\n\n"), 25_000);
    const done = () => {
      if (closed) return;
      closed = true;
      bus.off("event", send);
      clearInterval(keepAlive);
      const n = openStreams(owner) - 1;
      if (n > 0) streams.set(owner, n); else streams.delete(owner);
    };
    req.raw.on("close", done);
    res.on("close", done);
    res.on("error", done);
  });
}
