import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { user } from "./env.ts";
import { addAccount, api, deliver, resetMailbox, syncFolder, waitFor, type Acct, type Msg } from "./helpers.ts";

const U = user(14);
let acct: Acct;
let inbox: any;
let minute = 0;
const m = (o: Msg): Msg => ({ date: new Date(Date.UTC(2026, 4, 1, 8, minute++)), ...o });

const search = async (q: string, extra = "") => api(`/accounts/${acct.id}/search?q=${encodeURIComponent(q)}${extra}`);
const subjects = async (q: string, extra = "") => ((await search(q, extra)).items as any[]).map((i) => i.subject).sort();

beforeAll(async () => {
  await resetMailbox(U);
  await deliver(U, "INBOX", [
    m({ subject: "Quarterly report", from: "Ada Lovelace <ada@example.org>", attachments: [{ filename: "notes.txt", content: "x" }] }),
    m({ subject: "Lunch plans", from: "Grace Hopper <grace@example.org>", seen: true }),
    m({ subject: "Invoice 100% paid", from: "Linus T <linus@example.org>", flagged: true }),
    m({ subject: "Weekly digest", from: "Zoë Ünïcode <zoe@example.org>" }),
    m({ subject: "Plain body", from: "Body Tester <bt@example.org>", text: "The secret word is zebrafish and nothing else." }),
    m({ subject: "HTML only", from: "Body Tester <bt@example.org>", text: "", html: "<div><p>Our <b>quarterly invoice</b> for the platform.</p><style>.x{color:red}</style></div>" }),
    m({ subject: "Swedish", from: "Body Tester <bt@example.org>", text: "Hej Åsa, fakturan från Öberg är betald." }),
    m({ subject: "With attachment", from: "Body Tester <bt@example.org>", text: "See attached.", attachments: [{ filename: "budget-2027-final.xlsx", content: "x" }] }),
  ]);
  await deliver(U, "Sent", m({ subject: "Sent note", from: "Me <u14@example.test>", text: "kingfisher migration plan", seen: true }));
  await deliver(U, "Junk", m({ subject: "Spam", from: "Spammer <spam@example.org>", text: "cheap zebrafish pills" }));
  acct = await addAccount(U);
  inbox = await acct.folder("INBOX");
  await syncFolder(inbox.id);
  await syncFolder((await acct.folder("Sent")).id);
  await syncFolder((await acct.folder("Junk")).id);
});
afterAll(async () => { if (acct) await api(`/accounts/${acct.id}`, { method: "DELETE" }); });

describe("header search and operators", () => {
  it("matches substrings of sender, recipient and subject, ignoring case and accents-as-typed", async () => {
    expect(await subjects("lovelace")).toEqual(["Quarterly report"]);
    expect(await subjects("ünï")).toEqual(["Weekly digest"]);
    expect(await subjects("LUNCH")).toEqual(["Lunch plans"]);
  });

  it("supports from:, subject:, has:attachment, is:unread / is:read / is:starred", async () => {
    expect(await subjects("from:grace")).toEqual(["Lunch plans"]);
    expect(await subjects("subject:digest")).toEqual(["Weekly digest"]);
    expect(await subjects("from:LOVELACE")).toEqual(["Quarterly report"]);
    expect(await subjects("from:zoë")).toEqual(["Weekly digest"]);
    expect(await subjects("-from:grace")).not.toContain("Lunch plans");
    expect(await subjects("-subject:digest")).not.toContain("Weekly digest");
    expect(await subjects("-subject:digest")).toContain("Lunch plans");
    expect((await subjects("has:attachment")).sort()).toEqual(["Quarterly report", "With attachment"]);
    expect(await subjects("is:starred")).toEqual(["Invoice 100% paid"]);
    expect(await subjects("is:read")).toEqual(expect.arrayContaining(["Lunch plans", "Sent note"]));
    expect(await subjects("is:unread from:ada")).toEqual(["Quarterly report"]);
  });

  it("combines operators with AND and supports exclusion", async () => {
    expect(await subjects("from:body has:attachment")).toEqual(["With attachment"]);
    expect(await subjects("from:body -attachment")).not.toContain("With attachment");
    expect(await subjects("from:body -attachment")).toContain("Plain body");
  });

  it("treats % and _ literally and does not break on odd input", async () => {
    expect(await subjects("100%")).toEqual(["Invoice 100% paid"]);
    expect(await subjects("a_b")).toEqual([]);
    expect(await subjects("'; drop table messages; --")).toEqual([]);
    expect((await search("before:soon")).notes[0]).toMatch(/needs a date/);
  });

  it("filters by date", async () => {
    expect((await subjects("before:2026-05-01")).length).toBe(0);
    expect((await subjects("after:2026-05-01 from:ada"))).toEqual(["Quarterly report"]);
  });

  it("searches all folders except Junk and Trash by default, and in:sent finds Sent", async () => {
    expect(await subjects("note")).toEqual(["Sent note"]);
    expect(await subjects("spam")).toEqual([]);
    expect(await subjects("in:junk spam")).toEqual(["Spam"]);
    expect(await subjects("in:sent")).toEqual(["Sent note"]);
  });

  it("can be limited to one folder", async () => {
    expect(await subjects("report", `&scope=folder&folderId=${inbox.id}`)).toEqual(["Quarterly report"]);
    expect(await subjects("note", `&scope=folder&folderId=${inbox.id}`)).toEqual([]);
  });

  it("pages through results", async () => {
    const first = await search("example.org", "&limit=3");
    expect(first.items).toHaveLength(3);
    expect(first.next).toBeTruthy();
    const second = await search("example.org", `&limit=3&beforeDate=${encodeURIComponent(first.next.date)}&beforeId=${first.next.id}`);
    const ids = new Set([...first.items, ...second.items].map((i: any) => i.id));
    expect(ids.size).toBe(first.items.length + second.items.length);
  });
});

