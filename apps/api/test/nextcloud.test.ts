import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { IMAP_HOST, IMAP_PORT, SMTP_PORT, TEST_PASSWORD, user } from "./env.ts";
import { deliver, resetMailbox, waitFor } from "./helpers.ts";
import { startApi } from "./server.ts";

/** Contacts and Files through a mock Nextcloud (login flow, CardDAV, WebDAV). */
const U = user(35);
const NC = { user: "tester", app: "app-password-1" };
const files = new Map<string, Buffer>([["/Documents/report.pdf", Buffer.from("PDF-DATA")], ["/Documents/notes.txt", Buffer.from("notes")], ["/Readme.md", Buffer.from("hi")]]);
const folders = new Set(["/", "/Documents", "/Archive"]);
const cards = new Map<string, string>([
  ["/remote.php/dav/addressbooks/users/tester/contacts/anna.vcf", "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Anna Nextcloud\r\nORG:Acme;\r\nEMAIL;TYPE=WORK:Anna.NC@example.org\r\nEND:VCARD\r\n"],
  ["/remote.php/dav/addressbooks/users/tester/contacts/bo.vcf", "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Bo Builder\r\nEMAIL:bo@example.org\r\nEMAIL:bo2@example.org\r\nEND:VCARD\r\n"],
]);
let nc: Server, api: { url: string; stop: () => Promise<void> }, polls = 0;
let acctId = "", msgId = "";

const call = async (path: string, o: { method?: string; body?: unknown } = {}) => {
  const r = await fetch(`${api.url}/api${path}`, { method: o.method ?? (o.body !== undefined ? "POST" : "GET"), headers: o.body !== undefined ? { "content-type": "application/json" } : undefined, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  const t = await r.text();
  return { status: r.status, data: t ? JSON.parse(t) : undefined };
};
const authOk = (h?: string) => h === `Basic ${Buffer.from(`${NC.user}:${NC.app}`).toString("base64")}`;
const multistatus = (inner: string) => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">${inner}</d:multistatus>`;

beforeAll(async () => {
  nc = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks); const url = decodeURIComponent(req.url!);
      const send = (code: number, b: string | Buffer = "", h: Record<string, string> = {}) => res.writeHead(code, h).end(b);
      if (req.method === "POST" && url === "/index.php/login/v2") return send(200, JSON.stringify({ poll: { token: "tok", endpoint: `http://${req.headers.host}/index.php/login/v2/poll` }, login: `http://${req.headers.host}/login/v2/flow/tok` }), { "content-type": "application/json" });
      if (req.method === "POST" && url === "/index.php/login/v2/poll") return ++polls < 2 ? send(404) : send(200, JSON.stringify({ server: "x", loginName: NC.user, appPassword: NC.app }), { "content-type": "application/json" });
      if (url.startsWith("/ocs/v2.php/cloud/user")) return authOk(req.headers.authorization) ? send(200, JSON.stringify({ ocs: { data: { id: NC.user } } })) : send(401);
      if (!authOk(req.headers.authorization)) return send(401);
      if (url === "/remote.php/dav/addressbooks/users/tester/" && req.method === "PROPFIND")
        return send(207, multistatus(`<d:response><d:href>/remote.php/dav/addressbooks/users/tester/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response><d:response><d:href>/remote.php/dav/addressbooks/users/tester/contacts/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><card:addressbook/></d:resourcetype></d:prop></d:propstat></d:response>`));
      if (url === "/remote.php/dav/addressbooks/users/tester/contacts/" && req.method === "REPORT")
        return send(207, multistatus([...cards].map(([h, v]) => `<d:response><d:href>${h}</d:href><d:propstat><d:prop><card:address-data>${v.replace(/&/g, "&amp;").replace(/\r\n/g, "&#13;\n")}</card:address-data></d:prop></d:propstat></d:response>`).join("")));
      if (url.startsWith("/remote.php/dav/addressbooks/users/tester/contacts/") && req.method === "PUT") { if (req.headers["if-none-match"] === "*" && cards.has(url)) return send(412); cards.set(url, body.toString()); return send(201); }
      const m = url.match(/^\/remote\.php\/dav\/files\/tester(\/.*)?$/);
      if (m) {
        const p = (m[1] ?? "/").replace(/\/+$/, "") || "/";
        if (req.method === "PROPFIND") {
          if (!folders.has(p)) return send(404);
          const entry = (href: string, dir: boolean, size = 0) => `<d:response><d:href>/remote.php/dav/files/tester${href}</d:href><d:propstat><d:prop><d:resourcetype>${dir ? "<d:collection/>" : ""}</d:resourcetype><d:getcontentlength>${size}</d:getcontentlength><d:getlastmodified>Mon, 01 Dec 2026 10:00:00 GMT</d:getlastmodified><d:getcontenttype>${dir ? "httpd/unix-directory" : "text/plain"}</d:getcontenttype></d:prop></d:propstat></d:response>`;
          const prefix = p === "/" ? "/" : p + "/";
          const kids = [...folders].filter((f) => f !== p && f.startsWith(prefix) && !f.slice(prefix.length).includes("/")).map((f) => entry(f, true));
          const fl = [...files].filter(([f]) => f.startsWith(prefix) && !f.slice(prefix.length).includes("/")).map(([f, v]) => entry(f, false, v.length));
          return send(207, multistatus(entry(p === "/" ? "/" : p, true) + kids.join("") + fl.join("")));
        }
        if (req.method === "GET") return files.has(p) ? send(200, files.get(p)!, { "content-type": "application/pdf" }) : send(404);
        if (req.method === "PUT") { if (!folders.has(p.slice(0, p.lastIndexOf("/")) || "/")) return send(409); if (req.headers["if-none-match"] === "*" && files.has(p)) return send(412); files.set(p, body); return send(201); }
      }
      send(404);
    });
  });
  await new Promise<void>((r) => nc.listen(0, "127.0.0.1", r));
  api = await startApi(4113, { NEXTCLOUD_URL: `http://127.0.0.1:${(nc.address() as any).port}` }, "ncmail_nc_test");
  await resetMailbox(U);
  await deliver(U, "INBOX", { subject: "With attachment", text: "see attached", from: "Carla Sender <carla@example.org>", attachments: [{ filename: "report.pdf", content: "ATTACHED-PDF", contentType: "application/pdf" }, { filename: "data.csv", content: "a,b", contentType: "text/csv" }] });
  acctId = (await call("/accounts", { body: { name: "NC test", email: U, imap: { host: IMAP_HOST, port: IMAP_PORT, security: "none", username: U, password: TEST_PASSWORD }, smtp: { host: IMAP_HOST, port: SMTP_PORT, security: "none", username: U, password: TEST_PASSWORD } } })).data.id;
  await call(`/accounts/${acctId}/sync`, { method: "POST" });
  const inbox = await waitFor(async () => (await call(`/accounts/${acctId}/folders`)).data?.find((f: any) => f.specialUse === "\\Inbox")?.id, { what: "folders" });
  await call(`/folders/${inbox}/sync`, { method: "POST" });
  msgId = await waitFor(async () => (await call(`/folders/${inbox}/messages`)).data.items[0]?.id, { what: "the message" });
}, 90_000);
afterAll(async () => { await call(`/accounts/${acctId}`, { method: "DELETE" }).catch(() => {}); await api?.stop(); nc?.close(); });

