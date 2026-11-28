# Deployment

NCMail has two parts: the **mail service** (a container plus PostgreSQL) and the **Nextcloud app** that shows it inside Nextcloud and vouches for the signed-in user.

## What you need

- A host that can run Docker, with PostgreSQL 15 or newer (the compose file includes one)
- A DNS name and an HTTPS certificate for the service, for example `mail.example.com`
- An administrator who can install a Nextcloud app (no `config.php` change)
- Network paths: users' browsers reach the service and Nextcloud; the service reaches Nextcloud and your mail servers; Nextcloud's server reaches the service

## Run the service

```bash
cp deploy/.env.example .env     # set NEXTCLOUD_URL, NCMAIL_PUBLIC_URL, POSTGRES_PASSWORD and SECRET_KEY
docker compose -f deploy/docker-compose.yml --env-file .env up -d
curl http://127.0.0.1:4000/api/health      # {"ok":true,"version":"0.1.0"}
```

The container listens on port 4000, published only on `127.0.0.1` by the compose file. The compose file runs a fixed version of the image, the release it came with, not `latest`; set `NCMAIL_VERSION` in `.env` to choose another.

**Run one instance of the service per database.** That is the supported setup: some coordination lives inside the running process (the per-account lock that keeps a folder sync from undoing folder changes, the live IMAP connections that deliver new mail, and the guard against syncing a folder twice at once), so two instances on the same database can work against each other. One instance handles many users (see [scaling.md](scaling.md)). If a second one starts on the same database, the service logs a warning and the admin **Mail** page shows it. For high availability, restart the one instance quickly (the compose file uses `restart: unless-stopped`) rather than running two side by side.

## Reverse proxy

Terminate HTTPS in front of the service and set `NCMAIL_TRUST_PROXY=1`. Nginx example:

```nginx
server {
  listen 443 ssl http2;
  server_name mail.example.com;
  # ssl_certificate ...

  client_max_body_size 110m;               # attachments up to 100 MB

  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_buffering off;                   # live updates use a long-lived event stream (/api/events)
    proxy_read_timeout 1h;
  }
}
```

