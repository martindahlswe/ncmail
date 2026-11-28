import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { user, IMAP_HOST } from "./env.ts";
import { addAccount, api, apiRaw, resetMailbox, type Acct } from "./helpers.ts";
import { ManageSieve, withSieve, type SieveConn } from "../src/sieve/managesieve.ts";
import { buildScript, configSchema, readConfig, SCRIPT_NAME } from "../src/sieve/script.ts";

const U = user(33);
let acct: Acct;
const direct: SieveConn = { host: IMAP_HOST, port: 14190, security: "none", username: U, password: "test" };
const cfg = (o: object) => configSchema.parse(o);

beforeAll(async () => {
  await resetMailbox(U);
  acct = await addAccount(U);
  await withSieve(direct, async (s) => { await s.setActive(""); for (const x of await s.list()) await s.delete(x.name); }); // start from no scripts at all (earlier runs leave theirs behind)
});
afterAll(async () => { if (acct) await api(`/accounts/${acct.id}`, { method: "DELETE" }); });

describe("building the script", () => {
  const rule = (o: object) => ({ id: "r1", name: "Rule", conditions: [{ field: "from", op: "contains", value: "boss@example.org" }], actions: [{ type: "move", value: "Clients/Acme" }], ...o });
  it("files mail from a sender into a folder and stops", () => {
    const s = buildScript(cfg({ rules: [rule({})] }), []);
    expect(s).toContain('require ["fileinto", "mailbox"]');
    expect(s).toContain('if header :contains "from" "boss@example.org"');
    expect(s).toContain('fileinto :create "Clients/Acme";');
    expect(s).toContain("stop;");
  });
  it("sets flags on the filed message itself, not on everything after it", () => {
    const s = buildScript(cfg({ rules: [rule({ actions: [{ type: "read" }, { type: "star" }, { type: "label", value: "work" }, { type: "move", value: "Archive" }] })] }), []);
    expect(s).toContain('fileinto :create :flags ["\\\\Seen", "\\\\Flagged", "$ncl_work"] "Archive";');
    expect(s).not.toContain("addflag");
  });
  it("combines conditions with all / any, and understands the other tests", () => {
    const conds = [{ field: "subject", op: "starts-with", value: "[ALERT]" }, { field: "to", op: "not-contains", value: "me@x" }, { field: "size", op: "over", value: "5" }];
    expect(buildScript(cfg({ rules: [rule({ conditions: conds, match: "any" })] }), [])).toMatch(/anyof\(header :matches "subject" "\\\\\[ALERT\]\*"|anyof\(header :matches "subject" "\[ALERT\]\*"/);
    const all = buildScript(cfg({ rules: [rule({ conditions: conds })] }), []);
    expect(all).toContain("allof(");
    expect(all).toContain('not header :contains "to" "me@x"');
    expect(all).toContain("size :over 5M");
  });
  it("discards, forwards a copy, and leaves disabled rules out", () => {
    const s = buildScript(cfg({ rules: [rule({ actions: [{ type: "discard" }] }), rule({ id: "r2", actions: [{ type: "forward", value: "a@b.co" }] }), rule({ id: "r3", enabled: false, name: "Off" })] }), []);
    expect(s).toContain("discard;");
    expect(s).toContain('redirect :copy "a@b.co";');
    expect(s).toContain('require ["copy"]');
    expect(s).not.toContain("# Off");
  });
  it("writes the vacation reply, with dates, the addresses it answers for, and dot-stuffed text", () => {
    const s = buildScript(cfg({ vacation: { enabled: true, subject: 'Away "soon"', body: "I am away.\n.\nBack on the 3rd.", days: 3, from: "2026-12-01", to: "2026-12-24" } }), ["me@example.org", "alias@example.org"]);
    expect(s).toContain('require ["date", "relational", "vacation"]');
    expect(s).toContain('currentdate :value "ge" "date" "2026-12-01"');
    expect(s).toContain(':days 3 :subject "Away \\"soon\\"" :addresses ["me@example.org", "alias@example.org"]');
    expect(s).toContain("\r\n..\r\n"); // a line with just a dot is escaped
  });
  it("carries its settings inside the script, so the server holds the only copy", () => {
    const c = cfg({ vacation: { enabled: true, body: "x" }, rules: [rule({})] });
    expect(readConfig(buildScript(c, []))).toEqual(c);
    expect(readConfig("require [];")).toBeNull();
  });
});

describe("filters on the mail server", () => {
  it("answers with what the server supports, and an empty setup at first", async () => {
    await api(`/accounts/${acct.id}/sieve/connection`, { method: "PUT", body: { host: "", port: 14190, security: "none" } });
    const g = await api<any>(`/accounts/${acct.id}/sieve`);
    expect(g).toMatchObject({ available: true, hasOurs: false, oursActive: false });
    expect(g.config.rules).toEqual([]);
    expect(g.ownAddresses).toContain(U);
  });
  it("explains when there is no Sieve server there", async () => {
    await api(`/accounts/${acct.id}/sieve/connection`, { method: "PUT", body: { host: "", port: 1, security: "none" } });
    const g = await api<any>(`/accounts/${acct.id}/sieve`);
    expect(g.available).toBe(false);
    expect(g.error).toMatch(/Could not reach the Sieve server/);
    await api(`/accounts/${acct.id}/sieve/connection`, { method: "PUT", body: { host: "", port: 14190, security: "none" } });
  });
  it("can use a separate login for the Sieve service, and never returns its password", async () => {
    const put = (body: object) => apiRaw(`/accounts/${acct.id}/sieve/connection`, { method: "PUT", body: { host: "", port: 14190, security: "none", ...body } });
    expect((await put({ useImapLogin: false, username: "", password: "x" })).status).toBe(400);
    expect((await put({ useImapLogin: false, username: U })).status).toBe(400); // no password yet
    expect((await put({ useImapLogin: false, username: U, password: "wrong" })).status).toBe(200);
    const bad = await api<any>(`/accounts/${acct.id}/sieve`);
    expect(bad.available).toBe(false); // the server refuses that password
    expect(bad.connection).toMatchObject({ separate: true, username: U });
    expect(JSON.stringify(bad)).not.toContain("wrong");
    await put({ useImapLogin: false, username: U, password: "test" });
    expect((await api<any>(`/accounts/${acct.id}/sieve`)).available).toBe(true);
    await put({ useImapLogin: false, username: U }); // blank password keeps the saved one
    expect((await api<any>(`/accounts/${acct.id}/sieve`)).available).toBe(true);
    await put({ useImapLogin: true });
    const back = await api<any>(`/accounts/${acct.id}/sieve`);
    expect(back.available).toBe(true);
    expect(back.connection.separate).toBe(false);
  });
  it("uploads, checks and activates the script; the server really has it", async () => {
    const body = { vacation: { enabled: true, subject: "Out of office", body: "Back soon.", days: 7 },
      rules: [{ id: "a", name: "Boss", conditions: [{ field: "from", op: "contains", value: "boss@example.org" }], actions: [{ type: "star" }, { type: "move", value: "Archive" }] },
              { id: "b", name: "Newsletters", conditions: [{ field: "list-id", op: "contains", value: "news" }, { field: "subject", op: "ends-with", value: "digest" }], actions: [{ type: "read" }, { type: "label", value: "news" }, { type: "stop" }] }] };
    const r = await api<any>(`/accounts/${acct.id}/sieve`, { method: "PUT", body });
    expect(r.script).toContain("vacation");
    const scripts = await withSieve(direct, async (s) => ({ list: await s.list(), text: await s.get(SCRIPT_NAME) }));
    expect(scripts.list).toEqual([{ name: SCRIPT_NAME, active: true }]);
    expect(scripts.text).toContain('fileinto :create :flags ["\\\\Flagged"] "Archive"');
    const g = await api<any>(`/accounts/${acct.id}/sieve`);
    expect(g).toMatchObject({ oursActive: true, hasOurs: true });
    expect(g.config.rules.map((x: any) => x.name)).toEqual(["Boss", "Newsletters"]);
    expect(g.config.vacation).toMatchObject({ enabled: true, subject: "Out of office" });
  });
  it("rejects a bad request before touching the server", async () => {
    expect((await apiRaw(`/accounts/${acct.id}/sieve`, { method: "PUT", body: { rules: [{ id: "x", conditions: [], actions: [{ type: "stop" }] }] } })).status).toBe(400);
  });
  it("lets the server's own checker catch a broken script", async () => {
    const s = await ManageSieve.open(direct);
    await expect(s.check('if header :contains "from" { }')).rejects.toThrow();
    await s.close();
  });
  it("switches filtering off", async () => {
    await api(`/accounts/${acct.id}/sieve/disable`, { method: "POST" });
    expect((await api<any>(`/accounts/${acct.id}/sieve`))).toMatchObject({ oursActive: false, hasOurs: true });
  });
  it("warns when a different script is active, which activating ours would replace", async () => {
    await withSieve(direct, async (s) => { await s.put("other", 'keep;\r\n'); await s.setActive("other"); });
    const g = await api<any>(`/accounts/${acct.id}/sieve`);
    expect(g.otherActive).toBe("other");
    await withSieve(direct, async (s) => { await s.setActive(""); });
  });
  it("shows the generated script", async () => {
    expect((await api<any>(`/accounts/${acct.id}/sieve/script`)).script).toContain("# ncmail:config:");
  });
});