describe("connecting to Nextcloud", () => {
  it("is not connected at first, and refuses to browse", async () => {
    expect((await call("/nextcloud")).data).toMatchObject({ available: true, connected: false });
    expect((await call("/nextcloud/files")).status).toBe(400);
  });
  it("connects with the login flow: waits for approval, then keeps an app password", async () => {
    const start = (await call("/nextcloud/connect", { method: "POST" })).data;
    expect(start.loginUrl).toContain("/login/v2/flow/");
    expect((await call("/nextcloud/connect/poll", { body: { id: start.id } })).data.connected).toBe(false);
    const done = (await call("/nextcloud/connect/poll", { body: { id: start.id } })).data;
    expect(done).toMatchObject({ connected: true, user: "tester" });
    const st = (await call("/nextcloud")).data;
    expect(st).toMatchObject({ connected: true, user: "tester" });
    expect(JSON.stringify(st)).not.toContain(NC.app);
  });
  it("rejects a wrong password when connecting by password, and an unknown sign-in id", async () => {
    expect((await call("/nextcloud/connect-password", { body: { username: "tester", password: "bad" } })).status).toBe(400);
    expect((await call("/nextcloud/connect/poll", { body: { id: "nope" } })).status).toBe(404);
  });
});

describe("Nextcloud Contacts", () => {
  it("suggests contacts from Nextcloud while typing, ahead of mail history", async () => {
    expect((await call("/nextcloud/contacts/sync", { method: "POST" })).data.contacts).toBe(2);
    const r = (await call("/contacts?q=anna")).data;
    expect(r[0]).toMatchObject({ email: "anna.nc@example.org", name: "Anna Nextcloud", source: "nextcloud" });
    expect((await call("/contacts?q=builder")).data.map((c: any) => c.email).sort()).toEqual(["bo2@example.org", "bo@example.org"]);
    expect((await call("/contacts?q=acme")).data[0].email).toBe("anna.nc@example.org"); // matches the organisation too
  });
  it("knows who is already a contact, and saves a new one without duplicating", async () => {
    expect((await call("/nextcloud/contacts/known?email=bo@example.org")).data.known).toBe(true);
    expect((await call("/nextcloud/contacts/known?email=carla@example.org")).data.known).toBe(false);
    expect((await call("/nextcloud/contacts", { body: { name: "Carla Sender", email: "carla@example.org" } })).data.added).toBe(true);
    expect([...cards.values()].some((v) => v.includes("FN:Carla Sender") && v.includes("EMAIL;TYPE=INTERNET:carla@example.org"))).toBe(true);
    expect((await call("/nextcloud/contacts/known?email=carla@example.org")).data.known).toBe(true);
    expect((await call("/nextcloud/contacts", { body: { name: "Carla", email: "CARLA@example.org" } })).data.added).toBe(false);
    expect((await call("/contacts?q=carla")).data[0].source).toBe("nextcloud");
  });
});

