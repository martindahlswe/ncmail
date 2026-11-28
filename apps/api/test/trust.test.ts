import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { user } from "./env.ts";
import { addAccount, api, deliver, messages, resetMailbox, syncFolder, type Acct } from "./helpers.ts";
import { domainWarnings, lev, parseAuth, skeleton } from "../src/phishing.ts";

/** Phishing cues, and the unified inbox. */
const U = user(32), U2 = user(31);
let acct: Acct, acct2: Acct;
let inbox = "";
const AR = (s: string) => ({ "Authentication-Results": `mx.example.test; ${s}` });
const warningsFor = async (subject: string) => {
  const m = (await messages(inbox)).find((x) => x.subject === subject);
  return (await api<any>(`/messages/${m.id}`)) as { warnings: { kind: string; level: string; message: string }[]; auth: any };
};

describe("the pieces", () => {
  it("reads Authentication-Results", () => {
    expect(parseAuth("mx.x; spf=pass smtp.mailfrom=a@b.com; dkim=pass header.d=b.com; dmarc=pass header.from=b.com", undefined))
      .toMatchObject({ spf: "pass", dkim: "pass", dmarc: "pass", fromDomain: "b.com", dkimDomain: "b.com", spfDomain: "b.com", present: true });
    expect(parseAuth(undefined, undefined).present).toBe(false);
    expect(parseAuth(undefined, "softfail (domain not designated)").spf).toBe("softfail");
  });
  it("measures similarity the way the eye does", () => {
    expect(lev("paypal", "paypa1")).toBe(1);
    expect(skeleton("rnicrosoft")).toBe(skeleton("microsoft"));
    expect(skeleton("g00gle")).toBe(skeleton("google"));
  });
  it("flags look-alike domains but not subdomains or the real thing", () => {
    const known = [{ domain: "paypal.com", weight: 1 }, { domain: "acmecorp.com", weight: 20 }];
    expect(domainWarnings("paypa1.com", known)).toHaveLength(1);
    expect(domainWarnings("paypal-support.net", known)).toHaveLength(1);
    expect(domainWarnings("paypa1-security.com", known)).toHaveLength(1);
    expect(domainWarnings("acrnecorp.com", known)).toHaveLength(1);
    expect(domainWarnings("mail.paypal.com", known)).toEqual([]);
    expect(domainWarnings("paypal.com", known)).toEqual([]);
    expect(domainWarnings("unrelated.org", known)).toEqual([]);
    // genuine senders that are close to a well-known name by chance, or that are the provider's own
    const withGmail = [...known, { domain: "gmail.com", weight: 1 }];
    expect(domainWarnings("mail.microsoft", withGmail)).toEqual([]);
    expect(domainWarnings("engage.mail.microsoft", withGmail)).toEqual([]);
    expect(domainWarnings("iverab.onmicrosoft.com", withGmail)).toEqual([]);
    expect(domainWarnings("mail.example.org", withGmail)).toEqual([]);
    expect(domainWarnings("gmai1.com", withGmail)).toHaveLength(1); // a real trick still gets caught
    expect(domainWarnings("xn--pypal-4ve.com", known)[0]!.message).toMatch(/unusual characters/);
  });
});

