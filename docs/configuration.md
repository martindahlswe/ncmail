# Configuration

The service reads environment variables (a `.env` file works in development, `environment:` in the compose file in production).

## Required

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string, for example `postgres://ncmail:secret@postgres:5432/ncmail`. Tables are created and migrated on start. |
| `SECRET_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts stored mail passwords, app passwords and private keys. Back it up: without it stored passwords cannot be read. |

## Nextcloud

| Variable | Default | Meaning |
| --- | --- | --- |
| `NEXTCLOUD_URL` | | Where your Nextcloud is, for example `https://cloud.example.com`. The theme, the signing key and Files/Contacts come from here. |
| `NCMAIL_AUTH` | | `nextcloud`: Mail only works inside Nextcloud and accounts belong to Nextcloud users (needs `NEXTCLOUD_URL`; the service refuses to start without a valid one). Empty: single user, local only: the service must listen on a loopback `API_HOST` and answers only connections from the same machine (it refuses to start otherwise, so the container image needs `nextcloud` or `off`). `off`: no sign-in and reachable from anywhere (only on a closed network). Any other value is refused at startup. |
| `NCMAIL_HANDOFF_PUBLIC_KEY` | fetched from Nextcloud | Pin Nextcloud's signing key (base64; shown in Nextcloud's admin settings) instead of fetching it from `<NEXTCLOUD_URL>/index.php/apps/ncmail/key`. Several keys can be separated by commas. Recommended in production: a pinned key does not depend on the network path to Nextcloud. After `occ ncmail:rotate-key`, set it to the new key. |
| `NCMAIL_HANDOFF_KEY_HTTP` | | The key is fetched over plain `http://` only when `NEXTCLOUD_URL` is a loopback or private address, `localhost`, or a single-label host name such as a container name. `1` allows any `http://` address (not recommended: whoever can change the answer can sign in as anybody). |
| `NCMAIL_SESSION_MINUTES` | `15` | How long a session lasts without a fresh token from Nextcloud. It is renewed every few minutes while the Nextcloud session lives. |
| `NCMAIL_PUBLIC_URL` | | The address users' browsers use for Mail, the same as the Nextcloud app's `url` setting. Recommended: sign-in tokens name the address they were issued for, and when this is set, tokens for another address are refused. Without it the service has no trustworthy address to compare with (the `Host` header is chosen by the sender), so tokens only have to name some address, and a warning is logged at startup. |
| `NCMAIL_ALLOW_STANDALONE` | | `1` lets a browser tab open the page directly (development only; refused when `NODE_ENV=production`). |

