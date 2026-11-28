# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use
[GitHub private vulnerability reporting](https://github.com/martindahlswe/ncmail/security/advisories/new) instead.
You should get a response within a week.

## How NCMail handles credentials and access

- **No passwords for NCMail itself.** The Nextcloud app signs a token (Ed25519) saying who is signed in; the mail
  service holds only the public key and can verify tokens but never create them. Tokens are valid for a minute,
  work once and name the address they were issued for (checked when `NCMAIL_PUBLIC_URL` is set). Sessions last
  minutes, are renewed only while the Nextcloud session lives, and end at once when Nextcloud reports a sign-out.
  Pin the public key with `NCMAIL_HANDOFF_PUBLIC_KEY` in production; when it is fetched instead, that happens over
  HTTPS (plain HTTP only from a local or private address). Calls from Nextcloud's server are signed over the target
  host too, so they cannot be replayed at another mail service.
- **Mail passwords** are encrypted with AES-256-GCM under `SECRET_KEY` (versioned, with key rotation) before they are
  stored. They are only sent to the mail servers the user or an administrator configured.
- **Nextcloud access** (Files, Contacts, Tasks, Calendar, Talk, notifications) uses a dedicated app password that Nextcloud creates for the user. It is revoked when
  the user disconnects Mail or Mail links again, and when a sign-in approved as another user is refused, and can be revoked at any time on Nextcloud's security page. The user's own Nextcloud
  password never reaches NCMail.
- **Mail content** is sanitised and shown in a sandboxed frame without scripts; remote images are blocked until the
  user allows them; links that look deceptive ask before opening.
- **Every request is checked** against the signed-in user: accounts, folders, messages, keys and uploads belong to
  one user, and other users get "not found".
- **The server connects only where it should.** Mail, Sieve and calendar hosts on private or loopback networks are
  refused unless an administrator lists them (`NCMAIL_PRIVATE_HOSTS`, `NCMAIL_MAIL_CONFIG`).
- **One user cannot exhaust the service for others:** attachments waiting to be sent, the outbox, mail accounts, live-update
  connections, search terms and database time per request are limited, and big imports take fair turns
  (see [configuration](docs/configuration.md#network-and-security)).
- Cross-origin requests are refused (as are changes that carry the session cookie but neither `Origin` nor
  `Sec-Fetch-Site`), responses carry a content security policy, and internal errors are not shown to users.

The full review, with what was found and fixed, is in [docs/security-review.md](docs/security-review.md). Known limits
are listed there too (for example: no CRL/OCSP checks for S/MIME, and the local copy of message headers in PostgreSQL is
not encrypted by the application, so use disk encryption for the database volume).

## Supported versions

Security fixes go into the latest release.
