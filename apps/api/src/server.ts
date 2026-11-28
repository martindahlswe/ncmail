import Fastify from "fastify";
import cors from "@fastify/cors";
import compress from "@fastify/compress";
import etag from "@fastify/etag";
import fastifyStatic from "@fastify/static";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { accountInputSchema, accountUpdateSchema, testInputSchema, type AccountSummary, type Identity } from "@ncmail/shared";
import { checkAgainstPresets, loadAdminPresets, presetRoutes, startAdminPresetRefresh } from "./presets.ts";
import { internalRoutes } from "./internal.ts";
import { MIN_APP_VERSION, SERVICE_VERSION } from "./compat.ts";
import { startServerChecks } from "./serverchecks.ts";
import { startHeartbeat } from "./instances.ts";
import { countRequests, startMetrics } from "./metrics.ts";
import { bgPool, migrate, pool, retryOnDeadlock } from "./db.ts";
import { encrypt } from "./crypto.ts";
import { testConnections } from "./mail.ts";
import { themeRoutes } from "./theme.ts";
import { mailRoutes } from "./routes.ts";
import { identityRoutes, identityOut } from "./identities.ts";
import { prefsRoutes } from "./prefs.ts";
import { templateRoutes } from "./templates.ts";
import { unsubscribeRoutes } from "./unsubscribe.ts";
import { receiptRoutes } from "./receipts.ts";
import { imageSenderRoutes } from "./imagesenders.ts";
import { aclRoutes } from "./aclRoutes.ts";
import { folderRoutes } from "./folderRoutes.ts";
import { integrationRoutes } from "./nextcloud/integrations.ts";
import { draftRoutes } from "./drafts.ts";
import { indexRoutes, startBodyIndexer } from "./bodyindex.ts";
import { bulkRoutes } from "./bulk.ts";
import { eventRoutes } from "./events.ts";
import { backfillThreads } from "./threads.ts";
import { backfillSearchText, searchRoutes } from "./search.ts";
import { backfillContacts, contactRoutes } from "./contacts.ts";
import { uploadRoutes } from "./uploads.ts";
import { outboxRoutes, startOutbox } from "./outbox.ts";
import { undoRoutes } from "./undo.ts";
import { secureRoutes } from "./secure/routes.ts";
import { calendarRoutes, startCalendarSync } from "./calendar/auto.ts";
import { idleStatus, isIdleHealthy, reconcileIdle, restartIdle, startIdle } from "./idle.ts";
import { loadAccount } from "./accounts.ts";
import { checkAuthConfig, installAuth, isApiRequest, trustProxySetting } from "./auth.ts";
import { keyFetchAllowed } from "./handoff.ts";
import { guardHost, requireTls } from "./netguard.ts";
import { labelRoutes } from "./labels.ts";
import { sieveRoutes } from "./sieve/routes.ts";
import { unifiedRoutes } from "./unified.ts";
import { startSnooze } from "./snooze.ts";
import { ncRoutes } from "./nextcloud/link.ts";
import { contactRoutesNc } from "./nextcloud/contacts.ts";
import { filesRoutes } from "./nextcloud/files.ts";
import { syncAccount } from "./sync.ts";
import { startBackgroundSync } from "./sync.ts";
import { describeImapError, isImapRefusal, serverText } from "./imapError.ts";
import { isConnectionLost } from "./mail.ts";

// Refuse to start with sign-in settings that would leave the API open by accident (see checkAuthConfig).
const authMode = checkAuthConfig();

