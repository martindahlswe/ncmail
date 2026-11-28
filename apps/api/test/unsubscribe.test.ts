import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IMAP_HOST, IMAP_PORT, SMTP_PORT, TEST_PASSWORD, user } from "./env.ts";
import { deliver, mailpit, resetMailbox, waitFor } from "./helpers.ts";
import { startApi } from "./server.ts";
import { dkimSignature, mailtoAddress, parseUnsubscribe, unsubscribeOffer } from "../src/listunsub.ts";
import { parseAuth } from "../src/phishing.ts";

/**
 * Leaving mailing lists: List-Unsubscribe (RFC 2369) and one click (RFC 8058). One click needs https, so the test runs a small
 * https "list" with a certificate made for the test, and its own API instance that trusts that certificate.
 */
const U = user(2);
const dir = mkdtempSync(join(tmpdir(), "ncmail-unsub-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
  "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });

let api: { url: string; stop: () => Promise<void> };
let list: Server;
let listUrl = "";
const hits: { method: string; body: string; path: string; type: string }[] = [];
let answer = 200;
let acctId = "", inbox = "", junk = "";

const call = async (path: string, o: { method?: string; body?: unknown } = {}) => {
  const r = await fetch(`${api.url}/api${path}`, {
    method: o.method ?? (o.body !== undefined ? "POST" : "GET"),
    headers: o.body !== undefined ? { "content-type": "application/json" } : {},
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  const t = await r.text();
  return { status: r.status, data: t ? JSON.parse(t) : undefined };
};
const folderId = async (name: string) => waitFor(async () => (await call(`/accounts/${acctId}/folders`)).data?.find((f: any) => f.name === name)?.id, { what: name });
const sync = async (id: string) => {
  await call(`/folders/${id}/sync`, { method: "POST" });
  await waitFor(async () => !(await call(`/folders/${id}`)).data.syncing, { what: "sync" });
};
const idOf = async (subject: string, folder = inbox) =>
  waitFor(async () => (await call(`/folders/${folder}/messages?limit=200&threads=0`)).data.items.find((m: any) => m.subject === subject)?.id, { what: subject });
const offer = async (subject: string) => (await call(`/messages/${await idOf(subject)}`)).data.unsubscribe;
const unsubscribe = async (subject: string) => call(`/messages/${await idOf(subject)}/unsubscribe`, { method: "POST" });

const passed = { "Authentication-Results": "mx.example.test; dkim=pass (good signature) header.d=news.example.org; spf=pass" };
const covering = "v=1; a=rsa-sha256; d=news.example.org; s=s1; h=from:subject:list-unsubscribe:list-unsubscribe-post; bh=x; b=y";
const news = "News <news@news.example.org>";
const signed = { ...passed, "DKIM-Signature": covering };

beforeAll(async () => {
  list = createServer({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) }, (req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => { hits.push({ method: req.method ?? "", body, path: req.url ?? "", type: String(req.headers["content-type"] ?? "") }); res.statusCode = answer; res.end("ok"); });
  });
  await new Promise<void>((r) => list.listen(0, "127.0.0.1", () => r()));
  listUrl = `https://127.0.0.1:${(list.address() as any).port}`;
  api = await startApi(4143, { NODE_EXTRA_CA_CERTS: join(dir, "cert.pem") }, "ncmail_unsub_test");

  await resetMailbox(U);
  await deliver(U, "INBOX", [
    { subject: "One click, signed", from: news, headers: { ...signed, "List-Unsubscribe": `<mailto:leave@news.example.org>, <${listUrl}/oc?id=1>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } },
    { subject: "One click, refused", from: news, headers: { ...signed, "List-Unsubscribe": `<${listUrl}/oc?id=2>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } },
    { subject: "One click, not signed", headers: { "List-Unsubscribe": `<mailto:leave@news.example.org,boss@example.org?subject=remove%20me&cc=boss@example.org&body=hi>, <${listUrl}/oc?id=3>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } },
    // signed, but the signature does not cover List-Unsubscribe: the headers may have been added after signing
    { subject: "One click, headers not signed", from: news, headers: { ...passed, "DKIM-Signature": covering.replace(":list-unsubscribe:list-unsubscribe-post", ""), "List-Unsubscribe": `<${listUrl}/oc?id=5>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } },
    // a valid signature, but from a domain that is neither the sender's nor the address's
    { subject: "One click, other domain", headers: { ...passed, "DKIM-Signature": covering, "List-Unsubscribe": `<${listUrl}/oc?id=6>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } },
    { subject: "Only a page", headers: { "List-Unsubscribe": `<${listUrl}/page?id=4>` } },
    { subject: "No list" },
  ]);
  await deliver(U, "Junk", { subject: "Spammy list", headers: { ...signed, "List-Unsubscribe": "<mailto:leave@spam.example>" } });
  acctId = (await call("/accounts", { body: {
    name: "Lists", email: U, imap: { host: IMAP_HOST, port: IMAP_PORT, security: "none", username: U, password: TEST_PASSWORD },
    smtp: { host: IMAP_HOST, port: SMTP_PORT, security: "none", username: U, password: TEST_PASSWORD } } })).data.id;
  await call(`/accounts/${acctId}/sync`, { method: "POST" });
  inbox = await folderId("INBOX"); junk = await folderId("Junk");
  await sync(inbox); await sync(junk);
}, 90_000);
afterAll(async () => {
  await call(`/accounts/${acctId}`, { method: "DELETE" }).catch(() => {});
  await api?.stop();
  await new Promise((r) => list.close(r));
});

describe("unsubscribe", () => {
  it("offers one click only when a passing DKIM signature covers the headers and matches the sender", async () => {
    expect(await offer("One click, signed")).toEqual({ method: "one-click", target: "127.0.0.1" });
    expect(await offer("One click, headers not signed")).toEqual({ method: "link", target: `${listUrl}/oc?id=5` });
    expect(await offer("One click, other domain")).toEqual({ method: "link", target: `${listUrl}/oc?id=6` });
    // without a passing signature the one-click address is not trusted: the list is mailed instead
    expect(await offer("One click, not signed")).toEqual({ method: "mail", target: "leave@news.example.org" });
    expect(await offer("Only a page")).toEqual({ method: "link", target: `${listUrl}/page?id=4` });
    expect(await offer("No list")).toBeNull();
  });

  it("offers nothing for mail in Junk (answering spam confirms the address)", async () => {
    const id = await idOf("Spammy list", junk);
    expect((await call(`/messages/${id}`)).data.unsubscribe).toBeNull();
    expect((await call(`/messages/${id}/unsubscribe`, { method: "POST" })).status).toBe(400);
  });

  it("posts List-Unsubscribe=One-Click to the list", async () => {
    const r = await unsubscribe("One click, signed");
    expect(r.data).toEqual({ done: true, method: "one-click", target: "127.0.0.1" });
    expect(hits.at(-1)).toEqual({ method: "POST", path: "/oc?id=1", body: "List-Unsubscribe=One-Click", type: "application/x-www-form-urlencoded" });
  });

  it("says so plainly when the list refuses", async () => {
    answer = 500;
    try {
      const r = await unsubscribe("One click, refused");
      expect(r.status).toBe(502);
      expect(r.data.error).toMatch(/refused the request \(500\)/);
    } finally { answer = 200; }
  });

  it("mails one address of the list from the address it writes to, with fixed words", async () => {
    const r = await unsubscribe("One click, not signed");
    expect(r.data).toEqual({ done: true, method: "mail", target: "leave@news.example.org" });
    const hit = await waitFor(async () => (await mailpit.recent()).find((m) => m.Subject === "unsubscribe" && m.To?.[0]?.Address === "leave@news.example.org"), { what: "the unsubscribe mail" });
    const m = await mailpit.get(hit.ID);
    expect(m.To.map((t: any) => t.Address)).toEqual(["leave@news.example.org"]);
    expect(m.Cc ?? []).toEqual([]);
    expect(m.Text.trim()).toBe("unsubscribe");
    expect(m.From.Address).toBe(U);
  });

  it("leaves a page link to the browser and does not call it itself", async () => {
    const before = hits.length;
    expect((await unsubscribe("Only a page")).data).toEqual({ done: false, method: "link", target: `${listUrl}/page?id=4` });
    expect(hits.length).toBe(before);
  });

  it("refuses for a message without a list", async () => {
    expect((await unsubscribe("No list")).status).toBe(400);
  });
});

describe("reading List-Unsubscribe", () => {
  it("takes the first web and mail address, and one click only over https", () => {
    const u = parseUnsubscribe([
      { key: "list-unsubscribe", line: "List-Unsubscribe: <mailto:a@b.example>,\r\n <https://list.example/u?x=1>" },
      { key: "list-unsubscribe-post", line: "List-Unsubscribe-Post: List-Unsubscribe=One-Click" },
    ]);
    expect(u).toEqual({ http: "https://list.example/u?x=1", mailto: "mailto:a@b.example", oneClick: true, signatures: [] });
    // no signature covering the headers: no one click, whatever the server says
    expect(unsubscribeOffer(u, { dkimPass: ["list.example"] }, "\\Inbox")).toEqual({ method: "mail", target: "a@b.example" });
    expect(parseUnsubscribe(undefined)).toBeNull();
  });

  it("trusts one click only from a passing, covering, aligned DKIM signature", () => {
    const lines = (sig: string, url = "https://list.example/u") => [
      { key: "list-unsubscribe", line: `List-Unsubscribe: <mailto:leave@list.example>, <${url}>` },
      { key: "list-unsubscribe-post", line: "List-Unsubscribe-Post: List-Unsubscribe=One-Click" },
      { key: "dkim-signature", line: `DKIM-Signature: ${sig}` },
    ];
    const sig = "v=1; d=list.example; s=a;\r\n h=From : Subject:List-Unsubscribe:\r\n List-Unsubscribe-Post; b=abc";
    const u = parseUnsubscribe(lines(sig))!;
    expect(u.signatures).toEqual([{ d: "list.example", covers: true }]);
    const auth = (ar: string) => parseAuth(`mx.mine.example; ${ar}`, undefined);
    const oc = { method: "one-click", target: "list.example" };
    const mail = { method: "mail", target: "leave@list.example" };
    expect(unsubscribeOffer(u, auth("dkim=pass header.d=list.example"), "\\Inbox")).toEqual(oc);
    expect(unsubscribeOffer(u, auth("dkim=pass header.i=@list.example"), "\\Inbox")).toEqual(oc);
    // one signature, one pass without a domain: it is that signature
    expect(unsubscribeOffer(u, auth("dkim=pass"), "\\Inbox")).toEqual(oc);
    expect(unsubscribeOffer(u, auth("dkim=fail header.d=list.example"), "\\Inbox")).toEqual(mail);
    // the signature that passed is someone else's
    expect(unsubscribeOffer(u, auth("dkim=pass header.d=other.example; dkim=fail header.d=list.example"), "\\Inbox")).toEqual(mail);
    expect(unsubscribeOffer(u, auth("dkim=pass header.d=list.example"), "\\Junk")).toBeNull();
    // aligned with the sender instead of the address
    const onCdn = parseUnsubscribe(lines(sig, "https://cdn.mailer.example/u"))!;
    expect(unsubscribeOffer(onCdn, auth("dkim=pass header.d=list.example"), "\\Inbox", "news@mail.list.example")).toEqual({ method: "one-click", target: "cdn.mailer.example" });
    expect(unsubscribeOffer(onCdn, auth("dkim=pass header.d=list.example"), "\\Inbox", "news@elsewhere.example")).toEqual(mail);
    // a parent domain of the address does not count (list.example does not speak for example)
    const parent = parseUnsubscribe(lines(sig.replace("d=list.example", "d=sub.list.example")))!;
    expect(unsubscribeOffer(parent, auth("dkim=pass header.d=sub.list.example"), "\\Inbox")).toEqual(mail);
    expect(dkimSignature("DKIM-Signature: d=x.example; h=from:list-unsubscribe").covers).toBe(false);
  });

  it("mails a single address with nothing taken from the link", () => {
    expect(mailtoAddress("mailto:a@b.example?subject=x&cc=c@d.example")).toBe("a@b.example");
    expect(mailtoAddress("mailto:a@b.example,c@d.example")).toBe("a@b.example");
    expect(mailtoAddress("mailto:a%40b.example")).toBe("a@b.example");
    expect(mailtoAddress("mailto:%E0%A4%A@b.example")).toBeNull();
    expect(mailtoAddress("mailto:<a@b.example>")).toBeNull();
    expect(mailtoAddress(null)).toBeNull();
    expect(parseUnsubscribe([
      { key: "list-unsubscribe", line: "List-Unsubscribe: <http://list.example/u>" },
      { key: "list-unsubscribe-post", line: "List-Unsubscribe-Post: List-Unsubscribe=One-Click" },
    ])?.oneClick).toBe(false);
    expect(parseUnsubscribe([{ key: "list-unsubscribe", line: "List-Unsubscribe: <javascript:alert(1)>" }])).toBeNull();
  });
});