In Nextcloud, the app has two settings: `occ config:app:set ncmail url --value=https://mail.example.com` (where users' browsers reach the service) and, only if Nextcloud's server reaches it another way, `serverUrl`.

## Network and security

| Variable | Default | Meaning |
| --- | --- | --- |
| `API_PORT` / `API_HOST` | `4000` / `127.0.0.1` | Where the service listens. The container image sets `API_HOST=0.0.0.0`, so it also needs `NCMAIL_AUTH=nextcloud` (or `off`). |
| `NCMAIL_TRUST_PROXY` | | Behind a reverse proxy: the number of proxies in front of the service whose `X-Forwarded-*` entries are believed for the client address, protocol and host. `1` (one proxy, the usual case) takes the entry that proxy added and ignores anything a client put before it; use `2` for a CDN or load balancer in front of the proxy. A comma-separated list of proxy addresses or ranges (`10.0.0.0/8,127.0.0.1`) also works. Before 0.2.1, `1` trusted every hop. |
| `NCMAIL_COOKIE_SECURE` | | `1` forces the `Secure` cookie attributes (they are also set automatically over HTTPS). |
| `NCMAIL_PRIVATE_HOSTS` | `block` with sign-in, else `allow` | Whether the service may connect to mail, Sieve and calendar servers on private or loopback addresses. `allow`, `block`, or a comma-separated allow-list (`mail.internal,10.0.0.5,10.1.0.0/16`). Mail servers set up under Mail servers (in Nextcloud's admin settings or `NCMAIL_MAIL_CONFIG`) are allowed on their own IMAP, SMTP and ManageSieve ports, not on other ports and not for calendars or unsubscribe links. |
| `NCMAIL_REQUIRE_TLS` | | `1` refuses unencrypted IMAP, SMTP, Sieve and `http://` addresses. |
| `NCMAIL_METRICS_PORT` | | A port for metrics in Prometheus' format (`GET /metrics`), served apart from the API. Off when unset. See [Monitoring](deployment.md#monitoring). |
| `NCMAIL_METRICS_HOST` | `127.0.0.1` | Where the metrics port listens. In a container use `0.0.0.0` and publish the port only on the host's `127.0.0.1`. |
| `NCMAIL_SERVER_CHECK_HOURS` | `6` | How often the mail servers listed in Nextcloud's admin settings (and `NCMAIL_MAIL_CONFIG`) are checked in the background, without logging in (`0` = never). |
| `NCMAIL_ISPDB` | | `0` stops server lookups (the admin page's **Add mail server**, and people adding their own account) from asking Thunderbird's public list of mail providers (autoconfig.thunderbird.net) when a domain publishes no settings of its own. |
| `SECRET_KEY_OLD` | | Previous key(s) while rotating `SECRET_KEY` (see [deployment](deployment.md#rotating-the-secret-key)). |
| `NCMAIL_UPLOAD_QUOTA_MB` | `500` | Attachments waiting to be sent, per user (uploads still in progress count too). One message's attachments together may be at most 100 MB, or this quota if it is smaller, and at most 100 files. |
| `NCMAIL_OUTBOX_MAX` | `100` | Messages one user may have waiting in the outbox (undo send and send later together). |
| `NCMAIL_MAX_ACCOUNTS` | `20` | Mail accounts one user may add (`0` = no limit). Adding one more is refused with a message; existing accounts are not affected. |
| `NCMAIL_MAX_EVENT_STREAMS` | `10` | Live-update connections (open Mail windows or tabs) per user. A window beyond this works normally but gets no live updates; it tries again every minute. A window that reads updates too slowly is disconnected and reconnects. |
| `NCMAIL_STATEMENT_TIMEOUT_MS` | `30000` | Longest a single database statement made for a request may run before Postgres cancels it (`0` = no limit); the request then answers 503. Searches are also limited to 30 words or operators and 1,000 characters. |
| `NCMAIL_BACKGROUND_STATEMENT_TIMEOUT_MS` | `0` | The same for background work (syncs, the body index, migrations, removing an account), which uses its own pool of up to 5 database connections. `0` = no limit. |
| `NCMAIL_BODY_CACHE_DAYS` | `90` | How long cached message bodies are kept (`0` = forever). They are fetched again when opened. |

## Mail servers

Mail servers set up for everyone mean users only enter their address and password. There are two ways to set them up, and they can be combined.

**In Nextcloud (recommended).** As a Nextcloud administrator, open **Administration settings > Mail**:

- **Add mail server** asks for a domain your people use and looks up its servers. It tries the domain's own autoconfig file, then its DNS SRV records (RFC 6186), then Thunderbird's public list of mail providers. Only the domain is sent to that list, and `NCMAIL_ISPDB=0` turns it off. Each server found is checked before you confirm. **Enter the servers myself** opens the full form instead.
- **The form** asks for a name, the address domains the server is suggested for, what people sign in with (each choice shows an example), the IMAP and SMTP servers, and optionally the ManageSieve server for filters. Choosing the security moves the port along (993/143, 465/587, 4190).
- **Check connection** connects to each server without logging in. It reports whether the server answers, until when its certificate is valid, and whether it is unencrypted. If the chosen port does not answer but a usual one does, it offers to switch, for example **Use 587**.
- **The list** shows each server's state from its last check: working, certificate expiring within 14 days, not encrypted, or not answering. Servers are checked when they are saved, every `NCMAIL_SERVER_CHECK_HOURS` hours (default 6, `0` turns it off), and on **Check all**.
- **Which servers can people use?** is the `allowCustom` setting below.
- **What people see** previews the add-account form for an address you type.

Only administrators can open this page. Nextcloud passes changes to the mail service with its signed server-to-server calls, and the service keeps them in its database. Each change is logged with the administrator's user id. The page also holds the connection details between Nextcloud and the mail service (under **Connection to the mail service**).

**In a file.** `NCMAIL_MAIL_CONFIG` points to a JSON file (see [`deploy/mail-servers.example.json`](../deploy/mail-servers.example.json)). Its servers appear in the admin settings marked "From the configuration file" and can only be changed in the file. If either the file or the admin settings sets `allowCustom: false`, users are locked to the list: the stricter setting wins.

```json
{
  "allowCustom": true,
  "servers": [
    {
      "id": "corp",
      "name": "Company mail",
      "domains": ["example.com"],
      "username": "email",
      "imap": { "host": "imap.example.com", "port": 993, "security": "tls" },
      "smtp": { "host": "smtp.example.com", "port": 465, "security": "tls" },
      "sieve": { "host": "imap.example.com", "port": 4190, "security": "starttls" }
    }
  ]
}
```

- `domains`: users whose address is in one of these domains get this server suggested. With one server, it is suggested to everybody.
- `username`: what users log in with: `email` (the address), `local` (the part before the `@`) or `uid` (the Nextcloud user id).
- `allowCustom`: `true` (default) lets users enter their own servers when theirs is not listed; `false` locks them to the list.
- `sieve` is optional: where filters and out-of-office are stored for accounts on these servers.
- `security` is `tls` (SSL/TLS), `starttls` or `none`.

The file is re-read when it changes; a mistake in it is logged and ignored.

## Big mailboxes and many users

| Variable | Default | Meaning |
| --- | --- | --- |
| `NCMAIL_INITIAL_SYNC_MONTHS` | `24` | How far back the first sync of a folder goes (`0` = everything). Can be changed per account in the settings. Older mail stays on the server, and search still finds it. |
| `NCMAIL_MAX_HEAVY_SYNCS` | `2` | Big imports that run at the same time; the rest wait and the folder says so. While other users wait, one user holds at most one of these slots. |
| `NCMAIL_IMAP_MAX_AGE_MS` | `120000` | How long a pooled IMAP connection is reused before it is replaced. Servers keep some state per connection (for example which folders were shared with you), so connections are renewed even while in use. |
| `NCMAIL_HEAVY_ROWS` | | Folder size from which an import counts as big. |
| `NCMAIL_MAX_OLDER_SEARCHES` | `4` | Searches of older, unsynced mail that run at the same time. |
| `NCMAIL_CAP_MIN_MESSAGES` | | Smallest folder that the sync window is applied to. |
| `NCMAIL_NO_LIST_STATUS`, `NCMAIL_STATUS_BUDGET` | | Tuning for servers that are slow at folder counts. |
| `NCMAIL_BG_TICK_MS`, `NCMAIL_BG_HEALTHY_MS`, `NCMAIL_BG_DEGRADED_MS` | | How often the background sync checks accounts that IDLE keeps up to date or not. |
| `NCMAIL_SNOOZE_TICK_MS`, `NCMAIL_CALENDAR_POLL_MS` | | How often snoozed messages and calendar answers are checked. |

See [scaling.md](scaling.md) for measured numbers.
