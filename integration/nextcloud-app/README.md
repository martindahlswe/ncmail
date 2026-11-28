# Mail app for Nextcloud

Adds **Mail** to the Nextcloud menu and shows the mail service (this repository) inside Nextcloud's own header. It is also what the mail service trusts to know who the user is:
the mail service only works when opened through this app.

What it does

- signs a short-lived token for the signed-in user (Ed25519, the private key stays in Nextcloud's encrypted app config); the frame hands it to the service, which opens a session
- renews that token while the Nextcloud session lives, and tells the service when the user signs out (their Mail sessions end) or is removed (everything kept for them is removed: accounts, mail, settings)
- unread count on the menu entry, search results in Nextcloud's search box, links that open a message or a new draft
- creates an app password for Files and Contacts the first time Mail opens (so there is no separate "connect" step)

## Install

Needs Nextcloud 30 to 33 and PHP libsodium (part of Nextcloud's requirements). Copy `ncmail/` to Nextcloud's `custom_apps/` (the dev stack mounts it), then:

```bash
occ app:enable ncmail
occ config:app:set ncmail url --value=https://mail.example.com          # where users' browsers reach the mail service
occ config:app:set ncmail serverUrl --value=http://mail-service:4000    # only if Nextcloud's server reaches it another way (optional)
```

The mail service needs `NCMAIL_AUTH=nextcloud` and `NEXTCLOUD_URL`. By default it fetches the public key from `<NEXTCLOUD_URL>/index.php/apps/ncmail/key`;
the key (and its id) is also shown in Nextcloud's admin settings, for pinning it with `NCMAIL_HANDOFF_PUBLIC_KEY`.
Pinning is recommended in production; the service only fetches the key over plain `http://` from a local or private address.
Rotate the key with `occ ncmail:rotate-key` (the previous key keeps working for an hour), or with `occ ncmail:rotate-key --revoke-previous`
after a key compromise (previous keys stop being published at once; restart the service or update the pinned key).

## What the people running Nextcloud need to know

- It is an ordinary app: no change to `config.php`. The only thing it asks of Nextcloud's security policy is to allow the mail service address in a frame; the app adds that itself through Nextcloud's content security policy API.
- Nextcloud's server must be able to call the mail service (badge, search, sign-out notice). Those calls are signed over the method, target host, path, time and body; unsigned, replayed or redirected calls are refused. This app version needs mail service 0.2.1 or newer.
- The app password it creates for the service is remembered by its id, so linking again or a failed hand-over revokes exactly that one (never another app password the user named "Mail"). App passwords created by app versions before 0.2.1 are not tracked; remove a leftover "Mail" entry on the security page if you like.
- "Send by mail" in Files opens the composer with the files attached only when the page is opened from Nextcloud itself (`Sec-Fetch-Site: same-origin`), so a link on another site cannot pre-fill attachments.
- Serve the mail service over HTTPS. If it is on another site than Nextcloud, its session cookie is `SameSite=None; Secure; Partitioned`.
- The mail service's address and Nextcloud's address are the only two origins that talk to each other in the browser (`postMessage`, both sides check the origin).
