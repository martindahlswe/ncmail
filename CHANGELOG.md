# Changelog

All notable changes to NCMail are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-28

The first release: a webmail client for IMAP and SMTP that runs as an app inside Nextcloud. It has two parts, a mail
service (container image `ghcr.io/martindahlswe/ncmail`, amd64 and arm64) and a Nextcloud app (`ncmail-0.1.0.tar.gz`
into `custom_apps/`). The app supports Nextcloud 33, 34 and 35. See [docs/deployment.md](docs/deployment.md).

### Reading and organizing mail
- IMAP and SMTP with any server. Headers are mirrored into PostgreSQL, so lists, paging, search and counts stay fast in
  big mailboxes, with live updates through IMAP IDLE and polling. The first sync fetches the last 24 months by default;
  older mail is found by search and loaded on demand.
- Several accounts, an **All inboxes** view, and conversations grouped by reply headers. Mail without reply headers is
  grouped by subject only when it clearly belongs together (a reply or forward, at most 60 days apart, someone in
  common, not a generic subject).
- Selection like a desktop client (click, Ctrl/⌘-click, Shift-click, Shift+arrows, select all), bulk actions, drag and
  drop to folders, and right-click menus on messages, folders, senders, attachments and recipients. Message actions use
  one order and the same names everywhere, and questions are asked in Mail's own dialogs.
- Create, rename, move and delete folders and subfolders on the mail server. Renaming keeps the mail and updates filters
  that file into the folder; deleting moves it into Trash, with Undo. Special folders cannot be renamed or deleted.
- Labels (IMAP keywords), saved searches, snooze, filters and out-of-office as a Sieve script (ManageSieve).
- Shared and public folders as the mail server offers them (IMAP namespaces and ACLs, for example Dovecot or Cyrus).
  Mail offers only what the server allows, and you can share your own folders as read-only or read and change. A
  shared folder the server lists but will not open is left out until it opens.
- Unsubscribe from mailing lists: one click where the list supports it (RFC 8058) and a matching DKIM signature passed,
  otherwise a mail to the list's address or its own page. Not offered in Junk.
- Reply to list (`l`), forward as attachment (.eml), view source, print, download .eml, and previews of images, PDFs,
  text, audio and video attachments.
- Read receipts: when a message asks for one, Mail offers to send it and remembers the answer (`$MDNSent`). Never sent
  without asking.

### Writing
- A rich-text composer with drafts saved as you type, attachments with progress, templates, undo send and send later
  (scheduled mail waits on the server).
- Several sender addresses per account, each with its own name, signature and optional Reply-To. Replies and forwards
  start from the address the message reached, also for Bcc and forwarded mail.
- Pictures in the text and in signatures, sent as inline parts and scaled down when large. HTML signatures pasted as
  source or copied from a web page are kept as they are, with a preview, and sent unchanged.
- A reminder when the text mentions an attachment and nothing is attached, and an option to ask for a read receipt.

### Search
- Operators `from:`, `to:`, `cc:`, `subject:`, `has:attachment`, `is:`, `label:`, `before:`, `after:` and `in:`, with
  `-` to negate. Search covers synced mail and older mail still on the server, and an optional full-text index of
  message bodies.

### Security and privacy
- Remote images are blocked until you load them. Images can always be shown from a sender or a domain, but only when
  the receiving server confirmed the From domain, and never in Junk.
- Phishing cues: SPF, DKIM and DMARC verdicts, look-alike domains, display-name tricks and deceptive links.
- OpenPGP and S/MIME signing, encryption, verification and decryption, with private keys stored encrypted. Encrypted mail
  with Bcc is sent as separate copies, and drafts of encrypted messages are stored encrypted to your own key.
- Message HTML is sanitized and shown in a sandboxed frame. Security headers and a content security policy on every
  response, and changes from other sites are refused.
- An outbound address policy (no private networks by default, `NCMAIL_PRIVATE_HOSTS`), an option to require TLS
  (`NCMAIL_REQUIRE_TLS`), versioned encryption keys with `rotate-key`, and limits that protect other users (accounts,
  live connections, uploads, attachments, queued mail, search terms, database time per request).
- The service refuses to start without sign-in on an address other machines can reach. See
  [docs/security-review.md](docs/security-review.md).

### Nextcloud integration
- Mail in the Nextcloud menu, inside Nextcloud's header, with Nextcloud's theme (branding, colours, light and dark).
- Sign-in through Nextcloud: the app signs a short-lived, single-use token (Ed25519) and the service holds only the
  public key. Sessions are short and end when the user signs out of Nextcloud or is removed. Server-to-server calls are
  signed together with the host they are meant for.
- Recipient suggestions from Contacts, attaching files from Files and saving attachments to Files, made through an app
  password that Nextcloud creates for Mail and that is revoked on disconnect.
- New mail in Nextcloud's notifications, the unread count on the menu entry, mail in Nextcloud's search, "Send by mail"
  in Files, "Write an email" in the contacts menu, and links that open a message or a new draft.
- Create a task, Create an event and Share to Talk from a message, each offered only when Nextcloud has the app.
- Calendar invitations are added to a Nextcloud calendar as tentative entries, and your answer there is carried back to
  the message. Updates and cancellations are applied automatically only from the event's organizer.
- When Nextcloud deletes a user, Mail deletes everything it kept for that user.

### Administration and operations
- Mail servers for everyone are set up on Nextcloud's **Administration settings > Mail** page: a domain lookup
  (autoconfig, DNS SRV, Thunderbird's list of providers), connection checks every 6 hours, a preview of what people
  see, and an option to limit people to the listed servers. `NCMAIL_MAIL_CONFIG` also works.
- People adding their own account get their servers looked up from their address when the administrator allows it.
- The admin page shows the versions of the app and the service and says which one to update when they do not match. It
  also warns when a second instance uses the same database; one instance per database is the supported setup.
- Metrics in Prometheus' format on a port of their own (`NCMAIL_METRICS_PORT`, off by default).
- Errors from the mail server are reported in plain words. `deploy/docker-compose.yml` runs a fixed version
  (`NCMAIL_VERSION`).

### Performance and accessibility
- Built for big mailboxes: sender and subject searches in a 500,000-message mailbox use the search index and answer
  well under 300 ms. Big imports take fair turns between users. See [docs/scaling.md](docs/scaling.md).
- Accessibility to WCAG 2.2 AA: focus handling in dialogs, a **Skip to messages** link, keyboard shortcuts, and
  contrast checks. Automated (axe-core) and keyboard-only checks run on every change. See
  [docs/accessibility.md](docs/accessibility.md).

### Notes
- Notifications for new mail appear within a minute when Nextcloud's background jobs run by cron; with AJAX background
  jobs only while someone has Nextcloud open.
- Shared folders follow the mail server's own permissions, which servers cache briefly, so a change can take a few
  minutes to show.

[Unreleased]: https://github.com/martindahlswe/ncmail/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/martindahlswe/ncmail/releases/tag/v0.1.0