describe("cues on real messages", () => {
  beforeAll(async () => {
    await resetMailbox(U);
    await deliver(U, "INBOX", [
      { subject: "ok", from: "Fine <fine@good.example>", headers: AR("spf=pass smtp.mailfrom=good.example; dkim=pass header.d=good.example; dmarc=pass header.from=good.example") },
      { subject: "dmarc fail", from: "Boss <boss@good.example>", headers: AR("spf=fail smtp.mailfrom=evil.example; dkim=none; dmarc=fail header.from=good.example") },
      { subject: "spf fail", from: "X <x@good.example>", headers: AR("spf=fail; dkim=none") },
      { subject: "softfail", from: "X <x@good.example>", headers: AR("spf=softfail; dkim=none") },
      { subject: "no auth header", from: "Y <y@good.example>" },
      { subject: "third party signer", from: "News <news@engage.good.example>", headers: AR("spf=pass; dkim=pass header.d=tenant.onmicrosoft.com") },
      // you have heard from bigcompany.com several times
      ...[1, 2, 3].map((i) => ({ subject: `bc ${i}`, from: `Pat <pat@bigcompany.com>` })),
      { subject: "lookalike", from: "Pat <pat@blgcompany.com>" },
      { subject: "brand", from: "Support <help@paypa1.com>" },
      { subject: "spoofed name", from: '"ceo@bigcompany.com" <attacker@evil.example>' },
      { subject: "same name other address", from: "Pat Jones <pat.jones@gmail.example>" },
    ]);
    acct = await addAccount(U);
    inbox = (await acct.folder("INBOX")).id;
    await syncFolder(inbox);
    // you have written to Pat Jones, and to a friend
    await deliver(U, "Sent", [{ subject: "hi pat", from: U, to: "Pat Jones <pat.jones@work.example>" }, { subject: "hi friend", from: U, to: "Friend <friend@trusted.example>" }]);
    await syncFolder((await acct.folder("Sent")).id);
    await deliver(U, "INBOX", [{ subject: "from friend lookalike", from: "Friend <friend@trusted.example>" }]);
    await syncFolder(inbox);
  });
  it("says nothing about a message that passed every check", async () => {
    const r = await warningsFor("ok");
    expect(r.warnings).toEqual([]);
    expect(r.auth).toMatchObject({ spf: "pass", dkim: "pass", dmarc: "pass" });
  });
  it("warns strongly when DMARC fails, or SPF fails without a valid signature", async () => {
    expect((await warningsFor("dmarc fail")).warnings[0]).toMatchObject({ kind: "auth", level: "bad" });
    expect((await warningsFor("spf fail")).warnings[0]).toMatchObject({ kind: "auth", level: "bad" });
  });
  it("does not warn about a valid signature from another domain (Microsoft 365, mailing services)", async () => {
    expect((await warningsFor("third party signer")).warnings).toEqual([]);
  });
  it("warns mildly on softfail, and stays quiet when the server added no results", async () => {
    expect((await warningsFor("softfail")).warnings[0]).toMatchObject({ kind: "auth", level: "warn" });
    expect((await warningsFor("no auth header")).warnings).toEqual([]);
  });
  it("flags a domain that imitates one you correspond with, or a well-known brand", async () => {
    expect((await warningsFor("lookalike")).warnings.map((w) => w.kind)).toContain("lookalike");
    const b = await warningsFor("brand");
    expect(b.warnings[0]!.message).toContain("paypal.com");
  });
  it("flags a display name that contains another address", async () => {
    expect((await warningsFor("spoofed name")).warnings.map((w) => w.kind)).toContain("name-spoof");
  });
  it("flags a known person's name on an unknown address", async () => {
    const w = (await warningsFor("same name other address")).warnings.find((x) => x.kind === "impersonation");
    expect(w!.message).toContain("pat.jones@work.example");
  });
  it("does not second-guess people you have written to", async () => {
    expect((await warningsFor("from friend lookalike")).warnings).toEqual([]);
  });
});

afterAll(async () => { if (acct) await api(`/accounts/${acct.id}`, { method: "DELETE" }); });

describe("unified inbox", () => {
  beforeAll(async () => {
    await resetMailbox(U2);
    const old = (d: number) => new Date(Date.now() - d * 3600_000);
    await deliver(U, "INBOX", [{ subject: "u1 newest", date: old(1) }]);
    await deliver(U2, "INBOX", [{ subject: "u2 middle", date: old(2), seen: true }, { subject: "u2 old", date: old(30), flagged: true }]);
    acct2 = await addAccount(U2);
    await syncFolder(inbox); await syncFolder((await acct2.folder("INBOX")).id);
  });
  afterAll(async () => { if (acct2) await api(`/accounts/${acct2.id}`, { method: "DELETE" }); });

  it("merges every account's inbox by date, saying which account each message is in", async () => {
    const r = await api<any>("/unified/messages?limit=300");
    const mine = r.items.filter((i: any) => ["u1 newest", "u2 middle", "u2 old"].includes(i.subject));
    expect(mine.map((i: any) => i.subject)).toEqual(["u1 newest", "u2 middle", "u2 old"]);
    expect(mine[0]).toMatchObject({ accountId: acct.id, folderId: inbox, folderName: "INBOX" });
    expect(mine[1].accountId).toBe(acct2.id);
    expect(mine[1].accountName).toBe(`Test ${U2.split("@")[0]}`);
    const dates = r.items.map((i: any) => i.date);
    expect(dates).toEqual([...dates].sort().reverse());
  });
  it("filters and pages", async () => {
    const starred = (await api<any>("/unified/messages?filter=starred&limit=300")).items; // other test files share this server
    expect(starred.map((i: any) => i.subject)).toContain("u2 old");
    expect(starred.every((i: any) => i.flagged)).toBe(true);
    const unread = (await api<any>("/unified/messages?filter=unread&limit=300")).items.map((i: any) => i.subject);
    expect(unread).toContain("u1 newest"); expect(unread).not.toContain("u2 middle");
    const p1 = await api<any>("/unified/messages?limit=3");
    expect(p1.items).toHaveLength(3); expect(p1.next).toBeTruthy();
    const p2 = await api<any>(`/unified/messages?limit=3&cursor=${encodeURIComponent(JSON.stringify({ v: p1.next.v, id: p1.next.id }))}`);
    expect(p2.items.every((i: any) => !p1.items.some((x: any) => x.id === i.id))).toBe(true);
    expect(p2.items[0].date <= p1.items[2].date).toBe(true);
  });
});
