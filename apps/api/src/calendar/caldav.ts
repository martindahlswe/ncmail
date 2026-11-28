import { XMLParser } from "fast-xml-parser";
import { guardUrl, httpRequest } from "../netguard.ts";

/** A small CalDAV client: find the user's calendars, read and write one calendar object. Works with Nextcloud (SabreDAV). */
export interface DavCfg { baseUrl: string; username: string; password: string }
const xml = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false, attributeNamePrefix: "@_" });
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

export function normalizeBase(u: string): string {
  let url: URL;
  try { url = new URL(u.trim()); } catch { throw httpError(400, "That is not a valid address. Use something like https://cloud.example.com"); }
  if (!/^https?:$/.test(url.protocol)) throw httpError(400, "The address must start with http:// or https://");
  return url.toString().replace(/\/+$/, "").replace(/\/remote\.php\/dav.*$/, "");
}
export const homeUrl = (c: DavCfg) => `${normalizeBase(c.baseUrl)}/remote.php/dav/calendars/${encodeURIComponent(c.username)}/`;

async function dav(c: DavCfg, url: string, init: { method: string; headers?: Record<string, string>; body?: string }) {
  const u = new URL(url);
  const lookup = await guardUrl(u, "calendar server");
  const r = await httpRequest(u, {
    ...init, lookup, timeoutMs: 15000,
    headers: { authorization: `Basic ${Buffer.from(`${c.username}:${c.password}`).toString("base64")}`, ...init.headers },
  }).catch((e) => { throw httpError(502, `Could not reach the calendar server (${e.code ?? e.message})`); });
  if (r.status === 401) throw httpError(400, "The user name or password was not accepted. With two-factor sign-in, create an app password in Nextcloud (Settings > Security).");
  return r;
}

export interface CalendarInfo { href: string; url: string; name: string }

/** The user's calendars that can hold events (or, with "VTODO", task lists). */
export async function discoverCalendars(c: DavCfg, component: "VEVENT" | "VTODO" = "VEVENT"): Promise<CalendarInfo[]> {
  const home = homeUrl(c);
  const r = await dav(c, home, {
    method: "PROPFIND", headers: { depth: "1", "content-type": "application/xml" },
    body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/></d:prop></d:propfind>`,
  });
  if (r.status === 404) throw httpError(400, "No calendars found for that user. Check the address and user name.");
  if (r.status >= 300) throw httpError(502, `The calendar server answered ${r.status}`);
  const doc = xml.parse(await r.text());
  const out: CalendarInfo[] = [];
  for (const resp of arr<any>(doc?.multistatus?.response)) {
    for (const ps of arr<any>(resp.propstat)) {
      const p = ps.prop ?? {};
      if (!String(ps.status ?? "").includes("200") || !p.resourcetype || !("calendar" in (p.resourcetype as object))) continue;
      const comps = arr<any>(p["supported-calendar-component-set"]?.comp).map((x) => x["@_name"]);
      if (comps.length && !comps.includes(component)) continue;
      out.push({ href: String(resp.href), url: new URL(String(resp.href), home).toString(), name: String(p.displayname ?? "Calendar") });
    }
  }
  return out;
}

/** A calendar object with its ETag (empty when the server sends none). */
export async function getObjectTagged(c: DavCfg, url: string): Promise<{ ics: string; etag: string } | null> {
  const r = await dav(c, url, { method: "GET" });
  if (r.status === 404) return null;
  if (!r.ok) throw httpError(502, `The calendar server answered ${r.status}`);
  return { ics: await r.text(), etag: r.headers.get("etag") ?? "" };
}
export const getObject = async (c: DavCfg, url: string) => (await getObjectTagged(c, url))?.ics ?? null;

/**
 * Create (only if absent) or replace a calendar object. With `ifMatch` a replace only happens if the object is still the version
 * that was read. Returns "exists" when creating would overwrite something, "changed" when the object changed in between.
 */
export async function putObject(c: DavCfg, url: string, ics: string, create: boolean, ifMatch?: string): Promise<"ok" | "exists" | "changed"> {
  const cond: Record<string, string> = create ? { "if-none-match": "*" } : ifMatch ? { "if-match": ifMatch } : {};
  const r = await dav(c, url, { method: "PUT", headers: { "content-type": "text/calendar; charset=utf-8", ...cond }, body: ics });
  if (r.status === 412) return create ? "exists" : "changed";
  if (!r.ok) throw httpError(502, `The calendar server refused the event (${r.status}): ${(await r.text()).replace(/<[^>]+>/g, " ").trim().slice(0, 200)}`);
  return "ok";
}
