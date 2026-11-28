import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { get } from "node:http";
import { fileURLToPath } from "node:url";
import { API_URL, user } from "./env.ts";
import { addAccount, api, deliver, messages, resetMailbox, waitFor, type Acct } from "./helpers.ts";

const U = user(19);
let acct: Acct;
let inbox: any;
const webBuilt = existsSync(fileURLToPath(new URL("../../web/dist/index.html", import.meta.url)));

beforeAll(async () => {
  await resetMailbox(U);
  await deliver(U, "INBOX", Array.from({ length: 60 }, (_, i) => ({ subject: `Message number ${i} with a reasonably long subject line`, from: `Sender ${i} <s${i}@example.org>`, date: new Date(Date.UTC(2026, 5, 1, 8, i)) })));
  acct = await addAccount(U);
  inbox = await acct.folder("INBOX");
  await waitFor(async () => (await messages(inbox.id)).length === 60, { what: "60 messages" });
});
afterAll(async () => { if (acct) await api(`/accounts/${acct.id}`, { method: "DELETE" }); });

const list = () => `${API_URL}/api/folders/${inbox.id}/messages?limit=50`;

describe("API responses", () => {
  it("compresses larger JSON when the client accepts it", async () => {
    // fetch() decompresses transparently, so count the bytes actually sent over the wire
    const wire = (encoding: string) => new Promise<{ encoding?: string; bytes: number }>((resolve, reject) => {
      get(list(), { headers: { "accept-encoding": encoding } }, (res) => {
        let bytes = 0;
        res.on("data", (c) => (bytes += c.length));
        res.on("end", () => resolve({ encoding: res.headers["content-encoding"] as string | undefined, bytes }));
      }).on("error", reject);
    });
    const [gz, plain] = [await wire("gzip"), await wire("identity")];
    expect(gz.encoding).toBe("gzip");
    expect(plain.encoding).toBeUndefined();
    expect(gz.bytes).toBeLessThan(plain.bytes / 2); // lists compress several times over
  });

  it("answers 304 with no body when nothing changed (ETag revalidation)", async () => {
    const first = await fetch(list(), { headers: { "accept-encoding": "identity" } });
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const again = await fetch(list(), { headers: { "accept-encoding": "identity", "if-none-match": etag! } });
    expect(again.status).toBe(304);
    expect((await again.arrayBuffer()).byteLength).toBe(0);
  });

  it("serves a different ETag, and a full body, once the data changed", async () => {
    const before = (await fetch(list(), { headers: { "accept-encoding": "identity" } })).headers.get("etag")!;
    await deliver(U, "INBOX", { subject: "Brand new message", date: new Date(Date.UTC(2026, 6, 1)) });
    await waitFor(async () => (await messages(inbox.id)).some((m) => m.subject === "Brand new message"), { timeout: 25_000, what: "new mail" });
    const r = await fetch(list(), { headers: { "accept-encoding": "identity", "if-none-match": before } });
    expect(r.status).toBe(200);
    expect(r.headers.get("etag")).not.toBe(before);
  });

  it("tells browsers to revalidate API data rather than reuse it blindly", async () => {
    expect((await fetch(list())).headers.get("cache-control")).toBe("no-cache");
  });

  it("returns a JSON 404 for unknown API routes", async () => {
    const r = await fetch(`${API_URL}/api/does-not-exist`);
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: expect.any(String) });
  });
});

// Only meaningful once the web app has been built (pnpm build).
describe.skipIf(!webBuilt)("production web build", () => {
  it("serves the app at / and for client-side routes", async () => {
    for (const path of ["/", "/some/client/route"]) {
      const r = await fetch(`${API_URL}${path}`);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toMatch(/text\/html/);
      expect(r.headers.get("cache-control")).toBe("no-cache"); // the HTML must never be cached, or new releases would not be picked up
      expect(await r.text()).toContain('<div id="root">');
    }
  });

  it("caches hashed assets for a year and returns a real 404 for missing files", async () => {
    const html = await (await fetch(`${API_URL}/`)).text();
    const asset = html.match(/\/assets\/[^"]+\.js/)![0];
    const r = await fetch(`${API_URL}${asset}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toMatch(/max-age=31536000.*immutable/);
    const missing = await fetch(`${API_URL}/assets/definitely-missing.js`);
    expect(missing.status).toBe(404); // not the HTML page, which browsers would reject as a script
    expect(missing.headers.get("content-type")).not.toMatch(/html/);
  });
});
