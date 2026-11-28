import { readFileSync } from "node:fs";

/**
 * The Nextcloud app and this service are released together with the same version, but an administrator can update one
 * without the other. Each side says which version it is and the oldest version of the other side it works with, so the
 * admin Mail page can explain a mismatch instead of failing with a bare error.
 */
export const SERVICE_VERSION: string = process.env.NCMAIL_VERSION ?? JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
/** The oldest Nextcloud app this service works with. Raise it when this service starts relying on something new in the app. */
export const MIN_APP_VERSION = "0.1.0";

/** Compare dotted versions numerically ("0.10.0" > "0.9.3"); anything after a "-" (a pre-release or build tag) is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.trim().replace(/^v/, "").split("-")[0]!.split(".").map((x) => Number.parseInt(x, 10) || 0);
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return Math.sign(d); }
  return 0;
}

/**
 * Nextcloud's signed calls carry the app's version (X-Ncmail-App-Version). Warn once per version that is too old, or when
 * the header is missing, so a half-done update shows in the service's log.
 */
const warned = new Set<string>();
export let lastAppVersion: string | null = null;
export function noteAppVersion(header: string | string[] | undefined, log: { warn: (o: object, m: string) => void }) {
  const v = (Array.isArray(header) ? header[0] : header)?.trim().slice(0, 40) || "";
  lastAppVersion = v || "unknown";
  const key = v || "(none)";
  if (warned.has(key)) return;
  if (!v) { warned.add(key); log.warn({ serviceVersion: SERVICE_VERSION }, "The Nextcloud app does not say its version. Update it to match the mail service."); return; }
  if (compareVersions(v, MIN_APP_VERSION) < 0) { warned.add(key); log.warn({ appVersion: v, minAppVersion: MIN_APP_VERSION, serviceVersion: SERVICE_VERSION }, "The Nextcloud app is too old for this mail service. Update the Nextcloud app."); return; }
  if (compareVersions(v, SERVICE_VERSION) !== 0) { warned.add(key); log.warn({ appVersion: v, serviceVersion: SERVICE_VERSION }, "The Nextcloud app and the mail service have different versions. They work together, but update the older one to keep them in step."); }
}
