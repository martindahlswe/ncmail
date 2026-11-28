# Contributing to NCMail

Thanks for helping out! Bug reports, feature ideas and pull requests are all welcome.

## Getting started

You need Node.js 22 or newer, pnpm, Docker and a PostgreSQL database for the app.

```bash
cp .env.example .env       # set SECRET_KEY (openssl rand -base64 32) and DATABASE_URL
pnpm install
pnpm dev                   # API on :4000, web app on :5173 with hot reload
```

Without `NCMAIL_AUTH` the app is single-user and answers only on `localhost`, which is what you want for most work.

**A mail server to develop against.** Use any IMAP and SMTP server with a test account, or the throwaway servers the tests
use: `pnpm test:up` starts Dovecot (IMAP `localhost:11143`, ManageSieve `:14190`) and Mailpit (SMTP `localhost:11025`,
web UI http://localhost:18025), all in memory. Add an account with user `u08@example.test`, password `test`, security
*None*: the test suite resets the mailboxes it uses, and u07, u08 and u28 are ones it leaves alone. The servers are
on this machine, so set `NCMAIL_PRIVATE_HOSTS=allow` if you turned sign-in on.

**Inside Nextcloud.** Mount `integration/nextcloud-app/ncmail` into a Nextcloud 33, 34 or 35 as `custom_apps/ncmail`, enable
it, and set these in `.env`:

```
NEXTCLOUD_URL=http://localhost:8080      # your Nextcloud
NCMAIL_AUTH=nextcloud
NCMAIL_PRIVATE_HOSTS=allow               # mail servers on this machine
```

Build the web app first (`pnpm build`): in this mode the API serves it on :4000. Tell the app where the service is with
`occ config:app:set ncmail url --value=http://localhost:4000` (the address browsers use), and, when Nextcloud runs in a
container, `occ config:app:set ncmail serverUrl --value=http://host.docker.internal:4000` (the address Nextcloud itself
uses). `e2e/nextcloud/setup.ts` sets up exactly this for the Nextcloud tests.

## Checks: run them before you push

**Run `pnpm verify` and push only when it passes.** It runs what CI runs, in the same order:

```bash
pnpm verify          # typecheck, version check, the API tests, the build, the browser tests (Chromium and WebKit)
pnpm verify:full     # also the Nextcloud tests (Nextcloud 34) and the upgrade test
```

It starts the test servers (`pnpm test:up`) when they are not running. CI also runs the browser tests in Firefox, every
supported Nextcloud version, the container build and a secret scan; a failure there that you could not have seen locally
is fine, but a broken typecheck or test on GitHub is not. To make it automatic, add a pre-push hook:

```bash
printf '#!/bin/sh\nexec pnpm verify\n' > .git/hooks/pre-push && chmod +x .git/hooks/pre-push
```

The individual steps:

```bash
pnpm typecheck
pnpm test:up               # throwaway PostgreSQL, Dovecot and Mailpit (in memory, separate ports)
pnpm test                  # about 500 unit and integration tests against the real API
pnpm build && pnpm test:e2e   # browser tests of the web app, in Chromium, Firefox and WebKit
pnpm test:down
```

Tests never touch your development database or real mail servers. `DEBUG_TEST_SERVER=1 pnpm test` prints the test servers' own log.

**Browser tests** (`e2e/`, Playwright) start their own API on port 4200 with its own database (`ncmail_e2e`), serving the
built web app, and seed the test user `u05@example.test`. They cover reading and writing mail, the keyboard, automated
accessibility checks, signatures, and the Nextcloud app's admin Mail page (loaded in a stand-in page with the Nextcloud
routes faked). The first time, install the browsers with `pnpm --filter @ncmail/e2e exec playwright install chromium firefox webkit`.
Useful while working on them:

```bash
pnpm --filter @ncmail/e2e exec playwright test --project=webkit      # one engine
pnpm --filter @ncmail/e2e exec playwright test --ui                  # watch them run, step through
pnpm --filter @ncmail/e2e exec playwright show-trace e2e/test-results/<test>/trace.zip   # what happened in a failed test
```

When a browser test fails in CI, its screenshots and traces are attached to the run as `browser-test-report`.

**Nextcloud versions** (`e2e/nextcloud/`): a throwaway Nextcloud of a given version (SQLite, port 8099) with the app folder
mounted, and the mail service with Nextcloud sign-in (port 4400). The tests check that the app installs and is enabled,
that **Mail** in the menu opens the app signed in as the Nextcloud user, that the admin **Mail** page reaches the service
through signed calls, and that signing out of Nextcloud ends the Mail session. CI runs them for every version
`appinfo/info.xml` declares (33 to 35, the versions Nextcloud maintains); when you change `min-version` or `max-version`,
change the matrix in `.github/workflows/ci.yml` too (a CI step checks they agree). Locally:

