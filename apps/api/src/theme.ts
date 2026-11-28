import type { FastifyInstance } from "fastify";

/**
 * Proxies the live Nextcloud theme so the UI follows whatever the instance uses:
 * admin branding, custom primary colour, logo, and external theme apps all end up
 * in the CSS variables Nextcloud serves at /apps/theming/theme/*.css.
 * The base URL comes only from server config (never from request input).
 */
const base = () => (process.env.NEXTCLOUD_URL ?? "").replace(/\/+$/, "");
const VARIANTS = new Set(["default", "light", "dark", "light-highcontrast", "dark-highcontrast", "opendyslexic"]);

const cache = new Map<string, { at: number; body: string | Buffer; type: string }>();
async function cached(path: string, ttlMs = 5 * 60_000, headers: Record<string, string> = {}) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < ttlMs) return hit;
  const r = await fetch(base() + path, { headers, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Nextcloud returned ${r.status} for ${path}`);
  const type = r.headers.get("content-type") ?? "application/octet-stream";
  const body = type.startsWith("image/") ? Buffer.from(await r.arrayBuffer()) : await r.text();
  const entry = { at: Date.now(), body, type };
  cache.set(path, entry);
  return entry;
}

export async function themeRoutes(app: FastifyInstance) {
  app.get("/api/theme", async () => {
    if (!base()) return { enabled: false };
    try {
      const c = await cached("/ocs/v1.php/cloud/capabilities?format=json", 60_000, { "OCS-APIRequest": "true" });
      const t = JSON.parse(c.body as string)?.ocs?.data?.capabilities?.theming ?? {};
      return {
        enabled: true,
        name: t.name ?? "Nextcloud",
        slogan: t.slogan ?? "",
        color: t.color ?? null,
        cssUrl: "/api/theme/css",
        logoUrl: "/api/theme/logo",
      };
    } catch {
      return { enabled: false };
    }
  });

  app.get<{ Querystring: { variant?: string } }>("/api/theme/css", async (req, reply) => {
    if (!base()) return reply.code(404).send();
    const v = req.query.variant ?? "default";
    if (!VARIANTS.has(v)) return reply.code(400).send();
    try {
      const c = await cached(`/apps/theming/theme/${v}.css`);
      // Make root-relative url(...) references (fonts, background image) absolute.
      const css = (c.body as string).replace(/url\((['"]?)\/(?!\/)/g, `url($1${base()}/`);
      return reply.type("text/css").header("cache-control", "max-age=300").send(css);
    } catch (e: any) {
      return reply.code(502).send(e.message);
    }
  });

  app.get("/api/theme/logo", async (_req, reply) => {
    if (!base()) return reply.code(404).send();
    try {
      // the admin's logo if one is set, otherwise Nextcloud's own
      const c = await cached("/apps/theming/image/logo").catch(() => cached("/core/img/logo/logo.svg"));
      return reply.type(c.type).header("cache-control", "max-age=300").send(c.body);
    } catch {
      return reply.code(502).send();
    }
  });
}
