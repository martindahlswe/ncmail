import { connect, createServer, type Server, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IMAP_HOST, IMAP_PORT, TEST_PASSWORD, user } from "./env.ts";
import { addAccount, api, deliver, messages, syncFolder, waitFor, type Acct } from "./helpers.ts";

/**
 * Mail servers, firewalls and NAT boxes drop IMAP connections that have been quiet for a while, and the app only finds
 * out when it next uses one. A relay to the test server stands in for that: it cuts a connection when the app sends a
 * chosen command on it.
 */
const U = user(22);
let relay: Server;
const sockets: Socket[] = [];
let cutsLeft = 0;
let cutOn = / (SELECT|EXAMINE) /i; // which command gets its connection cut
let acct: Acct;
let inboxId: string;

beforeAll(async () => {
  relay = createServer((app) => {
    const server = connect(IMAP_PORT, IMAP_HOST);
    sockets.push(app, server);
    app.on("error", () => {}); server.on("error", () => {});
    server.pipe(app);
    app.on("data", (chunk) => {
      if (cutsLeft > 0 && cutOn.test(chunk.toString("latin1"))) { cutsLeft--; app.destroy(); server.destroy(); return; }
      server.write(chunk);
    });
    app.on("close", () => server.destroy());
    server.on("close", () => app.destroy());
  });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
  const port = (relay.address() as { port: number }).port;
  acct = await addAccount(U, { imap: { host: "127.0.0.1", port, security: "none", username: U, password: TEST_PASSWORD } });
  inboxId = (await acct.folders()).find((f) => f.specialUse === "\\Inbox").id;
});
afterAll(() => { for (const s of sockets) s.destroy(); relay?.close(); });

describe("a connection the mail server dropped", () => {
  it("does not stop a folder from syncing: it is tried again on a fresh connection", async () => {
    await deliver(U, "INBOX", { subject: "Arrived while the connection was dropped" });
    cutOn = / (SELECT|EXAMINE) /i; cutsLeft = 1; // dropped in the middle of a sync
    await syncFolder(inboxId);
    expect(cutsLeft).toBe(0); // the connection really was cut
    expect((await api(`/folders/${inboxId}`)).syncError).toBeNull();
    expect((await messages(inboxId)).map((m) => m.subject)).toContain("Arrived while the connection was dropped");
  });

  it("checks a kept connection before using it, so one dropped while idle is replaced", async () => {
    await deliver(U, "INBOX", { subject: "Second arrival" });
    cutOn = /^\S+ [A-Z]/; cutsLeft = 1; // whatever the app sends next on a kept connection
    await api(`/accounts/${acct.id}/sync`, { method: "POST" });
    await waitFor(async () => (await messages(inboxId)).some((m) => m.subject === "Second arrival"), { what: "the new message" });
    expect(cutsLeft).toBe(0);
    expect((await api(`/folders/${inboxId}`)).syncError).toBeNull();
  });
});
