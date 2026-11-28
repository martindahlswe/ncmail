import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { user } from "./env.ts";
import { addAccount, api, apiRaw, imap, resetMailbox, syncFolder, waitFor, sleep, type Acct } from "./helpers.ts";

const U = user(37);
const NC_USER = "tester";
let acct: Acct;
let server: Server;
let base = "";
const store = new Map<string, string>(); // calendar object path -> ics
let puts = 0;
const CAL = `/remote.php/dav/calendars/${NC_USER}/personal/`;

const auth = (h?: string) => h === `Basic ${Buffer.from(`${NC_USER}:good`).toString("base64")}`;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      if (!auth(req.headers.authorization)) { res.writeHead(401).end(); return; }
      const path = req.url!;
      if (req.method === "PROPFIND") {
        res.writeHead(207, { "content-type": "application/xml" }).end(`<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
 <d:response><d:href>/remote.php/dav/calendars/${NC_USER}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
 <d:response><d:href>${CAL}</d:href><d:propstat><d:prop><d:displayname>Personal</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
   <c:supported-calendar-component-set><c:comp name="VEVENT"/><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
 <d:response><d:href>/remote.php/dav/calendars/${NC_USER}/tasks/</d:href><d:propstat><d:prop><d:displayname>Tasks</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
   <c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
 <d:response><d:href>/remote.php/dav/calendars/${NC_USER}/inbox/</d:href><d:propstat><d:prop><d:displayname>Inbox</d:displayname><d:resourcetype><d:collection/><c:schedule-inbox/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`);
        return;
      }
      if (req.method === "GET") { const o = store.get(path); o ? res.writeHead(200, { "content-type": "text/calendar" }).end(o) : res.writeHead(404).end(); return; }
      if (req.method === "PUT") {
        if (req.headers["if-none-match"] === "*" && store.has(path)) { res.writeHead(412).end(); return; }
        puts++; store.set(path, body); res.writeHead(201).end(); return;
      }
      res.writeHead(405).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  await resetMailbox(U);
  acct = await addAccount(U);
});
afterAll(async () => { server?.close(); if (acct) await api(`/accounts/${acct.id}`, { method: "DELETE" }); });

const ics = (o: { uid: string; method?: string; seq?: number; summary?: string; organizer?: string; status?: string }) => [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN", `METHOD:${o.method ?? "REQUEST"}`, "BEGIN:VEVENT", `UID:${o.uid}`, `SEQUENCE:${o.seq ?? 0}`,
  "DTSTAMP:20261120T090000Z", "DTSTART:20261201T100000Z", "DTEND:20261201T110000Z", `SUMMARY:${o.summary ?? "Planning meeting"}`, "LOCATION:Room 4",
  `ORGANIZER;CN=Olivia Organizer:mailto:${o.organizer ?? "olivia@example.org"}`, `ATTENDEE;CN=Me;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${U}`,
  ...(o.status ? [`STATUS:${o.status}`] : []), "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");

async function receive(subject: string, icsText: string, from = "Olivia <olivia@example.org>") {
  const raw = await new MailComposer({ from, to: U, subject, text: "You are invited", icalEvent: { method: icsText.match(/METHOD:(\w+)/)![1]!, content: icsText } }).compile().build();
  await imap(U, (c) => c.append("INBOX", raw));
  await syncFolder((await acct.folder("INBOX")).id);
}
const objectFor = (uid: string) => store.get(`${CAL}${uid}.ics`);
const body = (baseUrl = base, extra: Record<string, unknown> = {}) => ({ baseUrl, username: NC_USER, password: "good", ...extra });

describe("calendar connection", () => {
  it("rejects a wrong password with a helpful message", async () => {
    const r = await apiRaw(`/accounts/${acct.id}/calendar/discover`, { body: body(base, { password: "bad" }) });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/app password/);
  });

  it("lists only calendars that can hold events", async () => {
    const r = await api<any>(`/accounts/${acct.id}/calendar/discover`, { body: body() });
    expect(r.calendars.map((c: any) => c.name)).toEqual(["Personal"]);
  });

  it("explains an unreachable server and a bad address", async () => {
    expect((await apiRaw(`/accounts/${acct.id}/calendar/discover`, { body: body("http://127.0.0.1:1") })).data.error).toMatch(/Could not reach/);
    expect((await apiRaw(`/accounts/${acct.id}/calendar/discover`, { body: body("not a url") })).status).toBe(400);
  });

  it("saves the link without ever returning the password", async () => {
    const calendarUrl = (await api<any>(`/accounts/${acct.id}/calendar/discover`, { body: body() })).calendars[0].url;
    await api(`/accounts/${acct.id}/calendar`, { method: "PUT", body: body(base, { calendarUrl, calendarName: "Personal", autoImport: true }) });
    const c = await api<any>(`/accounts/${acct.id}/calendar`);
    expect(c).toMatchObject({ linked: true, username: NC_USER, calendarName: "Personal", autoImport: true });
    expect(JSON.stringify(c)).not.toContain("good");
  });
});