describe("message text", () => {
  it("is invisible to local search until the body index is on", async () => {
    expect(await subjects("zebrafish")).toEqual([]);
  });

  it("can be searched by asking the mail server", async () => {
    expect(await subjects("zebrafish", "&text=1")).toEqual(["Plain body"]);
    expect(await subjects("kingfisher", "&text=1")).toEqual(["Sent note"]);
    expect(await subjects("zebrafish from:nobody", "&text=1")).toEqual([]);
  });

  describe("local body index (opt-in)", () => {
    it("is off by default and reports its progress", async () => {
      const st = await api(`/accounts/${acct.id}/index`);
      expect(st.enabled).toBe(false);
      expect(st.indexed).toBe(0);
      expect(st.total).toBe(9); // Junk is not part of the index
    });

    it("indexes every message without marking anything as read", async () => {
      const unseenBefore = (await acct.folder("INBOX")).unseen;
      await api(`/accounts/${acct.id}/index`, { method: "PATCH", body: { enabled: true } });
      await waitFor(async () => { const s = await api(`/accounts/${acct.id}/index`); return s.indexed === s.total && !s.running; }, { what: "index to finish" });
      await syncFolder(inbox.id);
      expect((await acct.folder("INBOX")).unseen).toBe(unseenBefore);
    });

    it("finds words, word prefixes and phrases inside plain and HTML bodies", async () => {
      expect(await subjects("zebrafish")).toEqual(["Plain body"]);
      expect(await subjects("zebra")).toEqual(["Plain body"]);
      expect(await subjects("platform")).toEqual(["HTML only"]);
      expect(await subjects('"quarterly invoice"')).toEqual(["HTML only"]);
      expect(await subjects('"invoice quarterly"')).toEqual([]);
    });

    it("handles accents and case, attachment names, and other folders", async () => {
      expect(await subjects("FAKTURAN")).toEqual(["Swedish"]);
      expect(await subjects("åsa")).toEqual(["Swedish"]);
      expect(await subjects("budget")).toEqual(["With attachment"]);
      expect(await subjects("kingfisher")).toEqual(["Sent note"]);
    });

    it("does not index CSS from HTML mail, or Junk", async () => {
      expect(await subjects("color:red")).toEqual([]);
      expect(await subjects("cheap")).toEqual([]);
    });

    it("combines with operators and negation", async () => {
      expect(await subjects("zebrafish from:body")).toEqual(["Plain body"]);
      expect(await subjects("zebrafish from:nobody")).toEqual([]);
      expect(await subjects("from:body -zebrafish")).not.toContain("Plain body");
    });

    it("indexes new mail automatically", async () => {
      await deliver(U, "INBOX", m({ subject: "Fresh", text: "the codename is narwhal-rocket" }));
      await waitFor(async () => (await subjects("narwhal")).length === 1, { timeout: 25_000, what: "new mail to be indexed" });
    });

    it("removes the index when turned off, and can rebuild it", async () => {
      await api(`/accounts/${acct.id}/index`, { method: "PATCH", body: { enabled: false } });
      expect(await subjects("zebrafish")).toEqual([]);
      expect((await api(`/accounts/${acct.id}/index`)).indexed).toBe(0);
      await api(`/accounts/${acct.id}/index`, { method: "PATCH", body: { enabled: true } });
      await waitFor(async () => (await subjects("zebrafish")).length === 1, { what: "index to rebuild" });
    });
  });
});
