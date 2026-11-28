import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { IMAP_HOST, IMAP_PORT, SMTP_PORT, TEST_PASSWORD, user } from "./env.ts";
import { deliver, resetMailbox, waitFor } from "./helpers.ts";
import { startApi } from "./server.ts";

/** Tasks, Calendar and Talk through a mock Nextcloud: what is offered, and what lands there. */
const U = user(21);
const NC = { user: "tester", app: "app-password-2" };
let nc: Server, api: { url: string; stop: () => Promise<void> };
let acctId = "", msgId = "", ncUrl = "";
let talk = true;
const objects = new Map<string, string>();
const chats: { token: string; message: string }[] = [];

const call = async (path: string, o: { method?: string; body?: unknown } = {}) => {
  const r = await fetch(`${api.url}/api${path}`, { method: o.method ?? (o.body !== undefined ? "POST" : "GET"), headers: o.body !== undefined ? { "content-type": "application/json" } : undefined, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  const t = await r.text();
  return { status: r.status, data: t ? JSON.parse(t) : undefined };
};
const authOk = (h?: string) => h === `Basic ${Buffer.from(`${NC.user}:${NC.app}`).toString("base64")}`;
const cal = (href: string, name: string, comps: string[]) =>
  `<d:response><d:href>${href}</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status><d:prop><d:displayname>${name}</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set>${comps.map((c) => `<c:comp name="${c}"/>`).join("")}</c:supported-calendar-component-set></d:prop></d:propstat></d:response>`;
const json = (data: unknown) => JSON.stringify({ ocs: { meta: { status: "ok", statuscode: 200 }, data } });

beforeAll(async () => {
  nc = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString(); const url = decodeURIComponent(req.url!.split("?")[0]!);
      const send = (code: number, b = "", h: Record<string, string> = { "content-type": "application/json" }) => res.writeHead(code, h).end(b);
      if (!authOk(req.headers.authorization)) return send(401);
      if (url === "/ocs/v2.php/cloud/user") return send(200, json({ id: NC.user }));
      if (url === "/ocs/v1.php/cloud/capabilities") return send(200, json({ capabilities: { core: {}, ...(talk ? { spreed: { features: ["chat-v2"] } } : {}) } }));
      if (url === "/remote.php/dav/calendars/tester/" && req.method === "PROPFIND")
        return send(207, `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/remote.php/dav/calendars/tester/</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>${cal("/remote.php/dav/calendars/tester/personal/", "Personal", ["VEVENT"])}${cal("/remote.php/dav/calendars/tester/tasks/", "Tasks", ["VTODO"])}</d:multistatus>`, { "content-type": "application/xml" });
      if (url.startsWith("/remote.php/dav/calendars/tester/") && req.method === "PUT") { objects.set(url, body); return send(201, ""); }
      if (url === "/ocs/v2.php/apps/spreed/api/v4/room") return send(200, json([
        { token: "abc123", displayName: "Team", type: 2, readOnly: 0, lastActivity: 2 },
        { token: "ro999", displayName: "Announcements", type: 2, readOnly: 1, lastActivity: 3 },
        { token: "bot777", displayName: "Talk updates", type: 4, readOnly: 0, lastActivity: 1 },
      ]));
      const chat = url.match(/^\/ocs\/v2\.php\/apps\/spreed\/api\/v1\/chat\/(\w+)$/);
      if (chat && req.method === "POST") { chats.push({ token: chat[1]!, message: JSON.parse(body).message }); return send(201, json({ id: 1 })); }
      send(404, "");
    });
  });
  await new Promise<void>((r) => nc.listen(0, "127.0.0.1", r));
  ncUrl = `http://127.0.0.1:${(nc.address() as any).port}`;
  api = await startApi(4146, { NEXTCLOUD_URL: ncUrl }, "ncmail_integrations_test");
  await call("/nextcloud", { method: "DELETE" }); // a connection saved by an earlier run
  await resetMailbox(U);
  await deliver(U, "INBOX", { subject: "Budget review", text: "Please send the figures by Friday.", from: "Dana Director <dana@example.org>" });
  acctId = (await call("/accounts", { body: { name: "Integrations", email: U, imap: { host: IMAP_HOST, port: IMAP_PORT, security: "none", username: U, password: TEST_PASSWORD }, smtp: { host: IMAP_HOST, port: SMTP_PORT, security: "none", username: U, password: TEST_PASSWORD } } })).data.id;
  await call(`/accounts/${acctId}/sync`, { method: "POST" });
  const inbox = await waitFor(async () => (await call(`/accounts/${acctId}/folders`)).data?.find((f: any) => f.specialUse === "\\Inbox")?.id, { what: "folders" });
  await call(`/folders/${inbox}/sync`, { method: "POST" });
  msgId = await waitFor(async () => (await call(`/folders/${inbox}/messages`)).data.items[0]?.id, { what: "the message" });
  await call(`/messages/${msgId}`); // reads (and caches) the text for Talk's excerpt
}, 90_000);
afterAll(async () => { await call(`/accounts/${acctId}`, { method: "DELETE" }).catch(() => {}); await api?.stop(); nc?.close(); });