describe("answers given in the calendar", () => {
  const find = async (box: string, subject: string) => (await api<any>(`/folders/${(await acct.folder(box)).id}/messages?limit=100`)).items.find((i: any) => i.subject === subject);

  it("marks the invitation read and shows your answer once you accept", async () => {
    await receive("Invite: Answer me", ics({ uid: "evt-ans@test", summary: "Answer me" }));
    const o = await waitFor(async () => objectFor("evt-ans%40test"), { what: "the event" });
    const item = await waitFor(async () => find("INBOX", "Invite: Answer me"), { what: "the message" });
    expect(item.seen).toBe(false);
    store.set(`${CAL}evt-ans%40test.ics`, o.replace("PARTSTAT=NEEDS-ACTION", "PARTSTAT=ACCEPTED")); // accepted in the calendar app
    await api(`/accounts/${acct.id}/calendar/sync`, { method: "POST" });
    expect((await find("INBOX", "Invite: Answer me")).seen).toBe(true);
    const inv = await api<any>(`/messages/${item.id}/invite`);
    expect(inv.answer).toBe("accepted");
  });

  it("files the invitation in Archive when you decline", async () => {
    await receive("Invite: Decline me", ics({ uid: "evt-dec@test", summary: "Decline me" }));
    const o = await waitFor(async () => objectFor("evt-dec%40test"), { what: "the event" });
    store.set(`${CAL}evt-dec%40test.ics`, o.replace("PARTSTAT=NEEDS-ACTION", "PARTSTAT=DECLINED"));
    await api(`/accounts/${acct.id}/calendar/sync`, { method: "POST" });
    await waitFor(async () => !(await find("INBOX", "Invite: Decline me")), { what: "the invitation to leave the inbox" });
    await syncFolder((await acct.folder("Archive")).id);
    expect(await find("Archive", "Invite: Decline me")).toBeTruthy();
  });

  it("notices an event you removed from the calendar", async () => {
    await receive("Invite: Remove me", ics({ uid: "evt-rm@test", summary: "Remove me" }));
    await waitFor(async () => objectFor("evt-rm%40test"), { what: "the event" });
    const item = await waitFor(async () => find("INBOX", "Invite: Remove me"), { what: "the message" });
    store.delete(`${CAL}evt-rm%40test.ics`);
    expect((await api<any>(`/messages/${item.id}/invite`)).answer).toBe("removed");
  });
});

