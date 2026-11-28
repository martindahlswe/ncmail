import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool } from "../db.ts";
import { arr, davFetch, escText, getNcLink, httpError, requireNcLink, xml, type NcLink } from "./link.ts";

/** Nextcloud Contacts over CardDAV, mirrored into a table so suggestions are instant. */

const home = (l: NcLink) => `${l.baseUrl}/remote.php/dav/addressbooks/users/${encodeURIComponent(l.username)}/`;
// Nextcloud writes line ends in the XML as character references (&#13;), which the parser leaves alone
const decodeRefs = (t: string) => t.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
const unfold = (t: string) => decodeRefs(t).replace(/\r?\n[ \t]/g, "");
const unesc = (s: string) => s.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1");
const esc = escText;

export function parseVcard(text: string): { name: string; emails: string[]; org: string } {
  let name = "", org = "";
  const emails: string[] = [];
  for (const l of unfold(text).split(/\r?\n/)) {
    const i = l.indexOf(":"); if (i < 0) continue;
    const key = l.slice(0, i).split(";")[0]!.toUpperCase(), value = l.slice(i + 1);
    if (key === "FN") name = unesc(value).trim();
    else if (key === "EMAIL" && value.includes("@")) emails.push(value.trim().toLowerCase());
    else if (key === "ORG") org = unesc(value.split(";")[0] ?? "").trim();
  }
  return { name, emails, org };
}

async function addressBooks(l: NcLink): Promise<string[]> {
  const r = await davFetch(l, home(l), { method: "PROPFIND", headers: { depth: "1", "content-type": "application/xml" },
    body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>` });
  if (r.status >= 300) throw httpError(502, `Nextcloud answered ${r.status} for the address books`);
  const out: string[] = [];
  for (const resp of arr<any>(xml.parse(await r.text())?.multistatus?.response))
    for (const ps of arr<any>(resp.propstat)) if (ps.prop?.resourcetype && "addressbook" in ps.prop.resourcetype) out.push(new URL(String(resp.href), l.baseUrl).toString());
  return out;
}

const lastSync = new Map<string, number>();
export async function syncContacts(owner: string) {
  const l = await getNcLink(owner);
  if (!l) return 0;
  lastSync.set(owner, Date.now());
  const rows: { href: string; name: string; emails: string[]; org: string }[] = [];
  for (const book of await addressBooks(l)) {
    const r = await davFetch(l, book, { method: "REPORT", headers: { depth: "1", "content-type": "application/xml" },
      body: `<?xml version="1.0"?><c:addressbook-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"><d:prop><c:address-data><c:prop name="FN"/><c:prop name="EMAIL"/><c:prop name="ORG"/></c:address-data></d:prop></c:addressbook-query>` });
    if (r.status >= 300) continue;
    for (const resp of arr<any>(xml.parse(await r.text())?.multistatus?.response)) {
      for (const ps of arr<any>(resp.propstat)) {
        const data = ps.prop?.["address-data"]; if (!data) continue;
        const v = parseVcard(String(data));
        if (v.emails.length) rows.push({ href: String(resp.href), ...v });
      }
    }
  }
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("delete from nc_contacts where owner = $1", [owner]);
    if (rows.length) await c.query(
      `insert into nc_contacts (owner, href, name, emails, org) select $1, t.href, t.name, array(select jsonb_array_elements_text(t.emails)), t.org
       from jsonb_to_recordset($2::jsonb) as t(href text, name text, emails jsonb, org text) on conflict do nothing`, [owner, JSON.stringify(rows)]);
    await c.query("commit");
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  return rows.length;
}

/** Contacts matching what was typed, for recipient suggestions (called by the mail-history search). */
export async function searchNcContacts(owner: string, q: string, limit: number): Promise<{ email: string; name: string }[]> {
  if (!(await getNcLink(owner))) return [];
  if (Date.now() - (lastSync.get(owner) ?? 0) > 10 * 60_000) syncContacts(owner).catch(() => {}); // refresh in the background
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { rows } = await pool.query(
    `select e as email, c.name from nc_contacts c cross join lateral unnest(c.emails) e
     where lower(c.name || ' ' || e || ' ' || c.org) like $2 and c.owner = $1
     order by (e like $3 or lower(c.name) like $3) desc, c.name limit $4`, [owner, like, `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, limit]);
  return rows;
}

export async function contactRoutesNc(app: FastifyInstance) {
  app.post("/api/nextcloud/contacts/sync", async (req) => { await requireNcLink(req.owner); return { contacts: await syncContacts(req.owner) }; });

  app.get<{ Querystring: { email?: string } }>("/api/nextcloud/contacts/known", async (req) => {
    if (!(await getNcLink(req.owner)) || !req.query.email) return { connected: false, known: false };
    const { rows } = await pool.query("select 1 from nc_contacts where owner = $1 and $2 = any(emails) limit 1", [req.owner, req.query.email.toLowerCase()]);
    return { connected: true, known: rows.length > 0 };
  });

  // Save a sender (or anyone) to the user's address book.
  app.post("/api/nextcloud/contacts", async (req) => {
    const b = z.object({ name: z.string().default(""), email: z.string().email() }).parse(req.body);
    const l = await requireNcLink(req.owner);
    const email = b.email.toLowerCase();
    const { rows } = await pool.query("select 1 from nc_contacts where owner = $1 and $2 = any(emails)", [req.owner, email]);
    if (rows.length) return { added: false, reason: "already a contact" };
    const books = await addressBooks(l);
    const book = books.find((x) => /\/contacts\/?$/.test(x)) ?? books[0];
    if (!book) throw httpError(502, "You have no address book in Nextcloud Contacts.");
    const uid = randomUUID(), name = b.name.trim() || email.split("@")[0]!;
    const parts = name.split(/\s+/);
    const vcf = ["BEGIN:VCARD", "VERSION:3.0", `UID:${uid}`, `FN:${esc(name)}`, `N:${esc(parts.length > 1 ? parts.slice(-1)[0]! : name)};${esc(parts.length > 1 ? parts.slice(0, -1).join(" ") : "")};;;`, `EMAIL;TYPE=INTERNET:${email}`, `PRODID:-//Mail//EN`, "END:VCARD", ""].join("\r\n");
    const r = await davFetch(l, new URL(`${uid}.vcf`, book.endsWith("/") ? book : book + "/").toString(), { method: "PUT", headers: { "content-type": "text/vcard; charset=utf-8", "if-none-match": "*" }, body: vcf });
    if (!r.ok) throw httpError(502, `Nextcloud refused the contact (${r.status})`);
    await pool.query("insert into nc_contacts (owner, href, name, emails, org) values ($1,$2,$3,$4,'') on conflict do nothing", [req.owner, `${book}${uid}.vcf`, name, [email]]);
    return { added: true };
  });
}
