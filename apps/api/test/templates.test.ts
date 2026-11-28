import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApi } from "./server.ts";
import { testNextcloud } from "./handoff.ts";

/** Templates belong to the person who made them; nobody else can see, change or remove them. */
let api: { url: string; stop: () => Promise<void> };
const ncs = testNextcloud();
let alice = "", bob = "";

const call = async (path: string, o: { method?: string; body?: unknown; cookie?: string } = {}) => {
  const r = await fetch(`${api.url}/api${path}`, {
    method: o.method ?? (o.body !== undefined ? "POST" : "GET"),
    headers: { ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...(o.cookie ? { cookie: o.cookie } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  const t = await r.text();
  return { status: r.status, data: t ? JSON.parse(t) : undefined, setCookie: r.headers.get("set-cookie") ?? "" };
};
const login = async (u: string) => (await call("/auth/handoff", { body: { token: ncs.token(u) } })).setCookie.split(";")[0]!;

beforeAll(async () => {
  api = await startApi(4144, { NCMAIL_AUTH: "nextcloud", NEXTCLOUD_URL: "http://127.0.0.1:9", NCMAIL_HANDOFF_PUBLIC_KEY: ncs.publicKey }, "ncmail_templates_test");
  alice = await login("alice"); bob = await login("bob");
  for (const c of [alice, bob]) for (const t of (await call("/templates", { cookie: c })).data) await call(`/templates/${t.id}`, { method: "DELETE", cookie: c });
}, 60_000);
afterAll(async () => { await api?.stop(); });

describe("templates", () => {
  let id = "";

  it("are made, listed by name, changed and removed", async () => {
    const made = await call("/templates", { cookie: alice, body: { name: "Thanks", subject: "Thank you", html: "<p>Thanks for your message.</p>" } });
    expect(made.status).toBe(201);
    id = made.data.id;
    await call("/templates", { cookie: alice, body: { name: "away", html: "<p>I am away.</p>" } });
    expect((await call("/templates", { cookie: alice })).data.map((t: any) => t.name)).toEqual(["away", "Thanks"]); // by name, case-insensitive
    expect((await call(`/templates/${id}`, { method: "PATCH", cookie: alice, body: { name: "Thank you note" } })).data)
      .toEqual({ id, name: "Thank you note", subject: "Thank you", html: "<p>Thanks for your message.</p>" });
  });

  it("need a name", async () => {
    expect((await call("/templates", { cookie: alice, body: { name: "  ", html: "<p>x</p>" } })).status).toBe(400);
  });

  it("are invisible to everyone else, and look like they do not exist", async () => {
    expect((await call("/templates", { cookie: bob })).data).toEqual([]);
    expect((await call(`/templates/${id}`, { method: "PATCH", cookie: bob, body: { name: "mine now" } })).status).toBe(404);
    expect((await call(`/templates/${id}`, { method: "DELETE", cookie: bob })).status).toBe(404);
    expect((await call("/templates")).status).toBe(401);
  });

  it("are removed by their owner", async () => {
    expect((await call(`/templates/${id}`, { method: "DELETE", cookie: alice })).status).toBe(204);
    expect((await call("/templates", { cookie: alice })).data.map((t: any) => t.name)).toEqual(["away"]);
  });
});
