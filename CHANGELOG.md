# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security (PR #17 review — must-fix before merge)

- **`AUTH_EMAIL_HEADER` now defaults to EMPTY (disabled)**, not
  `Remote-Email`. The email-fallback login resolution only ever runs when
  an operator explicitly sets this — see "Added (0.2.0)" below and the
  Breaking/Upgrade notes for why the old default was unsafe.
- **`ADMIN_GROUP` now defaults to EMPTY (disabled)**, not `admins` — an
  operator must deliberately name a real group.
- **The email fallback never auto-links an operator row** (an existing
  `member.is_operator` row, or one whose key is in `ADMIN_USERS`) — that
  must be an explicit operator action.
- **The email fallback never overwrites an existing `login_alias`** —
  a second resolution attempt against an already-aliased member is
  refused and audited (deduplicated per header-username/member pair, not
  once per request) rather than silently re-pointing the alias.
- **`classifyMembers` no longer lets a new Seerr account overwrite an
  already-linked member's identity**, collide with another member's
  `login_alias`, or auto-grant operator status via a derived-key race
  against `ADMIN_USERS` — all three are now surfaced as a per-account
  `ambiguous` row at a collision-safe key instead, never touching
  whatever (or whoever) already legitimately owns the contested key.
- **`SeerrUsersClient.listAllUsers` now throws rather than returning a
  silently-partial list** on a pagination-count mismatch or exhausted
  retry budget; `syncMembers` now refuses to apply a sync cycle (same as
  any other upstream failure) when Seerr's list comes back empty while
  entitled members exist, or would flip more than half of more than two
  currently-entitled members to `not_entitled` at once.
- `AUTH_USER_HEADER`/`AUTH_GROUPS_HEADER`/`AUTH_EMAIL_HEADER` are now
  validated at boot: each must be a syntactically valid HTTP header name,
  and the three (when configured) must be pairwise distinct.
- `POST /api/deletion/execute` (and `/schedule`, `/cancel`) now re-checks
  that the caller resolves to an `entitled`, `matched` member before
  authorizing a deletion — a not-yet-entitled or deactivated login can no
  longer schedule/execute/cancel a deletion through those routes.
- See the three `examples/forward-auth/*.nginx.snippet` files for
  corrected Authelia/oauth2-proxy variable names and an explicit
  opt-in-with-warning treatment of the Authentik email mapping — the
  previous versions had bugs that would have broken login (Authelia:
  colliding with nginx's own Basic-auth `$remote_user` variable and two
  undefined variables; oauth2-proxy: a missing `/oauth2/` location would
  have broken the sign-in/callback redirect loop) or implied the email
  mapping was safe at default settings (it is opt-in only, see above).

### Added (0.2.0)

- **IdP-agnostic forward-auth.** The app no longer has any Authentik-specific
  integration — it works behind any forward-auth reverse proxy (Authentik,
  Authelia, oauth2-proxy in front of any OIDC IdP, Pomerium, ...). Identity
  header names are now configurable: `AUTH_USER_HEADER` (default
  `Remote-User`), `AUTH_GROUPS_HEADER` (default `Remote-Groups`),
  `AUTH_EMAIL_HEADER` (default EMPTY — disabled; see "Security" above for
  why this must not default to an actual header name).
- **Login → member resolution fallback — opt-in, off by default.** Once
  `AUTH_EMAIL_HEADER` is explicitly configured: if a forward-auth login
  username doesn't exactly match an existing member, and the proxy
  supplies that email header matching EXACTLY ONE entitled member who is
  neither an operator nor already aliased, that member is resolved and
  the login username is recorded as a `login_alias` (first time only,
  audited as `member.alias_linked`) so future logins resolve instantly.
  Zero/ambiguous matches, an operator target, or an already-set alias all
  refuse rather than guess or overwrite — see "Security" above.
- **Operator action: clear a member's login alias** —
  `POST /api/admin/members/clear-alias` (`member.alias_cleared`, audited),
  for undoing a stale/incorrect alias link; re-linking afterward goes
  through the same email-fallback rules as a first-time link.
- Three worked forward-auth examples in `examples/forward-auth/`: Authentik
  outpost, Authelia, and oauth2-proxy (nginx), replacing
  `examples/authentik.tf.snippet`.
- Additive schema: `member.login_alias` (nullable, unique when set).

### Changed (0.2.0)

- **Member roster is now Seerr's own user list.** Every current Seerr user
  is a member (`entitled = true`). There is no second, independent
  identity-provider entitlement list to reconcile against any more.
- **Member key stability.** An existing member already linked to a Seerr
  account (`seerr_user_id` set) keeps its `sso_username` forever, even if
  Seerr's own username/email for that account changes — re-matched by
  `seerr_user_id`, never re-derived. Only a genuinely new Seerr account gets
  a freshly-derived key.
- **Operator semantics.** Request-time operator status is `ADMIN_USERS`
  (checked against both the resolved member key and the raw header
  username) OR `ADMIN_GROUP` membership via the groups header — unchanged.
  The BACKGROUND enforcement-exemption flag (`member.is_operator`) is now
  `ADMIN_USERS` ONLY, since no groups header exists off-request. An
  `ADMIN_GROUP`-only admin therefore stays subject to quota enforcement
  unless also listed in `ADMIN_USERS` or given an unlimited override.