describe("Nextcloud Files", () => {
  it("browses folders, folders first", async () => {
    const root = (await call("/nextcloud/files")).data;
    expect(root.items.map((i: any) => `${i.dir ? "d" : "f"}:${i.name}`)).toEqual(["d:Archive", "d:Documents", "f:Readme.md"]);
    const docs = (await call("/nextcloud/files?path=/Documents")).data;
    expect(docs.items.map((i: any) => i.path)).toEqual(["/Documents/notes.txt", "/Documents/report.pdf"]);
    expect((await call("/nextcloud/files?path=/Nope")).status).toBe(404);
  });
  it("refuses paths that climb out of the user's files", async () => {
    expect((await call("/nextcloud/files?path=/Documents/../../x")).status).toBe(400);
  });
  it("brings files into a message as ordinary uploads", async () => {
    const r = (await call("/nextcloud/files/attach", { body: { paths: ["/Documents/report.pdf", "/Readme.md"] } })).data;
    expect(r.map((u: any) => u.filename)).toEqual(["report.pdf", "Readme.md"]);
    const dl = await fetch(`${api.url}/api/uploads/${r[0].id}`);
    expect(await dl.text()).toBe("PDF-DATA");
    expect((await call("/nextcloud/files/attach", { body: { paths: ["/missing.txt"] } })).status).toBe(404);
  });
  it("saves an attachment to a folder, and never overwrites", async () => {
    const m = (await call(`/messages/${msgId}`)).data;
    expect(m.attachments.map((a: any) => a.filename)).toEqual(["report.pdf", "data.csv"]);
    const r1 = (await call(`/messages/${msgId}/attachments/0/save-to-nextcloud`, { body: { folder: "/Archive" } })).data;
    expect(r1.saved).toEqual(["/Archive/report.pdf"]);
    expect(files.get("/Archive/report.pdf")!.toString()).toBe("ATTACHED-PDF");
    const r2 = (await call(`/messages/${msgId}/attachments/0/save-to-nextcloud`, { body: { folder: "/Archive" } })).data;
    expect(r2.saved).toEqual(["/Archive/report (1).pdf"]);
  });
  it("saves all attachments at once", async () => {
    const r = (await call(`/messages/${msgId}/attachments/all/save-to-nextcloud`, { body: { folder: "/Documents" } })).data;
    expect(r.saved).toEqual(["/Documents/report (1).pdf", "/Documents/data.csv"]);
  });
  it("reports a folder that does not exist", async () => {
    expect((await call(`/messages/${msgId}/attachments/1/save-to-nextcloud`, { body: { folder: "/Gone" } })).status).toBe(404);
  });
});

describe("disconnecting", () => {
  it("forgets the connection and the cached contacts", async () => {
    expect((await call("/nextcloud", { method: "DELETE" })).status).toBe(204);
    expect((await call("/nextcloud")).data.connected).toBe(false);
    expect((await call("/contacts?q=anna")).data.every((c: any) => c.source !== "nextcloud")).toBe(true);
    expect((await call("/nextcloud/files")).status).toBe(400);
  });
});
