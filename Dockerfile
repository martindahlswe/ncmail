# syntax=docker/dockerfile:1
# NCMail: the mail service and its web app in one image.
#   docker build -t ncmail .
# Needs a PostgreSQL database (DATABASE_URL) and a SECRET_KEY; see deploy/docker-compose.yml and docs/deployment.md.

FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS build
WORKDIR /app
RUN npm install -g corepack@0.36.0 && corepack enable   # Node 25+ no longer ships corepack
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN pnpm --filter @ncmail/web build

FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS prod-deps
WORKDIR /app
RUN npm install -g corepack@0.36.0 && corepack enable   # Node 25+ no longer ships corepack
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --prod --filter @ncmail/api...
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/api apps/api

FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5
ARG VERSION=0.0.0-dev
# Listens on all interfaces, so the service needs NCMAIL_AUTH=nextcloud and NEXTCLOUD_URL (or NCMAIL_AUTH=off on a closed
# network): single-user mode without sign-in is local only and refuses to start here.
ENV NODE_ENV=production \
    NCMAIL_VERSION=$VERSION \
    API_HOST=0.0.0.0 \
    API_PORT=4000 \
    WEB_DIST=/app/web
WORKDIR /app/apps/api
COPY --from=prod-deps /app /app
COPY --from=build /app/apps/web/dist /app/web
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/api/health >/dev/null || exit 1
LABEL org.opencontainers.image.title="NCMail" \
      org.opencontainers.image.description="A fast webmail client that runs as an app inside Nextcloud" \
      org.opencontainers.image.source="https://github.com/martindahlswe/ncmail" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version=$VERSION
CMD ["node", "--import", "tsx", "src/server.ts"]
