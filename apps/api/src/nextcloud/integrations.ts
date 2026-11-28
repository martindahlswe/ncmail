import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db.ts";
import { discoverCalendars, putObject, type DavCfg } from "../calendar/caldav.ts";
import { davFetch, escText, getNcLink, requireNcLink, type NcLink } from "./link.ts";
import { loadMessage } from "../routes.ts";

/**
 * Other Nextcloud apps, as the signed-in user (through the app password Nextcloud handed over): turn a message into a task
 * (Tasks: a VTODO in a task list) or an event (Calendar: a VEVENT), or share it to a Talk conversation. Each is offered only
 * when that Nextcloud has it. Tasks and events link back to the message.
 */
const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const cfgOf = (l: NcLink): DavCfg => ({ baseUrl: l.baseUrl, username: l.username, password: l.password });
const base = (l: NcLink) => l.baseUrl.replace(/\/$/, "");
const messageLink = (l: NcLink, id: string) => `${base(l)}/index.php/apps/ncmail/?message=${encodeURIComponent(id)}`;

async function ocs(l: NcLink, method: string, path: string, body?: unknown) {
  const r = await davFetch(l, `${base(l)}${path}${path.includes("?") ? "&" : "?"}format=json`, {
    method, headers: { "OCS-APIRequest": "true", accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j: any = await r.json().catch(() => null);
  if (!r.ok) throw httpError(502, j?.ocs?.meta?.message || `Nextcloud answered ${r.status}`);
  return j?.ocs?.data;
}

// ---- iCalendar ----
const esc = escText;
/** Lines longer than 75 octets are folded (RFC 5545). */
const fold = (line: string) => {
  const out: string[] = [];
  let cur = "";
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > 74) { out.push(cur); cur = " " + ch; } else cur += ch;
  }
  return [...out, cur].join("\r\n");
};
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const day = (s: string) => s.replace(/-/g, "");
function ics(kind: "VTODO" | "VEVENT", props: [string, string][]) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//NCMail//EN", `BEGIN:${kind}`, ...props.map(([k, v]) => `${k}:${v}`), `END:${kind}`, "END:VCALENDAR"];
  return lines.map(fold).join("\r\n") + "\r\n";
}
const describe = (m: any, link: string, note: string) =>
  [note.trim(), `From: ${m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr}`, `Date: ${new Date(m.date).toUTCString()}`, `Subject: ${m.subject || "(no subject)"}`, `Open in Mail: ${link}`]
    .filter(Boolean).join("\n");

/** Text from a mail cannot mention (and so notify) people in the conversation: "@" becomes the full-width "＠". */
export const noMentions = (s: string) => s.replace(/@/g, "\uFF20");