describe("invitations by mail", () => {
  it("adds a new invitation to the calendar as tentative, with the answer left open", async () => {
    await receive("Invite: Planning", ics({ uid: "evt-1@test" }));
    const o = await waitFor(async () => objectFor("evt-1%40test"), { what: "the event in the calendar" });
    expect(o).toContain("STATUS:TENTATIVE");
    expect(o).not.toContain("METHOD:");
    expect(o).toMatch(new RegExp(`ATTENDEE;CN=Me;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${U}`));
    expect(o).toContain("SUMMARY:Planning meeting");
    expect(o).toMatch(/LAST-MODIFIED:\d{8}T\d{6}Z/); // Nextcloud only sends your reply when the stored event has one
  });

  it("shows the invitation in the reader with its calendar state", async () => {
    const inbox = await acct.folder("INBOX");
    const item = (await api<any>(`/folders/${inbox.id}/messages?limit=50`)).items.find((i: any) => i.subject === "Invite: Planning");
    const m = await api<any>(`/messages/${item.id}`);
    expect(m.hasInvite).toBe(true);
    const inv = await api<any>(`/messages/${item.id}/invite`);
    expect(inv).toMatchObject({ summary: "Planning meeting", location: "Room 4", method: "REQUEST", linked: true, imported: "tentative", organizer: { email: "olivia@example.org" } });
  });

  it("does not touch the entry again for the same version", async () => {
    const before = puts;
    await receive("Invite again", ics({ uid: "evt-1@test" }));
    await sleep(1500);
    expect(puts).toBe(before);
  });

  it("keeps the answer you gave when the organizer sends an update", async () => {
    const path = `${CAL}evt-1%40test.ics`;
    store.set(path, store.get(path)!.replace("PARTSTAT=NEEDS-ACTION", "PARTSTAT=ACCEPTED").replace("STATUS:TENTATIVE", "STATUS:CONFIRMED")); // you accepted in the calendar app
    await receive("Updated: Planning", ics({ uid: "evt-1@test", seq: 1, summary: "Planning meeting (moved)" }));
    const o = await waitFor(async () => (objectFor("evt-1%40test")?.includes("(moved)") ? objectFor("evt-1%40test") : undefined), { what: "the updated event" });
    expect(o).toContain("PARTSTAT=ACCEPTED");
    expect(o).toContain("STATUS:CONFIRMED");
  });

  it("applies changes to an event in the calendar only when its organizer sends them", async () => {
    const path = `${CAL}evt-1%40test.ics`;
    const before = store.get(path)!, putsBefore = puts;
    const other = "Mallory <mallory@example.net>";
    await receive("Updated: Planning", ics({ uid: "evt-1@test", seq: 9, summary: "Planning meeting (elsewhere)" }), other); // same ORGANIZER, other sender
    await receive("Cancelled: Planning", ics({ uid: "evt-1@test", seq: 9, method: "CANCEL" }), other);
    await receive("Updated: Planning", ics({ uid: "evt-1@test", seq: 9, summary: "Planning meeting (new organizer)", organizer: "mallory@example.net" }), other);
    await sleep(2000);
    expect(store.get(path)).toBe(before);
    expect(puts).toBe(putsBefore);
    // the stored version was not raised, so the organizer's next update (sequence 2) still applies; the sender is matched case-insensitively
    await receive("Updated again: Planning", ics({ uid: "evt-1@test", seq: 2, summary: "Planning meeting (moved again)" }), "Olivia <Olivia@Example.org>");
    const o = await waitFor(async () => (objectFor("evt-1%40test")?.includes("(moved again)") ? objectFor("evt-1%40test") : undefined), { what: "the organizer's update" });
    expect(o).toContain("PARTSTAT=ACCEPTED");
  });

  it("leaves a cancellation from someone else to the button", async () => {
    await receive("Invite: Retro", ics({ uid: "evt-6@test", summary: "Retro" }));
    const path = `${CAL}evt-6%40test.ics`;
    await waitFor(async () => objectFor("evt-6%40test"), { what: "the event" });
    const before = store.get(path)!;
    await receive("Cancelled: Retro", ics({ uid: "evt-6@test", seq: 1, method: "CANCEL" }), "Mallory <mallory@example.net>");
    await sleep(1500);
    expect(store.get(path)).toBe(before);
    const inbox = await acct.folder("INBOX");
    const item = (await api<any>(`/folders/${inbox.id}/messages?limit=100`)).items.find((i: any) => i.subject === "Cancelled: Retro");
    const r = await api<any>(`/messages/${item.id}/invite/add`, { method: "POST" });
    expect(r.results[0].action).toBe("cancelled");
    expect(store.get(path)).toContain("STATUS:CANCELLED");
  });

  it("marks the entry cancelled when the organizer cancels", async () => {
    await receive("Cancelled: Planning", ics({ uid: "evt-1@test", seq: 2, method: "CANCEL" }));
    const o = await waitFor(async () => (objectFor("evt-1%40test")?.includes("STATUS:CANCELLED") ? objectFor("evt-1%40test") : undefined), { what: "the cancellation" });
    expect(o).not.toContain("STATUS:CONFIRMED");
  });

  it("does not bring back an event you deleted, but the button does", async () => {
    await receive("Invite: Offsite", ics({ uid: "evt-2@test", summary: "Offsite" }));
    await waitFor(async () => objectFor("evt-2%40test"), { what: "the event" });
    store.delete(`${CAL}evt-2%40test.ics`); // deleted in the calendar app
    await receive("Updated: Offsite", ics({ uid: "evt-2@test", seq: 1, summary: "Offsite v2" }));
    await sleep(1500);
    expect(objectFor("evt-2%40test")).toBeUndefined();
    const inbox = await acct.folder("INBOX");
    const item = (await api<any>(`/folders/${inbox.id}/messages?limit=50`)).items.find((i: any) => i.subject === "Updated: Offsite");
    const r = await api<any>(`/messages/${item.id}/invite/add`, { method: "POST" });
    expect(r.results[0].action).toBe("added");
    expect(objectFor("evt-2%40test")).toContain("Offsite v2");
  });

  it("ignores invitations you organized yourself and replies from others", async () => {
    const before = puts;
    await receive("My own meeting", ics({ uid: "evt-3@test", organizer: U }));
    await receive("Re: reply", ics({ uid: "evt-4@test", method: "REPLY" }));
    await sleep(1500);
    expect(puts).toBe(before);
  });

  it("does nothing when automatic adding is switched off", async () => {
    const calendarUrl = (await api<any>(`/accounts/${acct.id}/calendar`)).calendarUrl;
    await api(`/accounts/${acct.id}/calendar`, { method: "PUT", body: body(base, { password: "", calendarUrl, calendarName: "Personal", autoImport: false }) });
    // the switch is saved before the invitation arrives (a failure here, not below, means saving it failed)
    expect((await api<any>(`/accounts/${acct.id}/calendar`)).autoImport).toBe(false);
    const before = puts;
    await receive("Invite: Manual", ics({ uid: "evt-5@test" }));
    await sleep(1500);
    expect(objectFor("evt-5%40test")).toBeUndefined();
    expect(puts).toBe(before); // nothing was written to the calendar at all
  });

  it("forgets the link when asked", async () => {
    await api(`/accounts/${acct.id}/calendar`, { method: "DELETE" });
    expect((await api<any>(`/accounts/${acct.id}/calendar`)).linked).toBe(false);
  });
});
