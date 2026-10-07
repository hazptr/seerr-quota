# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Nothing yet.

## [0.1.0] — 2026-10-07

First public release. A per-user disk-quota, self-service-deletion, and
audit sidecar for Seerr, standing in for the one join none of Seerr, Radarr,
Sonarr, or Jellyfin can do on their own: turning "who requested what" into
"how many bytes is this person responsible for."

### Added

- **SSO identity** via a reverse-proxy `Remote-User`/`Remote-Groups` header
  gate — no login system of its own.
- **Account sync** reconciling identity-provider accounts with Seerr
  accounts, surfacing drift to the operator rather than silently guessing.
- **Usage accounting**: attributes on-disk bytes to the member(s) who
  requested each title, including correct handling of pre-existing library
  items and shared requests.
- **Quota policy**: a per-member size quota, operator-configurable, with a
  sane default and per-member overrides.
- **Enforcement**: new requests from an over-quota member are held (never
  silently approved or declined) with an explicit reason, visible both via a
  banner inside Seerr and an email notification; auto-approves again once the
  member is back under quota. Fails open on stale data or an upstream error.
- **Self-service deletion**: a strictly-scoped, three-step (select → review
  → type-to-confirm) flow letting a member free their own space, with a
  cancellable grace period before anything is actually deleted and layered
  guards (recent playback, in-progress watch, rate limit) against deleting
  the wrong thing.
- **Admin dashboard**: fleet-wide view of members, quotas, sync/entitlement
  drift, and manual controls (re-decide a request, protect a title, edit a
  quota), all server-side authorized.
- **Audit log**: an append-only record of every state change, including
  denials, with redaction of anything secret.
- **Pluggable theming**: a token-driven UI (colours and structural
  treatments) with a Seerr-matched dark default, a runtime `THEME_CSS`
  override hook (no rebuild required), and configurable `APP_NAME` /
  `FAVICON_URL`. See [`wiki/Theming.md`](wiki/Theming.md).
- **Versioning**: the running version is shown in the UI footer, in
  `/healthz`, and as OCI image labels.
- **CI**: GitHub Actions workflow building and publishing multi-arch images
  to GHCR on release.

### Notes for anyone deploying 0.1.0

- Required at boot: `ADMIN_USERS`, `AUTHENTIK_URL`, `APP_URL`, plus the
  Seerr/Radarr/Sonarr/Jellyfin/Authentik API keys and tokens. See
  [`wiki/Configuration.md`](wiki/Configuration.md) for the full list.
- `JELLYFIN_PLAYBACK_SOURCE` defaults to **`rest`** (needs
  `JELLYFIN_API_KEY`). The alternative, `db`, reads Jellyfin's SQLite
  directly and only works against a writable mount or a non-WAL copy of
  it — against Jellyfin's live WAL database mounted `:ro` it fails
  outright, playback data becomes unavailable, and every deletion is then
  blocked by design. Use `rest`.
- `MEDIA_FREE_SPACE_PATH` (default `/mnt/media`) is the filesystem whose free
  space feeds the over-commit warning.
- `TZ` defaults to **`UTC`**.
- Theming: `THEME_CSS`, `APP_NAME` (default `Seerr Quota`), `FAVICON_URL`
  (default `/favicon.svg`).
- `SMTP_HOST`/`SMTP_FROM` default to `example.com` placeholders; any SMTP
  relay works, and mail is only sent when enforcement or notifications are
  enabled.
- The data directory must exist and be owned by the container's uid before
  first boot: `mkdir -p data/db && sudo chown 1000:1000 data/db` (matching
  `user: "${PUID:-1000}:${PGID:-1000}"`).

[Unreleased]: https://github.com/hazptr/seerr-quota/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/hazptr/seerr-quota/releases/tag/v0.1.0

## Releasing

1. Move the `[Unreleased]` entries into a new `## [X.Y.Z] — YYYY-MM-DD`
   section above (Keep a Changelog format), and update the comparison links
   at the bottom of this file.
2. Commit that change on `main`.
3. Tag and publish a GitHub Release:
   ```
   gh release create vX.Y.Z --title vX.Y.Z --notes-from-tag
   ```
   (or generate notes from the CHANGELOG section instead of the tag, your
   call — `--notes-from-tag` just needs the annotated tag message to be
   decent).
4. CI (`.github/workflows/docker-publish.yml`) picks up the `release:
   published` event and builds + pushes `ghcr.io/<owner>/seerr-quota` tagged
   `X.Y.Z`, `X.Y`, `X`, and (for a non-prerelease release) `latest`.
5. No rollback step exists — if a release ships something broken, cut a new
   patch release rather than re-pointing tags.
