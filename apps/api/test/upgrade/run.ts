/**
 * Upgrade test: the previous release's container image builds up real data, then the new image takes over the same
 * database and must keep all of it and keep working.
 *
 *   pnpm test:up && docker build -t ncmail:upgrade-new . && pnpm test:upgrade
 *
 * OLD_IMAGE defaults to the latest published release on GHCR, NEW_IMAGE to ncmail:upgrade-new. Both containers join the
 * test stack's Docker network (ncmail-test_default) and reach its PostgreSQL, Dovecot and Mailpit by service name; this
 * script seeds mail and checks results through the ports the test stack publishes on 127.0.0.1.
 */
import { execFileSync } from "node:child_process";
import pg from "pg";

const PORT = Number(process.env.UPGRADE_PORT ?? 4300);
const API = `http://127.0.0.1:${PORT}`;
process.env.TEST_API_URL = API; // the shared helpers' api() talks to the container under test
const { api, deliver, resetMailbox, waitFor, mailpit } = await import("../helpers.ts");
const { user } = await import("../env.ts");
const { testNextcloud } = await import("../handoff.ts");
const ncs = testNextcloud(); // signs the server-to-server calls Nextcloud makes (the admin Mail page goes through these)
/** A call signed as the Nextcloud app signs it. */
async function signed<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const sg = ncs.signed(method, path, body, `127.0.0.1:${PORT}`);
  const r = await fetch(`${API}${path}`, { method, headers: sg.headers, body: sg.body });
  if (!r.ok) fail(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

const U = user(6); // a test-stack user no other test uses
const NETWORK = process.env.UPGRADE_NETWORK ?? "ncmail-test_default";
const DB = "ncmail_upgrade";
const NAME = "ncmail-upgrade";
const SECRET = Buffer.alloc(32, 9).toString("base64"); // the same key for both versions, as in a real upgrade
const NEW_IMAGE = process.env.NEW_IMAGE ?? "ncmail:upgrade-new";

const log = (...a: unknown[]) => console.log("[upgrade]", ...a);
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const fail = (msg: string): never => { throw new Error(msg); };

/** The latest published release (not a draft, not a stray tag without an image); null before the first release. */
async function latestRelease(): Promise<string | null> {
  const r = await fetch("https://api.github.com/repos/martindahlswe/ncmail/releases/latest", { headers: { accept: "application/vnd.github+json", ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } });
  if (r.status === 404) return null;
  if (!r.ok) fail(`Could not find the latest release (${r.status}); set OLD_IMAGE`);
  return ((await r.json()) as { tag_name: string }).tag_name.replace(/^v/, "");
}

async function freshDatabase() {
  const c = new pg.Client({ connectionString: "postgres://ncmail:ncmail@127.0.0.1:15432/ncmail_test" });
  await c.connect();
  try {
    await c.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1`, [DB]);
    await c.query(`drop database if exists ${DB}`);
    await c.query(`create database ${DB}`);
  } finally { await c.end(); }
}

function stop() { try { docker("rm", "-f", NAME); } catch { /* not running */ } }

async function start(image: string): Promise<string> {
  stop();
  docker("run", "-d", "--name", NAME, "--network", NETWORK, "-p", `127.0.0.1:${PORT}:4000`,
    "-e", `DATABASE_URL=postgres://ncmail:ncmail@postgres:5432/${DB}`, "-e", `SECRET_KEY=${SECRET}`,
    "-e", "NCMAIL_AUTH=off", "-e", "NCMAIL_PRIVATE_HOSTS=allow", "-e", "NCMAIL_SERVER_CHECK_HOURS=0",
    "-e", `NCMAIL_HANDOFF_PUBLIC_KEY=${ncs.publicKey}`, image);
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(`${API}/api/health`); if (r.ok) return ((await r.json()) as { version: string }).version; } catch { /* starting */ }
    if (Date.now() - t0 > 90_000) { console.error(docker("logs", "--tail", "80", NAME)); fail(`${image} did not start`); }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Everything a user built up, as the API shows it. Sorted, so two snapshots compare equal when nothing was lost. */
async function snapshot() {
  const accounts = await api<any[]>("/accounts");
  const out: Record<string, unknown> = { accounts: accounts.map((a) => ({ name: a.name, email: a.email, imap: a.imap?.host, smtp: a.smtp?.host })) };
  for (const a of accounts) {
    const folders = await api<any[]>(`/accounts/${a.id}/folders`);
    const inbox = folders.find((f) => f.specialUse === "\\Inbox");
    const msgs = (await api<{ items: any[] }>(`/folders/${inbox.id}/messages?threads=0&limit=100`)).items;
    out[a.email] = {
      folders: folders.map((f) => f.path).sort(),
      inbox: msgs.map((m) => `${m.subject}|${m.seen ? "read" : "unread"}|${m.flagged ? "starred" : ""}|${(m.labels ?? []).join(",")}`).sort(),
      identities: (await api<any[]>(`/accounts/${a.id}/identities`)).map((i) => `${i.name} <${i.email}>`).sort(),
      labels: (await api<any[]>(`/accounts/${a.id}/labels`)).map((l) => l.name).sort(),
      savedSearches: (await api<any[]>(`/accounts/${a.id}/saved-searches`)).map((s) => `${s.name}: ${s.query}`).sort(),
      syncWindow: (await api<any>(`/accounts/${a.id}/sync-window`)).months,
    };
  }
  out.templates = (await api<any[]>("/templates")).map((t) => t.name).sort();
  out.imageSenders = (await api<any>("/image-senders")).senders ?? (await api<any>("/image-senders"));
  out.outbox = (await api<any[]>("/outbox")).map((o) => o.subject).sort();
  const servers = (await signed<any>("GET", "/api/internal/mail-servers")).admin;
  out.mailServers = { allowCustom: servers.allowCustom, servers: servers.servers.map((x: any) => `${x.name}: ${x.imap.host}:${x.imap.port} ${x.smtp.host}:${x.smtp.port} ${x.domains.join(",")}`).sort() };
  const prefs = await api<any>("/prefs");
  out.prefs = { readReceipts: prefs.readReceipts, notifyNewMail: prefs.notifyNewMail };
  return out;
}

async function main() {
  const previous = process.env.OLD_IMAGE ? null : await latestRelease();
  if (!process.env.OLD_IMAGE && !previous) { log("no release is published yet, so there is nothing to upgrade from"); return; }
  const oldImage = process.env.OLD_IMAGE ?? `ghcr.io/martindahlswe/ncmail:${previous}`;
  log(`from ${oldImage} to ${NEW_IMAGE}`);
  docker("pull", "--quiet", oldImage);
  await freshDatabase();
  await resetMailbox(U);
  const base = new Date("2026-11-01T09:00:00Z").getTime();
  await deliver(U, "INBOX", Array.from({ length: 6 }, (_, i) => ({ subject: `Before the upgrade ${i + 1}`, from: `Sender ${i} <s${i}@example.org>`, text: `Message ${i + 1}`, date: new Date(base + i * 3_600_000), seen: i % 2 === 0, flagged: i === 1 })));

  // ---- the old version builds up data ----
  const oldVersion = await start(oldImage);
  log(`old version ${oldVersion} is up`);
  const acct = await api<any>("/accounts", { body: {
    name: "Upgrade test", email: U,
    imap: { host: "dovecot", port: 143, security: "none", username: U, password: "test" },
    smtp: { host: "mailpit", port: 1025, security: "none", username: U, password: "test" },
  } });
  await api(`/accounts/${acct.id}/sync`, { method: "POST" });
  const inboxOf = async () => (await api<any[]>(`/accounts/${acct.id}/folders`)).find((f) => f.specialUse === "\\Inbox");
  await waitFor(async () => { const f = await inboxOf(); return f && (await api<{ items: any[] }>(`/folders/${f.id}/messages?threads=0`)).items.length === 6; }, { timeout: 60_000, what: "the inbox to mirror under the old version" });
  const inbox = await inboxOf();
  const first = (await api<{ items: any[] }>(`/folders/${inbox.id}/messages?threads=0`)).items.find((m) => m.subject === "Before the upgrade 3");
  await api(`/accounts/${acct.id}/identities`, { body: { name: "Alias", email: `alias-${U}` } });
  await api(`/accounts/${acct.id}/labels`, { body: { name: "Big Client" } });
  const label = (await api<any[]>(`/accounts/${acct.id}/labels`))[0];
  await api("/messages/bulk", { body: { action: "label", label: label.slug, messageIds: [first.id] } }).catch(() => log("(labelling a message is not available in the old version)"));
  await api(`/accounts/${acct.id}/saved-searches`, { body: { name: "Unread", query: "is:unread" } });
  await api(`/accounts/${acct.id}/sync-window`, { method: "PUT", body: { months: 12 } });
  await api("/templates", { body: { name: "Thanks", subject: "Thank you", html: "<p>Thanks for your message.</p>" } });
  await api("/image-senders", { body: { sender: "news@example.org" } });
  await api("/prefs", { method: "PATCH", body: { readReceipts: "never" } });
  // mail servers an administrator set up in Nextcloud's admin settings
  await signed("POST", "/api/internal/mail-servers", { uid: "admin", config: { allowCustom: false, servers: [
    { id: "srv-corp", name: "Company mail", domains: ["example.com"], username: "email", imap: { host: "imap.example.com", port: 993, security: "tls" }, smtp: { host: "smtp.example.com", port: 465, security: "tls" } },
  ] } });
  await api(`/accounts/${acct.id}/send`, { body: { to: ["friend@example.org"], subject: "Scheduled across the upgrade", text: "Sent later.", sendAt: new Date(Date.now() + 30 * 86_400_000).toISOString() } });
  const before = await snapshot();
  log("data before:", JSON.stringify(before));

  // ---- the new version takes over the same database ----
  const newVersion = await start(NEW_IMAGE);
  log(`new version ${newVersion} is up`);
  const after = await snapshot();
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    console.error("before:", JSON.stringify(before, null, 2));
    console.error("after: ", JSON.stringify(after, null, 2));
    fail("Data changed across the upgrade");
  }
  log("all data is still there");

  // ...and it keeps working: new mail syncs, a message opens, sending goes out
  await deliver(U, "INBOX", { subject: "After the upgrade", from: "Later <later@example.org>", text: "New mail after the upgrade." });
  await api(`/folders/${inbox.id}/sync`, { method: "POST" });
  await waitFor(async () => (await api<{ items: any[] }>(`/folders/${inbox.id}/messages?threads=0`)).items.some((m) => m.subject === "After the upgrade"), { timeout: 60_000, what: "new mail after the upgrade" });
  const opened = await api<any>(`/messages/${first.id}`);
  if (!String(opened.text ?? opened.html ?? "").includes("Message 3")) fail("An old message did not open after the upgrade");
  const subject = `Sent after the upgrade ${Date.now().toString(36)}`;
  await api(`/accounts/${acct.id}/send`, { body: { to: ["friend@example.org"], subject, text: "Hello." } });
  await mailpit.bySubject(subject); // waits until the test SMTP server has it
  log(`upgrade from ${oldVersion} to ${newVersion} kept everything and works`);
}

try { await main(); }
catch (e) {
  console.error("[upgrade] FAILED:", (e as Error).message);
  try { console.error(docker("logs", "--tail", "60", NAME)); } catch { /* no container */ }
  process.exitCode = 1;
} finally { stop(); }