```bash
pnpm test:up
NC_VERSION=34 pnpm test:nextcloud       # KEEP_NEXTCLOUD=1 leaves the Nextcloud running afterwards to look around
```

**Upgrade test** (`apps/api/test/upgrade/run.ts`): the latest published release's image builds up data (an account with
read, starred and labelled mail, a second sender address, a label, a saved search, a sync window, a template, a trusted
image sender, a scheduled message, preferences, and mail servers set up in Nextcloud's admin settings), then an image of
the current code takes over the same database. It fails if anything is lost or if new mail, reading and sending stop
working. Until a release is published it has nothing to start from and says so. Locally:

```bash
pnpm test:up
docker build -t ncmail:upgrade-new .
pnpm test:upgrade                       # OLD_IMAGE=ghcr.io/martindahlswe/ncmail:<version> to start from another release
```

When you add a kind of data people keep (a new table or setting), add it to the test's seed and snapshot.

## Architecture

```
apps/
  api/        Fastify service: IMAP sync and IDLE, search, send, Sieve, calendar, Nextcloud, auth
    src/        the service (auth.ts, handoff.ts and internal.ts are the Nextcloud sign-in)
    test/       tests against the real API with real mail servers
    scripts/    operator tools: key rotation, giving accounts an owner
  web/        React 19 + Vite client
packages/
  shared/     Types shared by both
integration/
  nextcloud-app/ncmail/   The Nextcloud app (PHP): menu entry, signed tokens, badge, search, admin Mail page
e2e/          Browser tests (Playwright), including the Nextcloud versions
testing/      The throwaway PostgreSQL, Dovecot and Mailpit the tests run against
deploy/       A compose file for running it, and an example mail server list
docs/         Features, configuration, deployment, design notes, the security review
```

Key design points:

- **The IMAP server is the source of truth.** PostgreSQL holds a rebuildable mirror of headers (and cached bodies), so the
  UI never waits for IMAP to list or search. Actions go to the server first, then the mirror.
- **Nextcloud vouches for users.** The service never sees a Nextcloud password. `handoff.ts` verifies Ed25519 tokens and
  server-to-server requests; `auth.ts` turns a token into a short session and checks every request's ids against the owner.
- **Outbound connections go through `netguard.ts`**, which refuses private addresses unless an administrator allows them.
- **Big mailboxes and many users:** the first sync is limited to a window, heavy imports run a few at a time, and
  older mail is searched on the server ([docs/scaling.md](docs/scaling.md)).

## Releasing

`main` is protected: changes reach it through pull requests whose CI checks pass, and release tags (`v*`) cannot be moved or deleted.

1. On a branch (for example `release-0.2.0`), move the `[Unreleased]` entries in `CHANGELOG.md` under the new version and set the
   version everywhere: `pnpm version:set 0.2.0` (the root and app `package.json` files, the Nextcloud app's `info.xml` and the image default in `deploy/docker-compose.yml`).
2. Run `pnpm verify`, then open a pull request and merge it once CI is green. CI includes the upgrade test, so the new version has been checked against the previous release's data.
3. Check that the pull request is merged and that `main` carries the new version (`node -p "require('./package.json').version"`), then tag the merge commit and push the tag: `git tag -a v0.2.0 -m "NCMail 0.2.0" && git push origin v0.2.0`. Release tags cannot be moved or deleted, so a tag on the wrong commit means skipping that version.
4. The **Release** workflow checks that the tag is on `main` and that the tag, the version and the changelog agree, runs the tests, builds the container image for
   amd64 and arm64, pushes it to `ghcr.io/martindahlswe/ncmail`, and creates a **draft** GitHub Release with the Nextcloud app
   archive (and its checksum) attached. The image job runs in the `release` environment and waits for a maintainer to
   approve it; the draft is only published by hand. Check the draft and publish it.
5. Once the app is in the Nextcloud App Store, upload the published release there by hand: **Actions > App Store > Run workflow** with the tag ([docs/app-store.md](docs/app-store.md), which also covers the one-time certificate and secrets). The release workflow signs the app archive when those secrets are set.

`pnpm package:nextcloud-app` builds the app archive locally (`dist/ncmail-<version>.tar.gz`); `pnpm docker:build` builds the image.

## License

NCMail is licensed under the [Apache License 2.0](LICENSE). By submitting a contribution you agree that it is
licensed under the same terms (see section 5 of the license).