const app = Fastify({
  // Request logs keep the path but not the query string (search terms, cursors are personal).
  logger: { level: "info", serializers: { req: (req: any) => ({ method: req.method, url: String(req.url).split("?")[0], host: req.host }) } },
  bodyLimit: 12 * 1024 * 1024, // JSON bodies; uploads stream through multipart with their own limit
  trustProxy: trustProxySetting(), // NCMAIL_TRUST_PROXY: hops or proxy addresses
});
// No cross-origin access: the app is served from the same origin as the API (the Nextcloud app embeds it in a frame, which needs no CORS).
await app.register(cors, { origin: false });
// Smaller responses (JSON lists compress about 4x) and cheap revalidation: unchanged lists answer 304 with no body.
await app.register(compress, { global: true, threshold: 1024 });
await app.register(etag);
// Only this site and the configured Nextcloud may put the app in a frame (the Nextcloud app embeds it).
const frameAncestors = `frame-ancestors 'self'${process.env.NEXTCLOUD_URL ? ` ${new URL(process.env.NEXTCLOUD_URL).origin}` : ""}`;
// Scripts only from this site. Styles may be inline (the app and the mail view use them); images may come from anywhere because the mail
// view (a sandboxed frame that inherits this policy) shows remote images when the user allows them; mail itself never runs scripts.
const CSP = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob: data:; object-src 'none'; base-uri 'none'; form-action 'self'; ${frameAncestors}`;
app.addHook("onSend", async (req, reply, payload) => {
  reply.header("x-content-type-options", "nosniff");
  reply.header("referrer-policy", "same-origin");
  // Decided from the matched route (and the content type), not the raw request target.
  const api = isApiRequest(req);
  const markup = /html|xml/i.test(String(reply.getHeader("content-type") ?? ""));
  if (!api || (markup && !reply.hasHeader("content-security-policy"))) reply.header("content-security-policy", CSP);
  if (api && !reply.hasHeader("cache-control")) reply.header("cache-control", "no-cache"); // always revalidate, but via ETag
  return payload;
});
// Be lenient with clients that send content-type: application/json and no body (e.g. trigger endpoints).
app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
  (_req as any).rawBody = body; // signed requests from Nextcloud are checked against the exact bytes
  try { done(null, body === "" ? undefined : JSON.parse(body as string)); } catch (e: any) { e.statusCode = 400; done(e); }
});

app.setErrorHandler((err: any, _req, reply) => {
  if (err?.issues) return reply.code(400).send({ error: "Invalid input", issues: err.issues });
  if (err?.code === "57014") { // Postgres cancelled the statement (NCMAIL_STATEMENT_TIMEOUT_MS)
    app.log.warn({ err: err.message }, "database statement timed out");
    return reply.code(503).send({ error: "This took too long. Try again, or narrow it down (for a search: a sender, a folder or a date)." });
  }
  // the mail server refused, or the connection to it dropped: say why in plain words (not "Something went wrong")
  if (!(Number(err?.statusCode) >= 400) && (isImapRefusal(err) || isConnectionLost(err))) {
    app.log.warn({ err: err.message, server: serverText(err), code: err.serverResponseCode }, "the mail server refused a request");
    return reply.code(isConnectionLost(err) ? 503 : 502).send({ error: describeImapError(err) });
  }
  const code = Number(err?.statusCode) >= 400 ? Number(err.statusCode) : 500;
  if (code >= 500) {
    app.log.error(err);
    // Unexpected failures do not reveal internals (database, file paths, library messages). Failures we raised on purpose (502/503/504 with a message) do.
    return reply.code(code).send({ error: err?.expose === true ? err.message : code === 500 ? "Something went wrong on the server" : err.message });
  }
  reply.code(code).send({ error: err.message });
});

await migrate();
await loadAdminPresets(); // the servers set up in Nextcloud's admin settings, before the first request
startAdminPresetRefresh();
// Cached message bodies are a copy of mail that lives on the server anyway: keep them for a limited time (they are fetched again when opened).
const pruneBodies = () => bgPool.query("delete from message_bodies where fetched_at < now() - make_interval(days => $1)", [Number(process.env.NCMAIL_BODY_CACHE_DAYS ?? 90)]).catch(() => {});
if (Number(process.env.NCMAIL_BODY_CACHE_DAYS ?? 90) > 0) { setTimeout(pruneBodies, 60_000).unref(); setInterval(pruneBodies, 6 * 3600_000).unref(); }
if (authMode === "single") app.log.warn("NCMAIL_AUTH is not set: single-user mode, the app accepts only connections from this machine. Set NCMAIL_AUTH=nextcloud and NEXTCLOUD_URL for anything shared.");
if (authMode === "nextcloud" && !process.env.NCMAIL_PUBLIC_URL) app.log.warn("NCMAIL_PUBLIC_URL is not set, so sign-in tokens are not checked against this service's address. Set it to the address users' browsers use for Mail.");
if (authMode === "nextcloud" && !process.env.NCMAIL_HANDOFF_PUBLIC_KEY && !keyFetchAllowed(process.env.NEXTCLOUD_URL ?? "")) app.log.warn("NEXTCLOUD_URL is plain http on a public address, so Nextcloud's signing key will not be fetched and nobody can sign in. Use https, pin NCMAIL_HANDOFF_PUBLIC_KEY, or set NCMAIL_HANDOFF_KEY_HTTP=1.");
if (authMode === "off") app.log.warn("NCMAIL_AUTH=off: there is no sign-in, anyone who can reach this service has full access to every mail account in it. Use this only on a closed network.");
installAuth(app);
countRequests(app);
await app.register(themeRoutes);
await app.register(internalRoutes);
await app.register(presetRoutes);
await app.register(mailRoutes);
await app.register(identityRoutes);
await app.register(prefsRoutes);
await app.register(templateRoutes);
await app.register(unsubscribeRoutes);
await app.register(receiptRoutes);
await app.register(imageSenderRoutes);
await app.register(aclRoutes);
await app.register(folderRoutes);
await app.register(integrationRoutes);
await app.register(draftRoutes);
await app.register(eventRoutes);
await app.register(searchRoutes);
await app.register(indexRoutes);
await app.register(bulkRoutes);
await app.register(contactRoutes);
await app.register(uploadRoutes);
await app.register(outboxRoutes);
await app.register(undoRoutes);
await app.register(secureRoutes);
await app.register(calendarRoutes);
await app.register(ncRoutes);
await app.register(contactRoutesNc);
await app.register(filesRoutes);
await app.register(labelRoutes);
await app.register(sieveRoutes);
await app.register(unifiedRoutes);
startSnooze(app.log);
startCalendarSync(app);
app.get("/api/idle", async (req) => {
  if (!req.owner) return idleStatus(); // no sign-in: one person's machine
  const { rows } = await pool.query("select id from accounts where owner = $1", [req.owner]);
  const mine = new Set(rows.map((r) => r.id));
  return idleStatus().filter((w) => mine.has(w.accountId));
});

const toSummary = (r: any, identities: Identity[]): AccountSummary => ({
  id: r.id,
  name: r.name,
  email: r.email,
  identities,
  indexBodies: !!r.index_bodies,
  supportsAcl: !!r.supports_acl,
  imap: { host: r.imap_host, port: r.imap_port, security: r.imap_security, username: r.imap_username },
  smtp: { host: r.smtp_host, port: r.smtp_port, security: r.smtp_security, username: r.smtp_username },
  createdAt: r.created_at.toISOString(),
});

const version = SERVICE_VERSION;
app.get("/api/health", async () => {
  await pool.query("select 1");
  return { ok: true, version, minAppVersion: MIN_APP_VERSION };
});

app.get("/api/accounts", async (req) => {
  const { rows } = await pool.query("select * from accounts where owner = $1 order by created_at", [req.owner]);
  const { rows: ids } = await pool.query("select i.* from identities i join accounts a on a.id = i.account_id where a.owner = $1 order by i.is_default desc, i.created_at", [req.owner]);
  return rows.map((r) => toSummary(r, ids.filter((i) => i.account_id === r.id).map(identityOut)));
});

// Try IMAP login + SMTP verify with the given (unsaved) settings.
app.post("/api/accounts/test", async (req) => {
  const { accountId, imap, smtp } = testInputSchema.parse(req.body);
  // When editing, blank passwords mean "use the stored ones" (only of the caller's own account).
  if (accountId && (!imap.password || !smtp.password)) {
    const stored = await loadAccount(accountId, req.owner);
    if (!imap.password) imap.password = stored.imap.password;
    if (!smtp.password) smtp.password = stored.smtp.password;
  }
  if (!imap.password || !smtp.password) throw Object.assign(new Error("Enter the password for both servers"), { statusCode: 400 });
  return testConnections(imap as any, smtp as any);
});

/** Mail accounts one user may add (NCMAIL_MAX_ACCOUNTS, 0 = no limit). Each one holds IMAP connections and a mirror. */
const maxAccounts = () => { const n = Number(process.env.NCMAIL_MAX_ACCOUNTS); return process.env.NCMAIL_MAX_ACCOUNTS && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 20; };

app.post("/api/accounts", async (req, reply) => {
  const a = accountInputSchema.parse(req.body);
  checkAgainstPresets(a.imap, a.smtp);
  for (const [s, what] of [[a.imap, "mail server"], [a.smtp, "outgoing mail server"]] as const) { requireTls(s.security, what); await guardHost(s.host, what, undefined, s.port); }
  const client = await pool.connect();
  try {
    await client.query("begin");
    // One at a time per owner, so parallel requests cannot slip past the limit together.
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`accounts:${req.owner}`]);
    const max = maxAccounts();
    const { rows: [{ n }] } = await client.query("select count(*)::int as n from accounts where owner = $1", [req.owner]);
    if (max > 0 && n >= max) throw Object.assign(new Error(`You can have at most ${max} mail accounts. Remove one to add another.`), { statusCode: 409 });
    const { rows } = await client.query(
    `insert into accounts (name, email,
       imap_host, imap_port, imap_security, imap_username, imap_password_enc,
       smtp_host, smtp_port, smtp_security, smtp_username, smtp_password_enc, owner, sync_months)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
    [a.name, a.email,
     a.imap.host, a.imap.port, a.imap.security, a.imap.username, encrypt(a.imap.password),
     a.smtp.host, a.smtp.port, a.smtp.security, a.smtp.username, encrypt(a.smtp.password), req.owner, a.syncMonths ?? null],
    );
    const { rows: [idr] } = await client.query(
      "insert into identities (account_id, name, email, is_default) values ($1,$2,$3,true) returning *",
      [rows[0].id, a.senderName ?? a.name, a.email]);
    await client.query("commit");
    reconcileIdle(app.log).catch(() => {}); // start watching the new account right away
    reply.code(201);
    return toSummary(rows[0], [identityOut(idr)]);
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
});

