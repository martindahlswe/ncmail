# Security review

NCMail had two security reviews before its first release, 0.1.0. Both were code reviews, not penetration tests: nothing was attacked,
fuzzed or load-tested against a hostile network. The findings below describe the code as it was when it was reviewed; every one was dealt
with before 0.1.0, and where a fix is partial or a risk was accepted, this document says so.

- **First review** (2026-11-25): the whole source tree.
- **Second review** (2026-11-27): the features added after the first review.

Between the two, the design changed in ways that matter for security (sign-in only through Nextcloud, and several features that reach
Nextcloud or the network). Those are described under [Security notes on features](#security-notes-on-features).

## First review

Date: 2026-11-25. Scope: the whole source tree (API, web app, shared package, Nextcloud app, infrastructure files, tests' fixtures).
Method: reading the code paths that handle authentication, authorisation, secrets, untrusted input (mail content, uploads, search queries,
user-supplied server addresses), outbound connections and the browser; searching for dangerous patterns; `pnpm audit`; checking what the
tests already prove.

How to read the severities: **High** = fix before multi-user use; **Medium** = fix before any production deployment; **Low** = hardening.
Several findings depend on the deployment: a single user on localhost is much safer than one service with many users.

### Summary

| # | Severity | Finding |
|---|---|---|
| H1 | High | Vulnerable dependencies: `nodemailer` 7.0.13 (20 advisories, 5 high) and `zod` 3.25 (memory exhaustion) |
| H2 | High (multi-user) | Server-side request forgery: users choose the hosts the server connects to, with no blocking of internal addresses |
| H3 | Medium | No authentication at all unless `NCMAIL_AUTH=nextcloud` is set |
| M1 | Medium | Login proxy has no rate limiting; can lock every user out of Nextcloud |
| M2 | Medium | Session cookie lacks `Secure`; sessions cannot be revoked |
| M3 | Medium | Nextcloud single sign-on forwards every cookie on the host to Nextcloud |
| M4 | Medium | CORS reflects any origin and there is no Origin / Fetch-Metadata check |
| M5 | Medium | Uploaded attachments written to the shared temp folder with default permissions; no quota |
| M6 | Medium | 5xx responses return internal error text |
| M7 | Medium | No security headers on the app and API (CSP, nosniff, referrer policy) |
| M8 | Medium | Sensitive data at rest is unencrypted in Postgres; one static key protects every secret, with no rotation |
| M9 | Medium | The stored Nextcloud app password is as powerful as the user's login |
| L1–L12 | Low | See below |

No critical findings. No SQL injection, no script injection into the app, no path traversal and no cross-user data access were found.

### What was done

All findings were addressed in code, configuration or documentation. Where a fix is partial, the remainder is stated.

| # | Status | What was done |
|---|---|---|
| H1 | Fixed | `nodemailer` 10.6.1, `zod` 4.6.7; `pnpm audit` is clean and runs in CI |
| H2 | Fixed | `netguard.ts`: every IMAP, SMTP, IDLE, ManageSieve and CalDAV connection, and one-click unsubscribe, resolves the host, refuses loopback/private/link-local/CGNAT/ULA addresses in any spelling (IPv4-mapped/compatible, NAT64 and 6to4 forms are checked as the IPv4 address they carry), and connects only to the addresses it checked (default when sign-in is on). `NCMAIL_PRIVATE_HOSTS=allow\|block\|<allow-list>` |
| H3 | Fixed | Without sign-in the API answers only `localhost` requests (proxy headers or other host names get 403, which also stops DNS rebinding); `NCMAIL_AUTH=off` opts out; startup warning. The service also refuses to start without sign-in on an address other machines can reach |
| M1 | Fixed, then removed | Sign-in attempts were limited per address and per user name. The password sign-in itself was later removed (see [Mail only inside Nextcloud](#mail-only-inside-nextcloud)) |
| M2 | Fixed | Random session ids in a `sessions` table, deleted on sign-out; `Secure` cookie over HTTPS (or `NCMAIL_COOKIE_SECURE=1`). Sessions are now short and renewed only while the Nextcloud session lives |
| M3 | Fixed, then removed | Only Nextcloud-named cookies were forwarded; the cookie-based sign-in was later replaced by a signed hand-off from the Nextcloud app |
| M4 | Fixed | CORS is off; unsafe methods are refused when `Sec-Fetch-Site` / `Origin` show another origin, and changes sent with the session cookie but with neither header are refused except from the same machine |
| M5 | Fixed | Upload folder `0700`, files `0600`, per-user 500 MB quota (`NCMAIL_UPLOAD_QUOTA_MB`), uploads bound to the user who made them (also L2) |
| M6 | Fixed | 5xx responses do not include internal error text; details go to the log only |
| M7 | Fixed | `nosniff`, `Referrer-Policy: same-origin` and a CSP (`script-src 'self'`, `object-src 'none'`, `frame-ancestors` limited to Nextcloud) on every response |
| M8 | Partly fixed | Versioned ciphertext (`v1:`), `SECRET_KEY_OLD` and `pnpm rotate-key` for key rotation; cached message bodies expire after `NCMAIL_BODY_CACHE_DAYS` (90). The mirrored mail itself is still plain text in Postgres: use disk/volume encryption (documented in the README) |
| M9 | Partly fixed | The app password is tracked by its id and revoked at Nextcloud when the user disconnects or re-links, and the login-flow URLs must stay on the configured Nextcloud. An app password still has the user's full Nextcloud power: that is a property of Nextcloud |
| L1 | Fixed | `/api/idle` shows only the caller's accounts. `/api/sync/status` returns aggregate counters only |
| L2 | Fixed | See M5 |
| L3 | Fixed | `NCMAIL_REQUIRE_TLS=1` refuses unencrypted IMAP/SMTP/Sieve and `http://` Nextcloud/CalDAV |
| L4 | Fixed | Request logs keep the path, not the query string |
| L5 | Fixed | Login URLs and poll endpoints returned by Nextcloud must be on its configured host |
| L6 | Fixed (notice) | The filter editor warns that "Send a copy to" forwards mail automatically. No admin policy was added |
| L7 | Fixed | All published container ports (the test stack in `testing/docker-compose.yml` and `deploy/docker-compose.yml`) are bound to `127.0.0.1` |
| L8 | Fixed | S/MIME decryption failures all give one message |
| L9 | Documented | No CRL/OCSP checks and imported-key user-ID claims are listed as known limits in the README |
| L10 | Fixed | `.github/workflows/ci.yml`: typecheck, `pnpm audit`, tests, secret scanning |
| L11 | Fixed | Cursor shape is validated (400) |
| L12 | Fixed | The Nextcloud app frame asks for `clipboard-write` only |

Tests: `test/hardening.test.ts` and `test/auth.test.ts` cover address classification, blocked and TLS-required hosts, error masking,
security headers, cross-origin refusal, real sign-out and cookie handling.

### High

#### H1. Vulnerable dependencies
`pnpm audit --prod`: 21 advisories (1 low, 15 moderate, 5 high).
- **nodemailer 7.0.13** (sending mail, building messages). Relevant ones: quadratic-time recipient-address parsing (denial of service by any
  signed-in user who sends a crafted recipient list), a process-global DNS cache that can reuse the TLS server name across transports
  (this service holds many accounts in one process, so one account's connection could be used for another), CRLF injection in `List-*`
  header comments and in the SMTP transport name (neither feature is used here), TLS validation in OAuth2 token fetch (not used). Fixed in 10.1.x.
- **zod 3.25** (`packages/shared`, request validation): can exhaust memory validating very large constrained arrays. The API accepted bodies up to
  40 MB, so a signed-in user could trigger it. Fixed in zod 4.6.6.

Recommended: upgrade both, re-run the tests, add `pnpm audit` to CI.

#### H2. Server-side request forgery (multi-user deployments)
The service connects to addresses the user types in:
`POST /api/accounts/test` and `POST /api/accounts` (IMAP and SMTP host/port), `PUT /api/accounts/:id/sieve/connection` (ManageSieve host/port),
`POST /api/accounts/:id/calendar/discover` (any http/https URL, called with the user's credentials). Nothing stopped `127.0.0.1`, `169.254.169.254`
(cloud metadata), `10.x`, `192.168.x`, internal hostnames or arbitrary ports. A signed-in user could port-scan the internal network, read
the connection error text, and send credentials to any host. In a single-user local install this is the user's own choice; on a shared
service it is a privilege-escalation path.

Recommended: resolve the hostname, refuse loopback, link-local, private and unique-local ranges (and IPv4-mapped IPv6) unless an admin
allow-list says otherwise, and connect to the resolved address so DNS rebinding cannot swap it.

### Medium

#### H3. No authentication unless enabled
`NCMAIL_AUTH` was off by default. Then every request had the empty owner and full access to every account, including sending mail.
The server listened only on `127.0.0.1`, so a plain install was reachable only from the same machine; the danger was a reverse proxy, a
port-forward or a container publish in front of it. Recommended: refuse to run behind a proxy without auth (or require `NCMAIL_AUTH=off`
explicitly), and warn at start-up when auth is off.

#### M1. Login proxy without rate limiting
`POST /api/auth/login` forwarded the user name and password to Nextcloud. Nextcloud's brute-force protection keys on the caller's IP, which is
always this server. An attacker could therefore (a) guess passwords at Nextcloud's throttled rate and (b) trip the throttle so that **every** user
is blocked from signing in. Recommended: rate-limit per IP and per user name, pass the real client address to Nextcloud, and prefer single sign-on.

#### M2. Session cookie
`ncmail_session` was `HttpOnly; SameSite=Lax` (good) but had no `Secure` flag. The token was a stateless HMAC of `{user, expiry}` valid for
14 days; signing out only cleared the browser's copy, so a stolen token stayed valid until it expired, and nothing was revoked when a Nextcloud
user was disabled. Recommended: `Secure` over HTTPS, server-side sessions that can be revoked, a shorter lifetime with sliding renewal.

#### M3. Single sign-on cookie forwarding
`GET /api/auth/me` sent every cookie in the request (except its own) to Nextcloud to ask who the user is. Cookies belonging to other applications
on the same host were sent to Nextcloud as well. Recommended: forward only Nextcloud's own cookie names, or replace this with a signed assertion
issued by the Nextcloud app.

#### M4. CORS and cross-origin requests
`@fastify/cors` was registered with `origin: true`, which accepts any origin on preflight, and nothing checked `Origin` or `Sec-Fetch-Site`.
Credentials were not allowed in the CORS response and `SameSite=Lax` stopped cross-site requests carrying the cookie, but **same-site** pages
(another app on the same registrable domain, or another port on `localhost`) could send body-less POST requests with the cookie. Recommended:
allow only this origin and Nextcloud's, and reject unsafe methods whose `Sec-Fetch-Site` is not `same-origin`.

#### M5. Uploaded attachments in the temp folder
`uploads.ts` wrote files to `os.tmpdir()/ncmail-uploads` with default permissions (directory 0755, files 0644). On a host with other local
users, they could read confidential attachments for up to 24 hours. There was no per-user quota, so one user could fill the disk.
Recommended: mode 0700 / 0600, a per-user total limit, delete on send or discard.

#### M6. Internal errors returned to the client
The error handler sent `err.message` for every status, including 5xx. Database and library errors can include table names, SQL fragments, file
paths and mail-server banners. Recommended: log the details and return a generic message for 5xx; keep specific messages for errors the code
raises on purpose (4xx).

#### M7. Missing security headers
Only `frame-ancestors` was set (clickjacking was blocked). The app shell had no Content-Security-Policy, and responses lacked
`X-Content-Type-Options`, `Referrer-Policy` and `Permissions-Policy`. Message bodies were already isolated (below), so this is defence in depth.

#### M8. Data at rest and key management
- Postgres holds, unencrypted: message headers (sender, recipients, subjects), cached bodies of opened messages and the newest inbox mail, the
  optional text index, contacts, calendar and Nextcloud connection data, and the outbox (full messages with attachments) until sent. Decrypted
  S/MIME and PGP content is **not** stored (checked). Drafts are stored unencrypted on the mail server, except drafts of messages marked for
  encryption, which are encrypted to the sender's own key when one that can decrypt exists.
- Passwords, PGP/S-MIME private keys and Nextcloud app passwords are encrypted with AES-256-GCM (random IV, authentication tag) using one
  `SECRET_KEY`. Anyone with the database and that key has every secret. At the time there was no key id or rotation.

Recommended: key versioning with re-encryption, a documented requirement for disk encryption, and a retention setting for cached bodies.

#### M9. Nextcloud app password
Login-flow app passwords cannot be limited to Contacts/Files/Calendar; they grant everything the user can do. They are stored encrypted, but a
database and key leak is a Nextcloud account takeover. Recommended: revoke on disconnect, and show users the connection and a way to end it.

### Low / hardening

- **L1** `GET /api/idle` listed every account's id and watcher state across all users, and `GET /api/sync/status` exposed global counters.
- **L2** `GET/DELETE /api/uploads/:id` were not tied to an owner (the id is an unguessable UUID, so it acted as a capability).
- **L3** Plain IMAP/SMTP/ManageSieve and `http://` Nextcloud / CalDAV addresses were accepted with no way to refuse them.
- **L4** Request logs contained URLs including search terms and ids.
- **L5** `window.open(loginUrl)` and the login-flow poll followed URLs returned by the Nextcloud server without checking they stay on the configured Nextcloud origin.
- **L6** A filter rule can forward mail to an external address (`redirect :copy`). It is a normal feature, but it is also what an attacker with a stolen session would add.
- **L7** Development and test containers published their services, with weak test passwords, on all interfaces.
- **L8** S/MIME decryption (RSA PKCS#1 v1.5) returned distinct error texts; if an attacker could observe whether a crafted message decrypts, that is a padding-oracle shape.
- **L9** No revocation checking (CRL/OCSP) for S/MIME, and PGP user-ID claims are taken from keys the user imported.
- **L10** There was no CI: no dependency audit, secret scanning or static analysis ran on changes.
- **L11** Malformed pagination cursors reached SQL casts and ended in a 500 (and M6 leaked the message).
- **L12** The Nextcloud app embedded the mail service with `allow="clipboard-read"`; clipboard-write is enough for the features used.

### What is done well (verified)

- **Authorisation:** one guard checks ownership of every account, folder, message, key and outbox id in the URL or body; foreign ids look like "not found".
  Tests cover cross-user access for folders, messages, bulk actions, keys, calendar, outbox, contacts and deleting an account. Key lookups are scoped to the owner.
- **SQL:** every user-supplied value is a bound parameter; the few interpolated pieces are whitelisted sort keys, numeric ids or constants. Search terms become `to_tsquery` words only.
- **Mail content:** HTML is sanitised (sanitize-html allow-list), shown in a sandboxed iframe without scripts, with a CSP that blocks remote loads until allowed;
  links are `noopener noreferrer`; deceptive links are flagged. Attachment preview is an allow-list (no SVG/HTML), served with `nosniff` and a locked-down CSP.
- **Secrets:** no keys or passwords in the repository; `.env` is ignored; responses never include stored passwords.
- **Network:** the service listens only on loopback; `frame-ancestors` limits embedding to itself and Nextcloud; TLS certificate verification is never switched off.
- **Other input handling:** Sieve scripts escape strings and dot-stuff text; Nextcloud file paths reject `..`; label and keyword names are validated; uploads are streamed with a size limit.
- **Crypto code:** decrypted content is not cached; signature results distinguish invalid / mismatch / untrusted / unknown; private keys are encrypted at rest.

### Not covered

Live testing against a hostile network; the Dovecot, Postgres and Nextcloud server configurations themselves; deep review of the third-party parsers
(mailparser, node-forge, openpgp) beyond their advisories; fuzzing; side-channel and timing analysis; the small PHP embedding app beyond its
header and CSP handling.

## Security notes on features

These describe how features added after the first review were built with security in mind. The second review (below) checked them again.

### Mail only inside Nextcloud

Sign-in is a signed hand-off from the Nextcloud app (Ed25519; the service holds only the public key). This removed the password sign-in endpoint (and with it
password brute-forcing and the "user types their Nextcloud password into a third-party page" risk, M1) and the Nextcloud-cookie forwarding (M3), and made sessions
short (`NCMAIL_SESSION_MINUTES`, default 15) and renewable only while the Nextcloud session lives. Tokens live 1 minute, work once, must name the service they are
for (`aud`, which must match `NCMAIL_PUBLIC_URL` when it is set) and carry numeric times. Server-to-server calls (sign-out notice, unread count, search,
notifications, app-password hand-over, admin settings) are signed over method, the host they are addressed to, path, time, nonce and body, and cannot be replayed
or sent to another mail service that trusts the same Nextcloud; no other signature format is accepted. The signing key is not fetched over plain http from a
public Nextcloud address unless `NCMAIL_HANDOFF_KEY_HTTP=1` is set (pinning `NCMAIL_HANDOFF_PUBLIC_KEY` is better), and `occ ncmail:rotate-key --revoke-previous`
drops earlier signing keys at once. The page is not served to a browser tab (`Sec-Fetch-Dest: document`), only into a frame, and `frame-ancestors` is limited to
Nextcloud. Remaining trust: whoever controls the Nextcloud app's key (or its admin) can act as any user, which is inherent to single sign-on. Tests:
`test/auth.test.ts`, `test/presets.test.ts`.

### Notifications, Send by mail, Write an email

- **Notifications** are pulled by the Nextcloud app's background job over the signed server-to-server channel (`POST /api/internal/notifications`);
  the service never calls Nextcloud for them and needs no credentials for it. The answer holds the sender and subject of new inbox mail for the users concerned,
  which Nextcloud then stores in its own notifications table: anyone who can read Nextcloud's database can read those. Users can switch it off; announcements
  that are not picked up within a day are dropped. Only mail that arrives in an inbox that was synced before is announced (no flood of old mail).
- **Send by mail** passes file paths in the Mail page's URL (`?attach=`). The service fetches them over WebDAV with the signed-in user's own app password, from
  that user's files root only (`..` and control characters are refused), so a crafted link cannot reach anyone else's files. Files are only attached from a link
  when the visit comes from Nextcloud itself. As with `?compose=`, a link can only prepare a draft; nothing is sent until the user presses Send.
- **Write an email** is a link action in the contacts menu with the address as `?compose=`; no data leaves Nextcloud.
- Tests: `test/notify.test.ts` (only the Nextcloud app may ask; first sync and read mail are not announced; each message is announced once and taken back once
  read or deleted; the per-user switch).

### Unsubscribe and templates

- **One-click unsubscribe** makes the service send an HTTPS POST to an address taken from the message (`List-Unsubscribe`). It is offered only when the
  receiving server reported a passing DKIM signature (the service trusts the first `Authentication-Results` header, as the phishing cues do, and reads which
  domain passed from `header.d` / `header.i`), that signature's `h=` tag covers both `List-Unsubscribe` and `List-Unsubscribe-Post` (as RFC 8058 asks), and its
  `d=` domain is the one-click address's host or the From domain (or a parent of them); never for mail in Junk, only for `https:` addresses, through
  `netguard.ts` (no private or local addresses unless allowed), without following redirects, with a 10 s limit, and only after the user confirms. Without a
  passing signature, the list is mailed from the user's own address (to the first `mailto:` address only, with a fixed subject and text: the link's
  subject, body and other recipients are ignored) or its page is opened in the user's browser, never fetched by the service.
- **Templates** belong to one Nextcloud user; their ids are checked against the owner in the preHandler like every other id, and the queries filter by owner
  as well. Their HTML is inserted into the editor, which keeps only the elements its schema allows.
- Tests: `test/unsubscribe.test.ts` (one click only with a passing signature and over https, the request sent, refusals reported, Junk, mail and page
  fallbacks), `test/templates.test.ts` (owner isolation, renaming keeps the rest).

### Mail servers in Nextcloud's admin settings

- The list is edited in Nextcloud's admin settings. The Nextcloud app's routes are admin-only and need Nextcloud's CSRF token. They relay to
  `/api/internal/mail-servers`, which, like every internal route, only accepts calls signed with Nextcloud's key. A signed-in Mail user cannot
  reach it. Changes are logged with the administrator's user id and stored in the service's database.
- Servers listed there are trusted like those in `NCMAIL_MAIL_CONFIG`: a mail connection (IMAP, SMTP, ManageSieve) to exactly a listed host and
  port may use a private address. Other ports of the same host, and web requests (calendars, unsubscribe links), get the normal address policy.
  Hosts are checked to be plain host names or addresses (no URL, path or spaces).
- The connection check connects to the given hosts without logging in, and only for administrators. It has an 8 second limit per server, and the
  certificate is verified as for accounts. When a server does not answer, at most the usual ports on the same host are tried.
- Looking up a domain fetches its autoconfig files over HTTPS through the same address policy as other outgoing connections
  (`NCMAIL_PRIVATE_HOSTS`, no redirects, 6 second limit). It also reads DNS SRV records and, unless `NCMAIL_ISPDB=0`, asks Thunderbird's public list
  of providers, which receives only the domain. Found host names, from autoconfig and SRV alike, must be plain host names with a dot and not IP
  addresses, and the servers found are probed through the address policy too (the domain's owner chose them, not the administrator).
- Background checks of the listed servers (`NCMAIL_SERVER_CHECK_HOURS`) only connect and read the greeting. No credentials are ever sent.
- People adding their own account can look up their domain's servers the same way (`GET /api/mail-presets/lookup`, signed in). It
  fetches only the domain's autoconfig files through the address policy, reads DNS SRV records, and asks Thunderbird's list unless
  `NCMAIL_ISPDB=0`; it probes nothing. It is refused when people are limited to the listed servers, limited to 20 lookups per person in
  ten minutes, and answers are kept for an hour per domain.

### Managing folders

- Creating, renaming, moving and deleting folders (`POST /api/accounts/:id/folders`, `PATCH`/`DELETE /api/folders/:id`) goes through the same
  ownership check as every other account and folder route. The service refuses Inbox and special-use folders (and folders that contain one), folders of
  another account, moving between your own and shared folders, moving a folder into itself, and, outside your personal namespace, anything the server's
  rights do not allow (`k` to create inside, `x` to rename or delete). Names are one level only: no separator, IMAP wildcards (`*`, `%`) or control
  characters. The mail server enforces the rest.
- Delete moves your own folders into Trash; deleting for good needs `permanent=1` and is confirmed in the interface. Filter lookups after a
  rename or delete are capped at three seconds so a missing Sieve service cannot stall the request.

### Shared folders

- Sharing uses the mail server's own access control (RFC 4314): the service sends SETACL/DELETEACL for the user's own folders only (personal namespace;
  other people's folders and non-selectable ones are refused), never for the special identifiers (`anyone`, `authenticated`, `owner`, groups, negative
  rights), and grants at most "lrswipte" (no `a`, so the other person cannot share further, and no `k`/`x`). The server enforces every right; the
  interface only hides what would be refused.
- Access to folders outside your own namespace (other users' and public folders) can be managed only where the server grants the `a` right;
  everything else is refused before a command is sent. Mail does no sharing of its own: no stored login is ever shared between users.
- Pooled IMAP connections are replaced after two minutes even while in use (`NCMAIL_IMAP_MAX_AGE_MS`), so per-session server state such as
  newly shared folders is picked up.
- Folders outside the personal namespace never get a special use, so mail is never filed into someone else's Sent, Drafts or Trash.
- When a folder outside the personal namespace is still listed but no longer readable (MYRIGHTS without `r`, or SELECT refused with NOPERM),
  its mirrored messages, cached bodies and body index are removed at the next sync, and mail of such a folder is never served, searched or indexed.
- Folder ids in the sharing routes are checked against the owner like every other folder id.
- Tests: `test/shared.test.ts` (sharing read-only and with changes, rights as the other user sees them, no special use for shared folders, refusals,
  stopping).

### Tasks, Calendar and Talk

- All three act as the signed-in user through the app password Nextcloud handed over (the same connection Files and Contacts use); requests go only to
  the configured Nextcloud. A task list or calendar must be one of the user's own (looked up by CalDAV before writing), so a request cannot make the
  service write elsewhere; a Talk conversation must be one the user is in and can write to.
- Text taken from the mail (sender, subject, excerpt) has every `@` replaced by the full-width `＠`, so a message cannot mention and notify the
  conversation's members; the user's own note is posted as typed.
- Share to Talk sends mail content (sender, subject and, unless switched off, up to 400 characters of text) to everyone in the chosen conversation;
  the dialog says so. Message ids are checked against the owner like every other message route.
- Tests: `test/integrations.test.ts` (against a mock Nextcloud: what is offered, the objects written, own calendars only, writable conversations only).

## Second review

Date: 2026-11-27. Scope: the features added after the first review: the folder routes, mail servers in Nextcloud's admin settings (connection
checks, domain lookup, background checks), pictures in messages and signatures, trusted image senders, forward as attachment, reply to list,
read receipts, the version check, and the Nextcloud app's controller, settings page and app-password linking. Same method as the first review:
reading the code paths, three independent reads (outgoing connections; message handling; folders and the Nextcloud app), each finding checked
again before fixing, and `pnpm audit` (no known vulnerabilities at any severity). Every finding below is fixed in 0.1.0, and every fix has a test.

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium | **A crafted message froze the service for everybody.** The regular expression that turns pictures in the text into attachments backtracked quadratically: any signed-in user could stall the event loop for minutes with one send or draft save (measured: 4,000 repetitions took 259 ms, the API's size limit allows about 300,000). | `<img>` tags are now scanned one by one, each only up to its own `>`: linear time (`unit.test.ts`, 300,000 repetitions in well under a second). |
| Medium | **A listed mail server's host was trusted on every port and for web requests.** Hosts in the admin list (or `NCMAIL_MAIL_CONFIG`) could be reached on private addresses by any connection: a user's calendar URL or Sieve server on another port of that machine, or an unsubscribe link in a mail. | Trust is per host and port and for mail connections only (`presetEndpoints`, `guardHost(…, mailPort)`); web requests never get it (`presets.test.ts`). |
| Medium | **Trusted image senders could be spoofed.** Images loaded when no sender check *failed*, which includes mail with no checks at all, so a forged From of an allowed sender could load a tracking picture. | Images load automatically only when the receiving server confirmed the From domain: DMARC pass, or a DKIM or SPF pass for the From domain (`senderAuthenticated`, `unit.test.ts`). |
| Medium | **Renaming a folder could make every filter disappear.** A rename could push a filter's folder path past 200 characters; the script still worked, but the filter settings no longer read back, and the next save would replace them all. | Such a rule is left unchanged and the rename says so (`filtersNotUpdated`, `folders.test.ts`). |
| Medium | **Special folders inside a folder went with it.** Deleting or moving a folder that holds Sent or Trash (as Gmail's `[Gmail]` does) took them along. | A folder that contains Inbox or a special folder cannot be renamed, moved or deleted (`folders.test.ts`). |
| Low | Servers found by a domain lookup were probed without the address policy, and SRV answers were not checked like autoconfig ones. | Looked-up servers are probed through the policy; IP addresses and single names are dropped (`unit.test.ts`). |
| Low | A probed server could flood its greeting (memory and CPU); a probe that timed out before connecting left its socket open. | Replies are capped at 200 lines and 64 KB; every socket of a probe is closed when it ends (`unit.test.ts`). |
| Low | Autoconfig files were downloaded whole before their size was checked. | `httpRequest` stops at `maxBytes` (200 KB here). |
| Low | One-click unsubscribe accepted a passing signature for a subdomain as vouching for a planted parent-domain signature (`d=com`). | The passing domain must be the signature's own (`unit.test.ts`). |
| Low | A forwarded message whose stored size was missing was downloaded whole before the size limit applied. | The download stops as soon as it no longer fits. |
| Low | A read receipt's envelope sender could come from a sender-supplied Return-Path, and receipt addresses allowed control characters. | Only a topmost Return-Path counts (the one the delivering server writes); addresses must be printable ASCII (`unit.test.ts`). |
| Low | Folder routes read the folder before taking the account's lock; filter rewrites and filter saves could overwrite each other; a rename on a server without a separator could drop mirror rows of similarly named folders; a shared folder could be moved among your own. | Re-read under the lock; one filter change per account at a time; the prefix match is guarded; moves stay within your own or within shared folders. |
| Low | Two simultaneous links to Nextcloud could each create an app password, one of them never remembered (so never revoked). | One link per user at a time (Nextcloud's lock), and the new password is remembered before the old one is revoked. |
| Low | A reader inlined a picture once per reference, so a small message naming one picture thousands of times grew huge. | At most 20 MB of inlined pictures per message; the rest stay as `cid:` references. |
| Info | The admin page's example used a made-up personal name as a fallback, and the decrypted part of an unverified message could supply the list's posting address. | Removed; the outer address is used unless the signature vouches for the inner one. |

## Accepted risks and known limits

- **Trust in a listed host follows its name, not its address.** Whoever controls the DNS of a listed mail server's name can point it elsewhere.
  This is limited to that server's mail port, and administrators choose which names to list.
- **The connection check probes what an administrator types** without the address policy: checking an internal mail server is its purpose.
- **Checks and lookups have no global concurrency limit.** Only administrators can start them, each probe has an 8 second limit, and replies are capped.
- **Mirrored mail is stored unencrypted in Postgres** (M8): use disk or volume encryption.
- **The Nextcloud app password has the user's full Nextcloud power** (M9): that is how Nextcloud app passwords work.
- **Whoever controls the Nextcloud app's signing key, or Nextcloud's admin, can act as any user**: inherent to single sign-on.
- **No CRL/OCSP revocation checks for S/MIME, and PGP user-ID claims come from imported keys** (L9).
- **Notification text (sender and subject) is stored in Nextcloud's database**, and Share to Talk sends mail content to everyone in the chosen conversation.
- **No admin policy for forwarding filters** (L6): the filter editor only warns.
