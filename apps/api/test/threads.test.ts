import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { user } from "./env.ts";
import { addAccount, api, deliver, resetMailbox, syncFolder, type Acct, type Msg } from "./helpers.ts";

const U = user(13);
let acct: Acct;
let inbox: any;
let minute = 0;
const msg = (id: string | null, subject: string, o: Partial<Msg> & { irt?: string; refs?: string[] } = {}): Msg => ({
  subject, messageId: id ? `<${id}@t>` : undefined, inReplyTo: o.irt ? `<${o.irt}@t>` : undefined,
  references: o.refs?.map((r) => `<${r}@t>`), from: o.from ?? "Someone <someone@example.org>", date: new Date(Date.UTC(2026, 3, 1, 9, minute++)),
});

const conversations = async () => (await api(`/folders/${inbox.id}/messages?threads=1&limit=100`)).items as any[];
const byHead = async (subject: string) => (await conversations()).find((c) => c.subject === subject);

beforeAll(async () => {
  await resetMailbox(U);
  await deliver(U, "INBOX", [
    msg("a1", "Project kickoff", { from: "Alice <alice@example.org>" }),
    msg("b1", "Re: Project kickoff", { irt: "a1", refs: ["a1"], from: "Bob <bob@example.org>" }),
    msg("c1", "Re: Project kickoff", { irt: "b1", refs: ["a1", "b1"], from: "Carol <carol@example.org>" }),
    msg("d1", "Lunch on Friday?", { from: "Dan <dan@example.org>" }),
    msg("e1", "Re: Parent we never got", { irt: "x1", refs: ["x1"], from: "Eve <eve@example.org>" }),
    msg("f1", "Re: Parent we never got", { irt: "x1", refs: ["x1"], from: "Frank <frank@example.org>" }),
    msg("p1", "Topic P", { from: "Pat <pat@example.org>" }),
    msg("q1", "Topic Q", { from: "Quinn <quinn@example.org>" }),
    msg("p2", "Re: Topic P", { irt: "p1", refs: ["p1"], from: "Pat <pat@example.org>" }),
    msg("q2", "Re: Topic Q", { irt: "q1", refs: ["q1"], from: "Quinn <quinn@example.org>" }),
  ]);
  acct = await addAccount(U);
  inbox = await acct.folder("INBOX");
  await syncFolder(inbox.id);
});
afterAll(async () => { if (acct) await api(`/accounts/${acct.id}`, { method: "DELETE" }); });

describe("grouping by Message-ID / In-Reply-To / References", () => {
  it("groups replies into conversations", async () => {
    const list = await conversations();
    expect(list).toHaveLength(5);
    const kickoff = list.find((c) => c.subject === "Re: Project kickoff")!;
    expect(kickoff.count).toBe(3);
    expect(kickoff.names.sort()).toEqual(["Alice", "Bob", "Carol"]);
    expect((await byHead("Lunch on Friday?")).count).toBe(1);
  });

  it("groups siblings whose common parent was never received", async () => {
    const c = await byHead("Re: Parent we never got");
    expect(c.count).toBe(2);
    expect(c.names.sort()).toEqual(["Eve", "Frank"]);
  });

  it("shows the newest message of a conversation as its row, with unread counts", async () => {
    const c = await byHead("Re: Topic Q");
    expect(c).toMatchObject({ count: 2, unseenCount: 2, seen: false });
  });

  it("returns a conversation's messages oldest first", async () => {
    const kickoff = (await conversations()).find((c) => c.subject === "Re: Project kickoff")!;
    const msgs = await api(`/threads/${kickoff.threadId}?folderId=${inbox.id}`);
    expect(msgs.map((m: any) => m.fromName)).toEqual(["Alice", "Bob", "Carol"]);
  });

  it("filters conversations to those with unread messages", async () => {
    await deliver(U, "INBOX", { ...msg("seen1", "All read thread"), seen: true });
    await syncFolder(inbox.id);
    const unread = (await api(`/folders/${inbox.id}/messages?threads=1&unread=1&limit=100`)).items as any[];
    expect(unread.some((c) => c.subject === "All read thread")).toBe(false);
    expect(unread.some((c) => c.subject === "Lunch on Friday?")).toBe(true);
  });
});

