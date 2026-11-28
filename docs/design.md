# How NCMail works

NCMail is a fast webmail client that runs as an app inside Nextcloud. This page describes the design as it is in 0.1.0: what it is
built from, how the parts trust each other, where data lives, how fast it is, and how it is tested. For what it does, see the
[README](../README.md) and [features.md](features.md); for running it, [deployment.md](deployment.md) and [configuration.md](configuration.md).

## 1. The idea

Nextcloud's own Mail app reads headers live from the mail server on every request, so large mailboxes are slow and search falls back
to the server. NCMail mirrors message headers into PostgreSQL and serves the interface from that mirror, so lists, search and
conversations stay fast at hundreds of thousands of messages.

**The mail server stays the source of truth.** The mirror can be rebuilt from it at any time; NCMail never holds the only copy of a
message, a folder, a flag or a label.

## 2. Decisions

| Decision | Why |
| --- | --- |
| **Inside Nextcloud, as an app plus a separate service.** The Nextcloud app adds Mail to the menu and shows the service's web app in Nextcloud's page; the service does the mail work. | People sign in once (to Nextcloud), the look follows Nextcloud's theme, and the heavy work (IMAP, sync, search) runs outside PHP, where long-lived connections and background work are natural. |
| **Plain IMAP and SMTP** to whatever servers you use, with ManageSieve for filters. No bundled mail server. | Works with any standards-compliant mail server. |
| **PostgreSQL as a header mirror,** queried with plain SQL (`pg`). | Indexed lists, keyset paging and full-text search without an ORM or a separate search engine. |
| **One service process** for the API, sync, live updates and background work, and **one instance per database**. | Simple to run and fast enough at the measured scale (section 6). Some coordination lives in the process, so a second instance on the same database is reported in the log and on the admin Mail page. |
| **Deliberate limits:** no OAuth2, English only, no AI features, IMAP/SMTP only, sharing only as the mail server offers it. | See [Limits](../README.md#limits). |

## 3. The parts

```
 Browser ── Nextcloud page (header, menu, theme)
   │          └─ iframe: the service's web app (React)  ── REST/JSON + Server-Sent Events ──┐
   │                                                                                       │
 Nextcloud ── NCMail app (PHP)                                                   NCMail service (Node, Fastify)
   │  • Mail in the menu, the frame, the admin Mail page                          • REST API, live updates (SSE)
   │  • signs a short-lived token that signs the user in  ─────────────────────▶  • sync engine and IMAP IDLE
   │  • signed server-to-server calls: unread badge, global search,  ◀────────▶   • background work (below)
   │    notifications, sign-out, user removed, admin mail servers                  │
   │                                                                               ├── PostgreSQL (mirror and settings)
   └─ Files, Contacts, Calendar, Tasks, Talk (WebDAV / CardDAV / CalDAV, app password) ◀── used by the service
                                                                                   └── your IMAP, SMTP and ManageSieve servers
```

**The service** (`apps/api`) is one Node process:
- **API and live updates:** REST for accounts, folders, messages, conversations, search, drafts, sending and settings; Server-Sent
  Events push new mail and changes to open windows.
- **Sync engine:** folder list, newest-first header backfill (with a configurable window; older mail stays searchable on the server),
  incremental flag and deletion sync (CONDSTORE where available; QRESYNC is detected but not used yet), threading, a pool of warm IMAP connections, and IDLE on each
  account's inbox.
- **Background work:** a fair background sync of all accounts, the outbox (undo send and send later), snoozed messages coming back, the
  opt-in body search index, calendar invitations, checks of the administrator's mail servers, and clean-up of sessions and uploads.

**The web app** (`apps/web`) is React with a virtualised message list, Tiptap for writing, and plain CSS built on Nextcloud's own
CSS variables, so any Nextcloud theme applies. Message bodies render in a sandboxed frame with no scripts and remote images blocked
until allowed.

**The Nextcloud app** (`integration/nextcloud-app/ncmail`, PHP) has no mail logic: it frames the web app, vouches for the user, relays
the admin Mail page to the service, and forwards Nextcloud events (sign-out, user removed, notifications, search).

## 4. Sign-in and trust

- **Signing in:** the Nextcloud app signs a short-lived token (Ed25519) for the signed-in user and hands it to the frame; the service
  checks it and starts a session of a few minutes, renewed while the Nextcloud session lives and ended when Nextcloud reports a
  sign-out. There is no password sign-in to the service.
- **Ownership:** every account, folder, message, key, outbox entry and template id in a request is checked against the signed-in user
  before the route runs, and the queries filter by owner as well.
- **Server-to-server calls** from Nextcloud are signed over the method, target host, path, time and body; the service accepts them only
  with Nextcloud's public key, and the admin routes behind them only for Nextcloud administrators.
- **Outgoing connections** go through one address policy: private and local addresses are refused unless allowed
  (`NCMAIL_PRIVATE_HOSTS`), names are resolved once and connections pinned to the checked addresses. Mail servers an administrator
  listed are trusted on their own mail ports only.
- **Mail content** is sanitised on the server and shown in a sandboxed frame; phishing cues come from the receiving server's sender
  checks, look-alike domains and deceptive links. OpenPGP and S/MIME are verified on the server.

The full threat review is in [security-review.md](security-review.md).

## 5. Where data lives

| Data | Where | Back it up? |
| --- | --- | --- |
| Messages, folders, flags, labels (IMAP keywords) | The mail server; NCMail's copy is a rebuildable mirror | The mail server's backup |
| Filters and out-of-office | A Sieve script on the mail server | The mail server's backup |
| Mail account logins (encrypted with `SECRET_KEY`), sender addresses, signatures, saved searches, templates, trusted image senders, preferences, scheduled and outgoing mail, snoozes, OpenPGP and S/MIME keys, the link to Nextcloud, mail servers set up in the admin settings | NCMail's PostgreSQL only | **Yes:** PostgreSQL and `SECRET_KEY` (see [deployment.md](deployment.md#backups)) |

## 6. Performance

Measured on a laptop with a development mailbox of 109,482 messages (66,300 in the inbox, 43,000 conversations):

| What | Target | Measured |
| --- | --- | --- |
| First list painted, returning user | < 150 ms | **45 ms** (first-ever visit 61 ms) |
| Message list page, also 50,000 rows deep | < 150 ms | **2-3 ms** on the server |
| Switch to a folder / reopen it | instant | **37 ms** first time, **14 ms** cached |
| Open a message | instant | **12-30 ms** cold, 1-2 ms for recent (prefetched) mail |
| Search (rare word / common word / operators) | < 300 ms | **5 ms / 36 ms / 15-60 ms** |
| Initial sync of the 66,000-message inbox | first page in seconds | first page **1.1 s**, all mirrored in **21 s** |
| Web app download | small | **121 KB** gzipped JavaScript to start, plus 8 KB CSS; the editor (131 KB) loads when idle |

Many users, and a 500,000-message mailbox also through a 100 ms round trip to the mail server, are in
[scaling.md](scaling.md): pages stay under 25 ms and searches near 300 ms or less.

What made the difference: refreshing PostgreSQL statistics after big syncs, an index-union form for search instead of `OR EXISTS`, a
small partial index for unread counts, warm IMAP connections, prefetching the newest bodies, compression with ETag revalidation, a
cached last view, and prefetching on hover.

## 7. How it is tested

Every pull request runs, in CI:
- **About 500 API tests** against real Dovecot, PostgreSQL and Mailpit (`pnpm test`).
- **Browser tests** of the web app and the admin Mail page in Chromium, Firefox and WebKit (`pnpm test:e2e`).
- **The Nextcloud app in each supported Nextcloud version** (33, 34 and 35): install, sign-in through Nextcloud, the admin page's
  signed calls, sign-out (`pnpm test:nextcloud`).
- **An upgrade from the previous release** with real data, checking nothing is lost (`pnpm test:upgrade`).
- A dependency audit, a secret scan, and a check that the container image starts.

How to run them locally is in [CONTRIBUTING.md](../CONTRIBUTING.md): every change is checked with `pnpm verify` before it
is pushed.

## 8. Before 1.0

- **The Nextcloud App Store**, so administrators can install the app from Nextcloud's own app list ([app-store.md](app-store.md)).
- **A pass with screen readers** (VoiceOver and NVDA) and one tab stop per message row ([accessibility.md](accessibility.md)).
- **Use on real servers**: problems found in production use, such as servers that list folders they will not open.