Serve the service from the root of its own host name: signed requests from Nextcloud include the request path and host, so a path prefix that the proxy strips, or a proxy that does not pass on the `Host` header (`proxy_set_header Host $host`), would break them. `NCMAIL_TRUST_PROXY=1` means one proxy hop; set the number of proxies if there are more (see [configuration](configuration.md#network-and-security)). Set `NCMAIL_PUBLIC_URL=https://mail.example.com` too, so sign-in tokens issued for another address are refused.

## Install the Nextcloud app

The app is not in the Nextcloud App Store yet. Until it is, download `ncmail-<version>.tar.gz` from the release, unpack it into `custom_apps/`, and enable it:

```bash
tar -xzf ncmail-0.1.0.tar.gz -C /var/www/nextcloud/custom_apps/
occ app:enable ncmail
occ config:app:set ncmail url --value=https://mail.example.com
# only if Nextcloud's server reaches the service another way (for example inside a container network):
occ config:app:set ncmail serverUrl --value=http://ncmail:4000
```

The service fetches Nextcloud's public signing key by itself, over HTTPS (plain `http://` only for a local or private `NEXTCLOUD_URL`). Pinning it is recommended in production: copy the key from **Administration settings > Mail > Connection to the mail service** into `NCMAIL_HANDOFF_PUBLIC_KEY`, and update it after each key rotation.

Check it: sign in to Nextcloud, open **Mail** in the menu. If it shows "Open Mail from Nextcloud" or "Your session has ended", see Troubleshooting.

Notifications for new mail come from a background job of the app, so they appear within a minute when Nextcloud's background jobs run by **cron** (Administration settings > Basic settings). With AJAX background jobs they only show while someone has Nextcloud open. The app also adds "Send by mail" to Files and "Write an email" to the contacts menu; neither needs any setup.

## Mail servers

Either let each user enter their servers, or preconfigure them. The easiest way is Nextcloud's **Administration settings > Mail**, which needs no access to the mail service's files. To manage them as a file instead (or as well), use `NCMAIL_MAIL_CONFIG` (see [configuration.md](configuration.md#mail-servers)) and mount the file into the container:

```yaml
    environment:
      NCMAIL_MAIL_CONFIG: /config/mail-servers.json
    volumes:
      - ./mail-servers.json:/config/mail-servers.json:ro
```

## Monitoring

`GET /api/health` answers `{"ok":true,"version":"…"}` when the service and its database work. For more, turn on metrics in Prometheus' text format: they are served on a port of their own, never on the API's.

```yaml
    environment:
      NCMAIL_METRICS_PORT: "9464"
      NCMAIL_METRICS_HOST: 0.0.0.0     # inside the container; the port is published on the host's loopback only
    ports: ["127.0.0.1:4000:4000", "127.0.0.1:9464:9464"]
```

Then scrape `http://127.0.0.1:9464/metrics`. Worth watching:

| Metric | What it tells you |
| --- | --- |
| `ncmail_database_up`, `ncmail_info` | The service is up, its database answers, and which version runs |
| `ncmail_event_loop_delay_seconds{quantile="0.99"}` | Over about 0.5 s, the service is overloaded |
| `ncmail_sync_heavy{state="waiting"}` | Big imports waiting for a slot (raise `NCMAIL_MAX_HEAVY_SYNCS` if it stays high) |
| `ncmail_imap_idle_accounts` | Accounts by the state of their live connection to the mail server (anything other than `idle` falls back to polling) |
| `ncmail_http_requests_total{status="5xx"}` | Errors answering requests |
| `ncmail_outbox_messages{state="failed"}` | Messages that could not be sent |
| `ncmail_mail_server_checks{state="failing"}` | The administrator's mail servers not answering (see the admin Mail page) |
| `ncmail_other_instances` | Should be 0: a second instance on the same database (see above) |
| `ncmail_db_pool_connections`, `ncmail_imap_pool_connections`, `ncmail_memory_bytes` | Resources in use |

The metrics are counts only: no addresses, subjects, user ids or server names.

## Backups

Back up PostgreSQL (`pg_dump`) and `SECRET_KEY`. The database holds accounts, encrypted secrets, labels, scheduled messages and a rebuildable copy of message headers: if only the mirror is lost, sync rebuilds it from the mail servers. Encrypt the database volume: the mirror holds message headers (sender, subject, date) unencrypted.

## Rotating the secret key

1. Put the old key in `SECRET_KEY_OLD` and a new one in `SECRET_KEY`, and restart.
2. Run `docker compose exec ncmail node --import tsx scripts/rotate-key.ts` (it re-encrypts every stored secret). A value it cannot read is listed (table and row) and skipped, and the command then exits with an error.
3. Remove `SECRET_KEY_OLD` once the command reports that everything is under the current key.

## Rotating Nextcloud's signing key

`occ ncmail:rotate-key` creates a new key; the previous one keeps working for an hour. If you pinned `NCMAIL_HANDOFF_PUBLIC_KEY`, set it to the new key (the command prints it).

If the private key may have leaked, run `occ ncmail:rotate-key --revoke-previous`: Nextcloud stops publishing every previous key at once. Then set the pinned `NCMAIL_HANDOFF_PUBLIC_KEY` to the new key, or, if the service fetches the key, restart it so it drops a key it fetched earlier (it keeps fetched keys for up to 10 minutes). Users signing in during that moment may need to open Mail again.

## Updating

Set `NCMAIL_VERSION` in `.env` to the new release (for example `NCMAIL_VERSION=0.1.1`), then:

```bash
docker compose -f deploy/docker-compose.yml --env-file .env pull
docker compose -f deploy/docker-compose.yml --env-file .env up -d
```

and replace the app folder in `custom_apps/` with the new release (then `occ upgrade` if Nextcloud asks). Update the service first: a newer service accepts calls from an older Nextcloud app, but not always the other way round (the 0.2.1 app signs the target host, which older services do not understand). The database is migrated when the service starts. See the [changelog](../CHANGELOG.md).

Afterwards, open **Administration settings > Mail**. It shows both versions, and when they differ it says which one to update. It also says when one side is too old to work with the other at all. The service logs a warning when calls come from a Nextcloud app that is older or out of step. If Nextcloud still reports the old app version after you replaced the folder, run `occ upgrade`.

## Development without Nextcloud

Leave `NCMAIL_AUTH` empty: the service is single-user and local only. It must listen on a loopback address (the default `API_HOST=127.0.0.1`) and answers only connections from the same machine addressed to `localhost`; with any other `API_HOST` it refuses to start. This is for development, not for sharing. The container image listens on `0.0.0.0`, so run it with `NCMAIL_AUTH=nextcloud` and `NEXTCLOUD_URL` (or, only on a closed network, `NCMAIL_AUTH=off`).

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "Open Mail from Nextcloud" in a browser tab | Expected: the service is only shown inside Nextcloud |
| Blank frame in Nextcloud | The service address is not allowed in a frame (check `occ config:app:get ncmail url` matches exactly), or the proxy strips headers |
| "Your session has ended" right away | The service cannot get Nextcloud's key (check `NEXTCLOUD_URL`; it is not fetched over plain `http://` from a public address; or pin `NCMAIL_HANDOFF_PUBLIC_KEY`), `NCMAIL_PUBLIC_URL` differs from the app's `url` setting, or the clocks differ by more than a minute |
| No badge or search after updating the Nextcloud app | The service is older than the app (update it), or a proxy rewrites the `Host` header of Nextcloud's signed calls |
| No unread badge, search or sign-out notice | Nextcloud's server cannot reach the service (set `serverUrl`). Mail itself still works |
| "...is on a private or local network" when adding an account | The mail server's address resolves to a private IP; add it under Mail servers in Nextcloud's admin settings, in `NCMAIL_MAIL_CONFIG`, or in `NCMAIL_PRIVATE_HOSTS` |
| Sessions do not stick in the frame | The service is not on HTTPS: framed on another site, the cookie needs `Secure` |
| "Another NCMail service instance is using this database" in the log, or the warning on the admin Mail page | Two services share one database (an old container still running, or two replicas). Stop all but one |