describe("Nextcloud apps", () => {
  it("offers nothing until Nextcloud is connected", async () => {
    expect((await call("/nextcloud/integrations")).data).toEqual({ connected: false, tasks: false, calendar: false, talk: false });
    expect((await call(`/messages/${msgId}/task`, { body: { list: `${ncUrl}/remote.php/dav/calendars/tester/tasks/`, title: "x" } })).status).toBe(400);
  });

  it("offers what that Nextcloud has: task lists, calendars, Talk", async () => {
    expect((await call("/nextcloud/connect-password", { body: { username: NC.user, password: NC.app } })).status).toBe(200);
    expect((await call("/nextcloud/integrations")).data).toEqual({ connected: true, tasks: true, calendar: true, talk: true });
    expect((await call("/nextcloud/calendars?kind=tasks")).data.map((c: any) => c.name)).toEqual(["Tasks"]);
    expect((await call("/nextcloud/calendars?kind=events")).data.map((c: any) => c.name)).toEqual(["Personal"]);
    // only conversations you can write to (not read-only, not the bot)
    expect((await call("/nextcloud/talk/rooms")).data).toEqual([{ token: "abc123", name: "Team" }]);
    talk = false;
    expect((await call("/nextcloud/integrations")).data.talk).toBe(false);
    talk = true;
  });

  it("turns a message into a task with a link back to it", async () => {
    const list = (await call("/nextcloud/calendars?kind=tasks")).data[0].url;
    const r = await call(`/messages/${msgId}/task`, { body: { list, title: "Send the figures", due: "2026-12-04", note: "Ask Bo first" } });
    expect(r.data).toEqual({ ok: true, list: "Tasks" });
    const [href, ics] = [...objects].find(([h]) => h.startsWith("/remote.php/dav/calendars/tester/tasks/"))!;
    expect(href).toMatch(/\.ics$/);
    const flat = ics.replace(/\r\n /g, "");
    expect(flat).toContain("BEGIN:VTODO");
    expect(flat).toContain("SUMMARY:Send the figures");
    expect(flat).toContain("DUE;VALUE=DATE:20261204");
    expect(flat).toMatch(/DESCRIPTION:Ask Bo first\\nFrom: Dana Director <dana@example.org>\\n/);
    expect(flat).toContain(`URL:${ncUrl}/index.php/apps/ncmail/?message=${msgId}`);
    expect(ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 75)).toBe(true); // folded
  });

  it("makes an event, timed or all day", async () => {
    const calendar = (await call("/nextcloud/calendars?kind=events")).data[0].url;
    expect((await call(`/messages/${msgId}/event`, { body: { calendar, title: "Budget meeting", start: "2026-12-03T09:00:00Z", end: "2026-12-03T10:00:00Z", location: "Room 4" } })).data).toEqual({ ok: true, calendar: "Personal" });
    expect((await call(`/messages/${msgId}/event`, { body: { calendar, title: "Budget day", allDay: true, start: "2026-12-05", end: "2026-12-05" } })).status).toBe(200);
    const events = [...objects].filter(([h]) => h.startsWith("/remote.php/dav/calendars/tester/personal/")).map(([, v]) => v.replace(/\r\n /g, ""));
    expect(events.find((e) => e.includes("SUMMARY:Budget meeting"))).toMatch(/DTSTART:20261203T090000Z[\s\S]*DTEND:20261203T100000Z[\s\S]*LOCATION:Room 4/);
    expect(events.find((e) => e.includes("SUMMARY:Budget day"))).toMatch(/DTSTART;VALUE=DATE:20261205[\s\S]*DTEND;VALUE=DATE:20261206/);
    expect((await call(`/messages/${msgId}/event`, { body: { calendar, title: "Backwards", start: "2026-12-03T10:00:00Z", end: "2026-12-03T09:00:00Z" } })).status).toBe(400);
  });

  it("writes only into the user's own calendars", async () => {
    expect((await call(`/messages/${msgId}/task`, { body: { list: "http://evil.example/remote.php/dav/calendars/x/", title: "x" } })).status).toBe(400);
    expect((await call(`/messages/${msgId}/event`, { body: { calendar: `${ncUrl}/remote.php/dav/calendars/tester/tasks/`, title: "x", start: "2026-12-03T09:00:00Z", end: "2026-12-03T10:00:00Z" } })).status).toBe(400);
  });

  it("shares a message to a Talk conversation", async () => {
    expect((await call(`/messages/${msgId}/talk`, { body: { token: "abc123", note: "Can someone take this?" } })).data).toEqual({ ok: true, conversation: "Team" });
    expect(chats.at(-1)).toEqual({ token: "abc123", message: "Can someone take this?\n\nMail from Dana Director <dana\uFF20example.org>: Budget review\n\n> Please send the figures by Friday." });
    await call(`/messages/${msgId}/talk`, { body: { token: "abc123", includeText: false } });
    expect(chats.at(-1)!.message).toBe("Mail from Dana Director <dana\uFF20example.org>: Budget review");
    // the user's own note keeps its mentions
    await call(`/messages/${msgId}/talk`, { body: { token: "abc123", note: "@bo please", includeText: false } });
    expect(chats.at(-1)!.message).toMatch(/^@bo please\n\n/);
  });

  it("refuses read-only conversations and ones you are not in", async () => {
    expect((await call(`/messages/${msgId}/talk`, { body: { token: "ro999" } })).status).toBe(400);
    expect((await call(`/messages/${msgId}/talk`, { body: { token: "nothere" } })).status).toBe(400);
  });
});
