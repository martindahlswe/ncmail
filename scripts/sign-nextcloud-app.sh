#!/bin/sh
# Adds Nextcloud's code signature (appinfo/signature.json) to integration/nextcloud-app/ncmail, using occ in a throwaway
# Nextcloud container. Run it before scripts/package-nextcloud-app.mjs.
#
# Needs, in the environment: NEXTCLOUD_APP_KEY and NEXTCLOUD_APP_CERT, the PEM contents of the app's signing key and of the
# certificate Nextcloud issued for it (docs/app-store.md). Neither is written anywhere but a private temporary folder, which
# is removed afterwards.
set -eu
: "${NEXTCLOUD_APP_KEY:?set NEXTCLOUD_APP_KEY to the signing key (PEM)}"
: "${NEXTCLOUD_APP_CERT:?set NEXTCLOUD_APP_CERT to the certificate (PEM)}"
APP="$(cd "$(dirname "$0")/.." && pwd)/integration/nextcloud-app/ncmail"
NAME="ncmail-sign-$$"
IMAGE="${NC_SIGN_IMAGE:-nextcloud:33-apache}"
TMP="$(mktemp -d)"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
umask 077
printf '%s\n' "$NEXTCLOUD_APP_KEY" > "$TMP/app.key"
printf '%s\n' "$NEXTCLOUD_APP_CERT" > "$TMP/app.crt"
rm -f "$APP/appinfo/signature.json"

docker run -d --name "$NAME" -e SQLITE_DATABASE=nextcloud -e NEXTCLOUD_ADMIN_USER=signer \
  -e NEXTCLOUD_ADMIN_PASSWORD="$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')" "$IMAGE" >/dev/null
i=0
until docker exec -u www-data "$NAME" php occ status --output=json 2>/dev/null | grep -q '"installed":true'; do
  i=$((i + 1)); [ "$i" -gt 180 ] && { echo "Nextcloud did not finish installing" >&2; docker logs --tail 40 "$NAME" >&2; exit 1; }
  sleep 2
done

docker exec "$NAME" mkdir -p /tmp/sign
docker cp "$APP" "$NAME:/tmp/sign/ncmail"
docker cp "$TMP/app.key" "$NAME:/tmp/sign/app.key"
docker cp "$TMP/app.crt" "$NAME:/tmp/sign/app.crt"
docker exec "$NAME" chown -R www-data:www-data /tmp/sign
docker exec -u www-data "$NAME" php occ integrity:sign-app --privateKey=/tmp/sign/app.key --certificate=/tmp/sign/app.crt --path=/tmp/sign/ncmail
docker cp "$NAME:/tmp/sign/ncmail/appinfo/signature.json" "$APP/appinfo/signature.json"
echo "Signed: $APP/appinfo/signature.json"