- Dependencies: Next.js 15.5.27, better-sqlite3 13 (Node-API prebuilt
  binaries), nodemailer 10, drizzle-kit 0.31.11, postcss 8.5.28,
  autoprefixer 10.6.1, eslint-config-next 15.5.27.
- Build uses npm 11 (Docker `deps` stage and CI).

### Removed (0.2.0)

- The entire Authentik integration: `src/lib/authentik/**` (admin API
  client), the member-sync identity step, the admin "entitlement check"
  panel (`FR-ADM-9`), and the `AUTHENTIK_URL` / `AUTHENTIK_TOKEN` /
  `SEERR_APP_SLUG` / `SELF_APP_SLUG` / `AUTHENTIK_JELLYSEERR_APP_UUID`
  settings.

### Breaking / Upgrade notes (0.2.0)

- **Authentik env vars removed.** `AUTHENTIK_URL`, `AUTHENTIK_TOKEN`,
  `SEERR_APP_SLUG`, `SELF_APP_SLUG`, and `AUTHENTIK_JELLYSEERR_APP_UUID` no
  longer do anything. Leaving them set in an existing deployment's `.env`
  does NOT break boot — one deprecation line naming them (never their
  values) is logged once at startup, then they're ignored.
- **Roster source changed.** The member roster now comes directly from
  Seerr instead of from Authentik-entitlement ∩ Seerr-match. A member whose
  Seerr account has since been deleted becomes `entitled = false` /
  `not_entitled` on the next reconcile (their row, claims, quota, and audit
  history are all kept — nothing is deleted).
- **Existing member keys are preserved.** No existing `member.sso_username`
  is changed or re-derived by this upgrade — every row already linked to a
  Seerr account (`seerr_user_id` set) keeps its exact login key.
- **New: email-header fallback — OFF by default, and it must stay off
  unless you've verified your proxy (security review, PR #17).**
  `AUTH_EMAIL_HEADER` now defaults to EMPTY (disabled); the fallback never
  runs unless you explicitly set it. **Do not enable it unless you have
  confirmed your reverse proxy unconditionally overwrites that exact
  header on every request** — a header that only gets set "when present"
  (rather than always replacing whatever the client sent) is forgeable,
  and this fallback can resolve an unknown caller to an existing member's
  identity. It is NOT safe to assume this is already true just because a
  forward-auth gate is in front of you: e.g. Authentik's own outpost sets
  `X-authentik-username`/`X-authentik-groups` by default, not an arbitrary
  `Remote-Email` — you'd have to deliberately map an email claim into that
  header yourself. Even when correctly configured and enabled, this
  fallback additionally NEVER auto-links a row that is an operator (or
  listed in `ADMIN_USERS`), and NEVER overwrites an alias a member already
  has — both require an explicit operator action instead (`member.alias_cleared`,
  `POST /api/admin/members/clear-alias`). See
  `wiki/Feature-01-SSO-Identity.md`.
- **`ADMIN_GROUP` now also defaults to EMPTY (disabled).** It previously
  defaulted to `admins`; it now ships off until you deliberately point it
  at a group your IdP actually uses to mean "operator". If you were
  relying on the `admins` default, set `ADMIN_GROUP=admins` explicitly
  going forward.
- **Operator semantics clarified, not changed in the common case.**
  `ADMIN_USERS` continues to work exactly as before. If you were relying on
  `ADMIN_GROUP` ALONE (not also in `ADMIN_USERS`) for the background
  enforcement exemption, that exemption no longer applies — add that
  username to `ADMIN_USERS`, or set an explicit unlimited quota override, if
  you need it to continue.
- **Deploying behind a non-Authentik proxy** needs no code change — point
  `AUTH_USER_HEADER`/`AUTH_GROUPS_HEADER` at whatever your proxy sets.
  There is no "these defaults already match Authentik" shortcut for
  `AUTH_EMAIL_HEADER`: Authentik's outpost does not set a header literally
  named `Remote-Email` by default under any configuration this project
  verified, so review and explicitly configure it per the note above
  rather than assuming the defaults are already correct for your proxy.
- **Mass-revocation guard (`FR-SYNC-10`, extended).** A sync cycle now
  refuses to apply (and records `sync.failed`, changing nothing) when
  Seerr's user list comes back empty while entitled members exist, when
  every confirmed-linked member would vanish at once, or when it would
  flip more than half of more than two confirmed-linked members to
  `not_entitled` in one cycle. An operator can force one cycle past the
  flip thresholds from `/admin` (never past an empty list) — protects against a flaky/
  misbehaving Seerr response mass-revoking real members' access.
- **Review your roster after upgrading.** Two shapes of surprise are
  possible on the first post-upgrade sync, and are worth a manual look at
  `/admin` before trusting the numbers: (a) a member your IdP used to
  allow into this app but who never had (or no longer has) a Seerr
  account becomes `not_entitled` (loses dashboard access; this is usually
  correct, but confirm); (b) a Seerr account that was previously excluded
  purely by NOT holding the old Authentik entitlement binding is now a
  full `matched`/`entitled` member, subject to the default quota and
  enforcement if enabled — if that's not what you want for a particular
  account, set an explicit quota override or revoke their Seerr access
  directly.

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