// Edit an account. Blank passwords keep the stored ones. If the IMAP server or login changed, the local
// mirror belongs to a different mailbox, so it is dropped and synced again.
app.patch<{ Params: { id: string } }>("/api/accounts/:id", async (req) => {
  const a = accountUpdateSchema.parse(req.body);
  checkAgainstPresets(a.imap, a.smtp);
  for (const [s, what] of [[a.imap, "mail server"], [a.smtp, "outgoing mail server"]] as const) { requireTls(s.security, what); await guardHost(s.host, what, undefined, s.port); }
  const { rows: [cur] } = await pool.query("select * from accounts where id = $1 and owner = $2", [req.params.id, req.owner]);
  if (!cur) throw Object.assign(new Error("Account not found"), { statusCode: 404 });

  const imapPw = a.imap.password ? encrypt(a.imap.password) : cur.imap_password_enc;
  const smtpPw = a.smtp.password ? encrypt(a.smtp.password) : cur.smtp_password_enc;
  const mailboxChanged =
    a.imap.host.toLowerCase() !== cur.imap_host.toLowerCase() ||
    a.imap.username.toLowerCase() !== cur.imap_username.toLowerCase();

  const client = await pool.connect();
  let row;
  try {
    await client.query("begin");
    ({ rows: [row] } = await client.query(
      `update accounts set name=$2, email=$3,
         imap_host=$4, imap_port=$5, imap_security=$6, imap_username=$7, imap_password_enc=$8,
         smtp_host=$9, smtp_port=$10, smtp_security=$11, smtp_username=$12, smtp_password_enc=$13
       where id=$1 and owner=$14 returning *`,
      [req.params.id, a.name, a.email,
       a.imap.host, a.imap.port, a.imap.security, a.imap.username, imapPw,
       a.smtp.host, a.smtp.port, a.smtp.security, a.smtp.username, smtpPw, req.owner]));
    if (!row) throw Object.assign(new Error("Account not found"), { statusCode: 404 });
    // The account's email is also one of its sender addresses: keep them in step.
    if (a.email.toLowerCase() !== cur.email.toLowerCase()) {
      const id = req.params.id;
      const { rows: [old] } = await client.query("select id, is_default from identities where account_id = $1 and lower(email) = lower($2)", [id, cur.email]);
      const { rows: [dup] } = await client.query("select id from identities where account_id = $1 and lower(email) = lower($2)", [id, a.email]);
      if (old && dup) { // the new address is already a sender address: fold the old one into it
        await client.query("delete from identities where id = $1", [old.id]);
        if (old.is_default) await client.query("update identities set is_default = true where id = $1", [dup.id]);
      } else if (old) {
        await client.query("update identities set email = $2 where id = $1", [old.id, a.email]);
      } else if (!dup) {
        await client.query(
          "insert into identities (account_id, name, email, is_default) values ($1, $2, $3, not exists (select 1 from identities where account_id = $1))",
          [id, a.name, a.email]);
      }
    }
    if (mailboxChanged) {
      await client.query("set local statement_timeout = 0"); // dropping a big mirror may take longer than the request limit
      await client.query("delete from folders where account_id = $1", [req.params.id]); // messages cascade
      await client.query("delete from thread_keys where account_id = $1", [req.params.id]);
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
  await restartIdle(req.params.id, app.log);
  if (mailboxChanged) syncAccount(req.params.id).catch((e) => app.log.error(e, "resync after account edit failed"));
  const { rows: ids } = await pool.query("select * from identities where account_id = $1 order by is_default desc, created_at", [req.params.id]);
  return { ...toSummary(row, ids.map(identityOut)), resynced: mailboxChanged };
});

app.delete<{ Params: { id: string } }>("/api/accounts/:id", async (req, reply) => {
  await retryOnDeadlock(() => bgPool.query("delete from accounts where id = $1 and owner = $2", [req.params.id, req.owner])); // folders, messages, identities cascade; may collide with a running sync
  await reconcileIdle(app.log); // stop its IDLE connection right away
  reply.code(204);
});

// Serve the production web build (pnpm build) from the same origin, with long-lived caching for hashed assets.
const webDist = process.env.WEB_DIST ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
if (existsSync(webDist)) {
  await app.register(fastifyStatic, {
    root: webDist, // resolved per request, so a rebuild is picked up without restarting
    setHeaders: (res, path) => { res.header("cache-control", path.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache"); },
  });
  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split("?")[0]!;
    if (isApiRequest(req)) return reply.code(404).send({ error: "Not found" });
    if (/\.[a-z0-9]+$/i.test(path)) return reply.code(404).type("text/plain").send("Not found"); // a missing file is a 404, not the app
    return reply.header("cache-control", "no-cache").sendFile("index.html"); // single-page app fallback for client routes
  });
  app.log.info({ webDist }, "serving the production web build");
}

startBackgroundSync(app.log, { isHealthy: isIdleHealthy });
startServerChecks(app.log);
await startHeartbeat(app.log);
startMetrics(app.log);
backfillContacts(app.log).catch((e) => app.log.error(e, "contact backfill failed"));
startOutbox(app.log);
backfillSearchText(app.log).catch((e) => app.log.error(e, "search index backfill failed"));
backfillThreads(app.log).catch((e) => app.log.error(e, "thread backfill failed"));
startIdle(app.log);
startBodyIndexer(app.log);
await app.listen({ port: Number(process.env.API_PORT ?? 4000), host: process.env.API_HOST ?? "127.0.0.1" }); // 0.0.0.0 inside a container; keep it private or behind a proxy
