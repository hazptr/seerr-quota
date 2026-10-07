# Multi-stage Node build (wiki/Deployment.md §1). No in-process browser
# needed, so this builds on the plain node:22-slim image, not a Playwright
# base.
FROM node:22-slim AS deps
WORKDIR /app
# better-sqlite3 is a native addon: it compiles a .node binary against the
# installed Node headers during `npm ci`, so the build toolchain has to be
# present in this stage (the slim runner below does NOT need it — it only
# copies the already-built node_modules).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci

# Test stage: source + deps, no build. `docker build --target test -t
# seerr-quota-test ./app` then `docker run --rm seerr-quota-test` runs the
# hand-calculated unit tests with no DB/network required — this is the
# CI-equivalent verification path (AGENTS.md rule 12).
FROM node:22-slim AS test
WORKDIR /app
# On a large host, an uncapped Node process sizes its default heap off total
# system RAM, which can be enormous — cap it explicitly (rather than relying
# on the default) here too (not just in the runner stage) so a throwaway
# `docker run seerr-quota-test` during verification can't balloon either.
ENV NODE_OPTIONS=--max-old-space-size=1024
COPY --from=deps /app/node_modules ./node_modules
COPY . .
CMD ["npx", "vitest", "run"]

FROM node:22-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Version comes from the git tag at build time (`.github/workflows/
# docker-publish.yml`'s `Resolve app version` step — a release tag -> X.Y.Z,
# otherwise `git describe`). Written into package.json before `next build` —
# `src/lib/version.ts` reads it back out of package.json at runtime (the
# footer and `/healthz` both import that module), so there is exactly one
# source of truth and nothing else needs to thread the version through as a
# separate env var.
ARG APP_VERSION=0.0.0-dev
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm pkg set version="$APP_VERSION" && npm run build

FROM node:22-slim AS runner
WORKDIR /app
# Re-declared here (not just in the builder stage) so it's visible to
# anything introspecting this final image, and because OCI labels below
# reference it. Build-arg scope doesn't cross stages on its own.
ARG APP_VERSION=0.0.0-dev
# CI (`.github/workflows/docker-publish.yml`) additionally passes a full set
# of OCI labels via `docker/metadata-action` (source, revision, created,
# licenses) at build time — those take precedence over these when both are
# set. These two are set here too so a plain local `docker build` (no CI)
# still stamps a meaningful version/title.
LABEL org.opencontainers.image.version="$APP_VERSION" \
      org.opencontainers.image.title="seerr-quota"
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# docker-compose.yml's healthcheck execs `node -e ...` against Node's
# built-in `fetch` (stable since Node 18) rather than wget/curl — node:22-slim
# ships neither by default, and adding an apt package to the runner stage
# just to satisfy a healthcheck is the wrong trade when the runtime already
# has everything it needs — an earlier draft of this app's Deployment.md
# wording called for `wget`; that was corrected after review.
# On a large host, an uncapped Node process sizes its default heap off total
# system RAM, which can be enormous — cap it explicitly (rather than relying
# on the default), since `mem_limit: 512m` in docker-compose.yml bounds the
# CONTAINER, but does
# nothing to stop Node from trying to grow its heap past that and getting
# OOM-killed rather than gracefully staying under budget. Capping the heap
# here, inside the image, is what actually keeps it under `mem_limit`
# (wiki/Deployment.md §1, this task's spec). 384m leaves headroom under the
# 512m container cap for non-heap Node/V8 overhead (code cache, native
# module state, buffers) and for `next start`'s own process footprint.
ENV NODE_OPTIONS=--max-old-space-size=384
# Dedicated non-root user. uid/gid 1000 is taken by node:22-slim's `node`
# user; 1002 is free.
RUN groupadd -g 1002 quota && useradd -u 1002 -g 1002 -m -d /home/quota -s /sbin/nologin quota
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.mjs ./next.config.mjs
# Generated drizzle-kit SQL migrations (committed under app/drizzle/, see
# drizzle.config.ts + src/lib/db/index.ts's ensureSchema()). getDb() applies
# these lazily at first DB open (not at build time), resolving the folder
# relative to WORKDIR — so it has to be present in this final image too, not
# just the builder stage.
COPY --from=builder /app/drizzle ./drizzle
# Arbitrary-uid tolerance. The
# image defaults to the `quota` user, but a deployment commonly
# overrides it with `user: "${PUID}:${PGID}"` (docker-compose.yml) to match a
# host uid:gid so host-side backups can read the DB directly. A plain `docker run --user uid:gid` does NOT add
# the classic OpenShift "supplementary group 0" the way `--user uid:0`
# would, so the overridden process sits in *only* that gid — runtime-
# writable paths must be writable by group 0 (for a group-0 deploy) AND by
# "other" (for an arbitrary gid, e.g. 9999). We keep group-0 ownership too so
# a `--user uid:0` deploy also works.
#   /db              — DB_PATH's parent dir (wiki/Configuration.md); a real
#                      deployment typically bind-mounts this host-owned, so
#                      its perms come from the host. This in-image dir
#                      covers the unmounted parent + a no-volume `docker run`.
#   /app/.next/cache — `next start` (non-standalone output) writes its
#                      fetch/image cache here at runtime; the rest of /app
#                      stays read-only.
RUN mkdir -p /db /app/.next/cache \
    && chown -R quota:0 /db /app/.next/cache \
    && chmod -R g=u,o+rwX /db /app/.next/cache
EXPOSE 3000
USER quota
CMD ["npm", "run", "start"]