describe("later messages that connect earlier threads", () => {
  it("merges two threads when one message references both", async () => {
    await deliver(U, "INBOX", msg("r1", "Topics P and Q together", { irt: "q2", refs: ["p2", "q2"], from: "Rita <rita@example.org>" }));
    await syncFolder(inbox.id);
    const merged = await byHead("Topics P and Q together");
    expect(merged.count).toBe(5); // p1 p2 q1 q2 r1
    expect(merged.names.sort()).toEqual(["Pat", "Quinn", "Rita"]);
    expect(await byHead("Re: Topic P")).toBeUndefined();
    expect(await byHead("Re: Topic Q")).toBeUndefined();
  });

  it("joins your own reply in Sent to the conversation it answers", async () => {
    await deliver(U, "Sent", { ...msg("s1", "Re: Project kickoff", { irt: "c1", refs: ["a1", "b1", "c1"], from: "Me <u13@example.test>" }), seen: true });
    const sent = await acct.folder("Sent");
    await syncFolder(sent.id);
    const kickoff = (await conversations()).find((c) => c.subject === "Re: Project kickoff")!;
    expect(kickoff.count).toBe(4);
    const msgs = await api(`/threads/${kickoff.threadId}?folderId=${inbox.id}`);
    expect(msgs.map((m: any) => m.folderName).sort()).toEqual(["INBOX", "INBOX", "INBOX", "Sent"]);
  });

  it("keeps a message with no threading headers on its own", async () => {
    await deliver(U, "INBOX", msg(null, "No headers at all"));
    await syncFolder(inbox.id);
    expect((await byHead("No headers at all")).count).toBe(1);
  });

  it("does not count Trash toward a conversation unless you are looking at it", async () => {
    const trash = await acct.folder("Trash");
    await deliver(U, "Trash", msg("t1", "Re: Lunch on Friday?", { irt: "d1", refs: ["d1"] }));
    await syncFolder(trash.id);
    expect((await byHead("Lunch on Friday?")).count).toBe(1);
  });
});

describe("grouping mail without reply headers by subject", () => {
  const count = async (subject: string) => (await conversations()).filter((c) => (c.subject as string).replace(/^(re|aw|fwd?):\s*/i, "") === subject).map((c) => c.count);

  it("joins a reply without reply headers to its original, delivered together or later", async () => {
    // together, in one sync (the newest-first sync often sees the reply before the original)
    await deliver(U, "INBOX", [
      msg("subj-s1", "Quarterly budget review", { from: "Grace <grace@example.org>" }),
      msg("subj-s2", "Re: Quarterly budget review", { from: "Grace <grace@example.org>" }),
    ]);
    await syncFolder(inbox.id);
    expect(await count("Quarterly budget review")).toEqual([2]);
    // later, in a sync of its own
    await deliver(U, "INBOX", msg("subj-s3", "AW: Quarterly budget review", { from: "Grace <grace@example.org>" }));
    await syncFolder(inbox.id);
    expect(await count("Quarterly budget review")).toEqual([3]);
  });

  it("keeps apart generic subjects, other people, mail months apart, and two originals with the same subject", async () => {
    await deliver(U, "INBOX", [
      msg("subj-g1", "Hello", { from: "Heidi <heidi@example.org>" }),
      msg("subj-g2", "Re: Hello", { from: "Heidi <heidi@example.org>" }),
      msg("subj-o1", "Server migration plan", { from: "Ivan <ivan@example.org>" }),
      msg("subj-o2", "Re: Server migration plan", { from: "Judy <judy@example.org>" }),
      { ...msg("subj-t1", "Office relocation details", { from: "Ken <ken@example.org>" }), date: new Date(Date.UTC(2025, 0, 10)) },
      { ...msg("subj-t2", "Re: Office relocation details", { from: "Ken <ken@example.org>" }), date: new Date(Date.UTC(2026, 3, 1)) },
      msg("subj-n1", "Weekly sales figures", { from: "Liam <liam@example.org>" }),
      msg("subj-n2", "Weekly sales figures", { from: "Liam <liam@example.org>" }),
    ]);
    await syncFolder(inbox.id);
    expect(await count("Hello")).toEqual([1, 1]);
    expect(await count("Server migration plan")).toEqual([1, 1]);
    expect(await count("Office relocation details")).toEqual([1, 1]);
    expect(await count("Weekly sales figures")).toEqual([1, 1]);
  });
});