async function excerpt(id: string): Promise<string> {
  const { rows: [b] } = await pool.query("select text from message_bodies where message_id = $1", [id]);
  return String(b?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function integrationRoutes(app: FastifyInstance) {
  // What this Nextcloud offers (checked once per visit by the web app)
  app.get("/api/nextcloud/integrations", async (req) => {
    const l = await getNcLink(req.owner);
    if (!l) return { connected: false, tasks: false, calendar: false, talk: false };
    const [caps, events, tasks] = await Promise.all([
      ocs(l, "GET", "/ocs/v1.php/cloud/capabilities").catch(() => null),
      discoverCalendars(cfgOf(l), "VEVENT").catch(() => []),
      discoverCalendars(cfgOf(l), "VTODO").catch(() => []),
    ]);
    return { connected: true, tasks: tasks.length > 0, calendar: events.length > 0, talk: !!caps?.capabilities?.spreed };
  });

  app.get<{ Querystring: { kind?: string } }>("/api/nextcloud/calendars", async (req) => {
    const l = await requireNcLink(req.owner);
    const kind = req.query.kind === "tasks" ? "VTODO" : "VEVENT";
    return (await discoverCalendars(cfgOf(l), kind)).map((c) => ({ url: c.url, name: c.name }));
  });

  app.get("/api/nextcloud/talk/rooms", async (req) => {
    const l = await requireNcLink(req.owner);
    const rooms = (await ocs(l, "GET", "/ocs/v2.php/apps/spreed/api/v4/room")) ?? [];
    // conversations you can write to: not read-only, not the changelog bot
    return rooms.filter((r: any) => !r.readOnly && r.type !== 4 && r.token)
      .sort((a: any, b: any) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))
      .map((r: any) => ({ token: String(r.token), name: String(r.displayName ?? r.name ?? r.token) }));
  });

  // A calendar URL must be one of the user's own calendars (never an address from the request reaching elsewhere)
  async function ownCalendar(l: NcLink, url: string, kind: "VEVENT" | "VTODO") {
    const cal = (await discoverCalendars(cfgOf(l), kind)).find((c) => c.url === url);
    if (!cal) throw httpError(400, kind === "VTODO" ? "Choose one of your task lists." : "Choose one of your calendars.");
    return cal;
  }

  app.post<{ Params: { id: string } }>("/api/messages/:id/task", async (req) => {
    const b = z.object({ list: z.string().url(), title: z.string().trim().min(1).max(500), due: date.optional(), note: z.string().max(5000).default("") }).parse(req.body);
    const m = await loadMessage(req.params.id, req.owner);
    const l = await requireNcLink(req.owner);
    const cal = await ownCalendar(l, b.list, "VTODO");
    const uid = `${randomUUID()}@ncmail`;
    const link = messageLink(l, String(m.id));
    const text = ics("VTODO", [
      ["UID", uid], ["DTSTAMP", stamp(new Date())], ["CREATED", stamp(new Date())], ["SUMMARY", esc(b.title)],
      ["DESCRIPTION", esc(describe(m, link, b.note))], ["URL", link], ["STATUS", "NEEDS-ACTION"],
      ...(b.due ? [["DUE;VALUE=DATE", day(b.due)] as [string, string]] : []),
    ]);
    await putObject(cfgOf(l), `${cal.url.replace(/\/?$/, "/")}${encodeURIComponent(uid)}.ics`, text, true);
    return { ok: true, list: cal.name };
  });

  app.post<{ Params: { id: string } }>("/api/messages/:id/event", async (req) => {
    const b = z.object({
      calendar: z.string().url(), title: z.string().trim().min(1).max(500), note: z.string().max(5000).default(""), location: z.string().max(500).default(""),
      allDay: z.boolean().default(false), start: z.string().datetime({ offset: true }).or(date), end: z.string().datetime({ offset: true }).or(date),
    }).parse(req.body);
    const m = await loadMessage(req.params.id, req.owner);
    const l = await requireNcLink(req.owner);
    const cal = await ownCalendar(l, b.calendar, "VEVENT");
    const uid = `${randomUUID()}@ncmail`;
    const link = messageLink(l, String(m.id));
    let when: [string, string][];
    if (b.allDay) {
      const s = b.start.slice(0, 10), e = b.end.slice(0, 10);
      // DTEND of an all-day event is the day after the last day
      const after = new Date(`${e}T00:00:00Z`); after.setUTCDate(after.getUTCDate() + 1);
      if (e < s) throw httpError(400, "The event ends before it starts.");
      when = [["DTSTART;VALUE=DATE", day(s)], ["DTEND;VALUE=DATE", day(after.toISOString().slice(0, 10))]];
    } else {
      const s = new Date(b.start), e = new Date(b.end);
      if (isNaN(+s) || isNaN(+e) || e <= s) throw httpError(400, "The event ends before it starts.");
      when = [["DTSTART", stamp(s)], ["DTEND", stamp(e)]];
    }
    const text = ics("VEVENT", [
      ["UID", uid], ["DTSTAMP", stamp(new Date())], ...when, ["SUMMARY", esc(b.title)],
      ["DESCRIPTION", esc(describe(m, link, b.note))], ["URL", link], ...(b.location.trim() ? [["LOCATION", esc(b.location.trim())] as [string, string]] : []),
    ]);
    await putObject(cfgOf(l), `${cal.url.replace(/\/?$/, "/")}${encodeURIComponent(uid)}.ics`, text, true);
    return { ok: true, calendar: cal.name };
  });

  app.post<{ Params: { id: string } }>("/api/messages/:id/talk", async (req) => {
    const b = z.object({ token: z.string().regex(/^[a-z0-9]{4,64}$/i), note: z.string().max(2000).default(""), includeText: z.boolean().default(true) }).parse(req.body);
    const m = await loadMessage(req.params.id, req.owner);
    const l = await requireNcLink(req.owner);
    const rooms: any[] = (await ocs(l, "GET", "/ocs/v2.php/apps/spreed/api/v4/room")) ?? [];
    const room = rooms.find((r) => String(r.token) === b.token && !r.readOnly);
    if (!room) throw httpError(400, "Choose one of your conversations.");
    const from = m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr;
    const body = b.includeText ? await excerpt(String(m.id)) : "";
    // the user's own note may mention people; everything taken from the mail may not
    const message = [b.note.trim(), noMentions(`Mail from ${from}: ${m.subject || "(no subject)"}`), body ? `> ${noMentions(body)}${body.length >= 400 ? "…" : ""}` : ""]
      .filter(Boolean).join("\n\n").slice(0, 32000);
    await ocs(l, "POST", `/ocs/v2.php/apps/spreed/api/v1/chat/${encodeURIComponent(b.token)}`, { message });
    return { ok: true, conversation: String(room.displayName ?? b.token) };
  });
}
