import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { arr, davFetch, httpError, requireNcLink, xml, type NcLink } from "./link.ts";
import { publicUpload, stageBuffer } from "../uploads.ts";

/** Nextcloud Files over WebDAV: browse, attach to a message, and save attachments. */

const MAX = 100 * 1024 * 1024;
const root = (l: NcLink) => `${l.baseUrl}/remote.php/dav/files/${encodeURIComponent(l.username)}`;

/** "/a/b" with no ".." tricks, as a list of segments. */
export function cleanPath(p: string): string[] {
  const segs = p.split("/").filter((s) => s && s !== ".");
  if (segs.some((s) => s === ".." || /[\u0000-\u001f]/.test(s))) throw httpError(400, "That folder name is not allowed.");
  return segs;
}
const urlFor = (l: NcLink, segs: string[]) => `${root(l)}/${segs.map(encodeURIComponent).join("/")}`;

export interface FileItem { name: string; path: string; dir: boolean; size: number; modified: string; type: string }

export async function listFiles(l: NcLink, path: string): Promise<FileItem[]> {
  const segs = cleanPath(path);
  const r = await davFetch(l, urlFor(l, segs) + "/", { method: "PROPFIND", headers: { depth: "1", "content-type": "application/xml" },
    body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/><d:resourcetype/><d:getcontenttype/></d:prop></d:propfind>` });
  if (r.status === 404) throw httpError(404, "That folder does not exist.");
  if (r.status >= 300) throw httpError(502, `Nextcloud answered ${r.status}`);
  const prefix = new URL(root(l)).pathname;
  const out: FileItem[] = [];
  for (const resp of arr<any>(xml.parse(await r.text())?.multistatus?.response)) {
    const full = decodeURIComponent(String(resp.href)).replace(/\/+$/, "");
    const rel = full.startsWith(prefix) ? full.slice(prefix.length) : full;
    const relSegs = rel.split("/").filter(Boolean);
    if (relSegs.length <= segs.length) continue; // the folder itself
    const p = arr<any>(resp.propstat).map((x) => x.prop).find((x) => x) ?? {};
    const dir = !!p.resourcetype && "collection" in p.resourcetype;
    out.push({ name: relSegs[relSegs.length - 1]!, path: "/" + relSegs.join("/"), dir, size: Number(p.getcontentlength ?? 0), modified: String(p.getlastmodified ?? ""), type: String(p.getcontenttype ?? "") });
  }
  return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

/** Write a file into a folder without replacing anything: "report.pdf" becomes "report (1).pdf" if it exists. */
export async function putFile(l: NcLink, folder: string, filename: string, content: Buffer, type?: string): Promise<string> {
  const segs = cleanPath(folder);
  const safe = filename.replace(/[\\/\r\n\u0000-\u001f]/g, "_").trim() || "attachment";
  const dot = safe.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [safe.slice(0, dot), safe.slice(dot)] : [safe, ""];
  for (let n = 0; n < 100; n++) {
    const name = n === 0 ? safe : `${stem} (${n})${ext}`;
    const r = await davFetch(l, urlFor(l, [...segs, name]), { method: "PUT", headers: { "content-type": type || "application/octet-stream", "if-none-match": "*" }, body: content });
    if (r.status === 412) continue; // taken: try the next name
    if (r.status === 404 || r.status === 409) throw httpError(404, "That folder does not exist.");
    if (!r.ok) throw httpError(502, `Nextcloud refused the file (${r.status})`);
    return "/" + [...segs, name].join("/");
  }
  throw httpError(409, "Too many files with that name.");
}

export async function filesRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { path?: string } }>("/api/nextcloud/files", async (req) => {
    const l = await requireNcLink(req.owner);
    const path = "/" + cleanPath(req.query.path ?? "/").join("/");
    return { path, items: await listFiles(l, path) };
  });

  // Bring files from Nextcloud into the message being written, as ordinary uploads.
  app.post("/api/nextcloud/files/attach", async (req) => {
    const { paths } = z.object({ paths: z.array(z.string()).min(1).max(20) }).parse(req.body);
    const l = await requireNcLink(req.owner);
    const out = [];
    for (const p of paths) {
      const segs = cleanPath(p);
      if (!segs.length) throw httpError(400, "Choose a file, not the root folder.");
      const r = await davFetch(l, urlFor(l, segs), { method: "GET" });
      if (r.status === 404) throw httpError(404, `"${segs[segs.length - 1]}" no longer exists.`);
      if (!r.ok) throw httpError(502, `Nextcloud answered ${r.status}`);
      if (Number(r.headers.get("content-length") ?? 0) > MAX) throw httpError(413, `"${segs[segs.length - 1]}" is larger than ${MAX / 1024 / 1024} MB.`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX) throw httpError(413, `"${segs[segs.length - 1]}" is larger than ${MAX / 1024 / 1024} MB.`);
      out.push(publicUpload(stageBuffer(req.owner, segs[segs.length - 1]!, r.headers.get("content-type") ?? "", buf)));
    }
    return out;
  });
}
