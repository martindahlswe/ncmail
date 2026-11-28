# Publishing the Nextcloud app to the App Store

For maintainers. The App Store only accepts apps signed with a certificate that Nextcloud issues for the app id (`ncmail`). The
signing and the upload are automated; getting the certificate and registering the app are done once, by hand.

## 1. Request the certificate (once)

1. Create the app's signing key and a certificate request, on your own machine:

   ```bash
   openssl req -nodes -newkey rsa:4096 -keyout ncmail.key -out ncmail.csr -subj "/CN=ncmail"
   ```

   `ncmail.key` is the app's private signing key. Keep it safe and never commit it (`.gitignore` excludes `*.key` and `*.csr`).
   Whoever has it can publish releases of this app.
2. Open a pull request to [nextcloud/app-certificate-requests](https://github.com/nextcloud/app-certificate-requests) that adds
   `ncmail/ncmail.csr`. Follow that repository's README; the Nextcloud team reviews it, which can take a few days.
3. When it is merged, the signed certificate is in that repository as `ncmail/ncmail.crt`. Download it.

## 2. Register the app (once)

1. Sign in at [apps.nextcloud.com](https://apps.nextcloud.com) and choose **Register app**.
2. Paste the certificate (`ncmail.crt`) and a signature of the app id:

   ```bash
   echo -n "ncmail" | openssl dgst -sha512 -sign ncmail.key | openssl base64
   ```

3. Under your account, create an **API token** for uploading releases.

## 3. Add the secrets (once)

In the repository's **Settings > Secrets and variables > Actions**, add:

| Secret | Contents |
| --- | --- |
| `NEXTCLOUD_APP_KEY` | the whole of `ncmail.key` |
| `NEXTCLOUD_APP_CERT` | the whole of `ncmail.crt` |
| `NEXTCLOUD_APPSTORE_TOKEN` | the App Store API token |

From then on, the **Release** workflow signs the app (`scripts/sign-nextcloud-app.sh` adds `appinfo/signature.json`) before it
builds the archive. Without the secrets it builds an unsigned archive, which still installs by hand.

## 4. Upload a release (each time)

Uploading is never automatic. After a release is published (with a signed archive):

1. Open **Actions > App Store > Run workflow** and enter the tag, for example `v1.0.0`.
2. Approve the run in the `release` environment, as for the container image.

The workflow checks that the release is published and its archive signed, signs the archive for the App Store with the app's
key, and hands the App Store the download link of the release's archive. The new version then shows up in Nextcloud's Apps page
and with `occ app:update ncmail`.

## Renewing or losing the key

The certificate is tied to the key. If the key is lost or leaked, request a new certificate (step 1) and tell the Nextcloud team
to revoke the old one; until then, anyone with the old key could publish a release of this app.
