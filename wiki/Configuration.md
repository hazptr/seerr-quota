# Configuration

Precedence: **env → `config.yaml` → built-in default**. Operator-editable
*runtime* settings additionally live in the `app_setting` table, which
**wins over all three once set** — the env value only seeds the first boot.

That last rule is the one that surprises people, so the admin UI MUST show,
for each runtime setting, whether the current value came from the DB or from
config.

## Secrets — `.env` only

Never in `config.yaml`, never in the DB, never committed, never rendered to a
client, never in an audit row (`FR-AUD-11`).

| Var | Source | Required |
|---|---|---|
| `SEERR_API_KEY` | Seerr → Settings → General → API Key | Always |
| `RADARR_API_KEY` | Radarr → Settings → General → API Key | Always |
| `SONARR_API_KEY` | Sonarr → Settings → General → API Key | Always |
| `JELLYFIN_API_KEY` | Jellyfin admin UI → API Keys (create a dedicated one) | Always (default playback source is `rest`; see below) |
| `SEERR_WEBHOOK_SECRET` | Generated (e.g. `openssl rand -hex 32`); also pasted into Seerr's webhook config — either an Authorization Header or (preferred) a Custom Headers entry named `X-Seerr-Webhook-Secret` | Always |
| `SMTP_USER` / `SMTP_PASS` | Your SMTP relay's credentials, for member notifications (`FR-ENF-13`) | Only when `ENFORCEMENT_ENABLED=true` |

Since 0.2.0 there is no identity-provider secret here at all — this app has
no IdP integration of its own; see "Identity" below.

Copy the keys into `.env` rather than reading another service's config file
at runtime: the app shouldn't need a bind mount into another service's
config directory, and `.env` is the one place secrets live (`AGENTS.md`
rule 7).

## Upstream endpoints

| Setting | Default | Notes |
|---|---|---|
| `SEERR_URL` | `http://jellyseerr:5055` | Point this at whatever you've named your Seerr/Jellyseerr container |
| `RADARR_URL` | `http://radarr:7878` | Not published to the host; reachable only on the shared Docker network |
| `SONARR_URL` | `http://sonarr:8989` | Same |
| `JELLYFIN_URL` | `http://jellyfin:8096` | Auth header is `X-Emby-Token` |
| `JELLYFIN_PLAYBACK_SOURCE` | `rest` | `rest` (default — Jellyfin's REST API, needs `JELLYFIN_API_KEY`) or `db` (reads Jellyfin's own SQLite file read-only). **Recommended: `rest`.** `db` only works against a writable mount or a non-WAL copy of Jellyfin's database — against Jellyfin's live WAL-mode database mounted `:ro`, it fails outright (SQLite cannot open a WAL database read-only, since it needs to write the `-shm` file), playback data becomes unavailable, and — by design (`FR-DEL-21`) — every deletion is then blocked, since "unknown" must fail safe, not fail open |
| `APP_URL` | *(none — required)* | This app's own public URL, used in member notifications and the in-Seerr banner (`FR-BAN-6`, `FR-ENF-3`). No generic default exists; boot fails if unset |
| `SMTP_HOST` | `mail.example.com` *(placeholder)* | Any SMTP relay reachable from the container works — point it at whatever relay you already use |
| `SMTP_PORT` | `25` | Container-visible port, STARTTLS |
| `SMTP_FROM` | `quota@example.com` *(placeholder)* | Should be visibly this app, not Seerr — see [[Feature-05-Enforcement]] open questions |

## Identity

Since 0.2.0 this app has **no identity-provider integration of its own** —
it trusts whatever forward-auth reverse proxy sits in front of it
(Authentik, Authelia, oauth2-proxy in front of any OIDC IdP, Pomerium, ...)
to authenticate the user and set these headers on every request. See
`examples/forward-auth/` for worked nginx configs per proxy, and
`wiki/Deployment.md`'s forward-auth section.

| Setting | Default | Notes |
|---|---|---|
| `ADMIN_USERS` | *(none — required)* | Comma-separated login usernames; also satisfied, AT REQUEST TIME ONLY, by membership in `ADMIN_GROUP` (see below). No generic default exists; boot fails if unset or empty |
| `ADMIN_GROUP` | *(empty — disabled)* | Request-time only — there is no groups header available to the background enforcement-exemption check (`FR-ENF-6`), so an `ADMIN_GROUP`-only admin stays subject to quota enforcement unless also listed in `ADMIN_USERS` or given an unlimited quota override. Ships disabled: set it to a group your IdP actually uses to mean "operator" before relying on it — see `src/lib/auth/identity.ts`'s `isInAdminGroup` |
| `AUTH_USER_HEADER` | `Remote-User` | The header carrying the authenticated login username. The proxy MUST overwrite this, unconditionally, on every request |
| `AUTH_GROUPS_HEADER` | `Remote-Groups` | The header carrying group names, split on both `\|` and `,`. Same unconditional-overwrite requirement |
| `AUTH_EMAIL_HEADER` | *(empty — disabled)* | Used only for the one-time email-based member-resolution fallback when the header username doesn't exactly match an existing member (`wiki/Feature-01-SSO-Identity.md`). **Ships disabled, and must stay disabled unless you have verified your proxy unconditionally overwrites this exact header on every request** — a header set only "when present" is forgeable by the client, and this fallback can resolve an unauthenticated-for-this-app caller to an existing member's identity. This is NOT automatically true just because a forward-auth gate is in front of you (e.g. Authentik's outpost sets `X-authentik-username`/`X-authentik-groups` by default, not an arbitrary `Remote-Email`) — check your own proxy config. Even when enabled, the resolution never auto-links an operator row or overwrites an existing `login_alias` — see `wiki/Feature-01-SSO-Identity.md` `FR-SSO-9` |

All three header names, plus the validation that applies to them, are
checked at boot (`src/lib/config.ts`'s `validateConfig`): each configured
name must be a syntactically valid HTTP header field-name, and the three
(when `AUTH_EMAIL_HEADER` is set) must be pairwise distinct.

Leftover pre-0.2.0 settings (`AUTHENTIK_URL`, `AUTHENTIK_TOKEN`,
`SEERR_APP_SLUG`, `SELF_APP_SLUG`, `AUTHENTIK_JELLYSEERR_APP_UUID`) no
longer exist — the app never reads them. If any are still present in an
existing deployment's `.env`, boot does NOT fail over it; one deprecation
line naming them (never their values) is logged instead.

## Runtime settings (DB-backed, operator-editable)

| Key | Default | Meaning |
|---|---|---|
| `default_quota_bytes` | **unset — must be set before enforcement** | Global default size quota |
| `enforcement_enabled` | `false` | Master switch (`FR-POL-7`). Ships off |
| `grace_bytes` | `0` | Allowance above quota before declining (`FR-POL-8`) |
| `delete_recent_play_days` | `14` | Recent-playback window that blocks deletion (`FR-DEL-4`) |
| `delete_in_progress_days` | `90` | Window for the **unfinished** guard — someone part-way through a series. Deliberately much wider than the recent window: a false block costs one undeletable title, a false allow costs someone their show |
| `stale_snapshot_max_age_s` | `3600` | Older than this ⇒ enforcement skips (`FR-ENF-4`) |
| `delete_max_per_hour` | `25` | Per-member deletion rate limit (`FR-DEL-12`) |
| `hold_max_days` | `30` | Auto-decline safety valve for a request held this long; `0` = never (`FR-ENF-12`) |
| `notify_cooldown_s` | `86400` | Min gap between hold notifications to one member (`FR-ENF-14`) |

`default_quota_bytes` deliberately has **no** default. A wrong global quota
applied silently to every member is worse than a startup that refuses to enforce
until the operator has made a decision — so with it unset, accounting runs and
enforcement stays off regardless of `enforcement_enabled`.

## Scheduling

| Setting | Default | Notes |
|---|---|---|
| `RECONCILE_INTERVAL` | `15m` | Full reconcile + pending sweep |
| `RECONCILE_ON_BOOT` | `true` | Run once at startup |
| `WEBHOOK_ENABLED` | `true` | Low-latency path; poller still runs (`D-4`) |
| `UPSTREAM_TIMEOUT` | `20s` | Per upstream HTTP call |
| `UPSTREAM_RETRIES` | `2` | With backoff; never retry a `DELETE` |
| `DELETE_GRACE_PERIOD` | `24h` | How long a confirmed deletion stays cancellable before the sweeper may run it (`FR-DEL-22`). `0` disables the window and restores immediate deletion; a **negative** value is refused at boot |
| `DELETE_SWEEP_INTERVAL` | `5m` | How often the sweeper looks for due deletions (`FR-DEL-25`). Bounds only how far *past* `scheduled_for` execution can drift, never how early — the sweeper re-checks the due time itself. Must be positive |

`DELETE_GRACE_PERIOD` is the one setting here that members can feel. Raising it
widens the undo window and delays when space actually leaves the disk; lowering
it does the reverse. Setting it to `0` is a real, supported choice — the confirm
screen's copy adapts — but it removes the self-service undo entirely, leaving
ZFS snapshots and the operator as the only recovery path. Boot validation
refuses a negative value outright rather than silently executing every
"scheduled" deletion on the next sweep while the UI still promises a window.

**Never retry a `DELETE`** is a rule, not a tunable: a retried delete against a
re-used id could destroy the wrong thing. A failed delete is reported, not
retried automatically.

## Paths

| Setting | Default | Notes |
|---|---|---|
| `DB_PATH` | `/db/seerr-quota.db` | Bind-mount this to somewhere persistent (see `docker-compose.yml`). The host directory (`./data/db` in the compose example) must exist and be owned by the container's uid before first boot: `mkdir -p data/db && sudo chown 1000:1000 data/db` (match `user: "${PUID:-1000}:${PGID:-1000}"` if you've changed it) |
| `MEDIA_FREE_SPACE_PATH` | `/mnt/media` | Read-only mount, for free-space reporting (`FR-ADM-2`). Whatever filesystem your media library lives on |
| `JELLYFIN_DB_PATH` | `/jellyfin-db/jellyfin.db` | **Read-only** bind mount of Jellyfin's SQLite DB — the documented fallback for `JELLYFIN_PLAYBACK_SOURCE=db`. Not needed (and should not be mounted) when using the recommended `rest` source |
| `LOG_LEVEL` | `info` | Audit JSON lines are emitted regardless of level |

## Display

| Setting | Default | Notes |
|---|---|---|
| `TZ` | `UTC` | Rendering timezone for timestamps shown in the UI; set to your own, e.g. `America/New_York` |
| `SIZE_UNITS` | `decimal` | GB = 10⁹ (`FR-ACCT-9`). `binary` also supported but must be consistent app-wide |

## Theming

| Setting | Default | Notes |
|---|---|---|
| `THEME_CSS` | *(unset)* | Path to an override stylesheet, readable **inside the container** (bind-mount it in). Served fresh from disk at `GET /theme.css` on every request — no rebuild needed to pick up an edit. See [[Theming]] for the token reference and a worked example, including how to get a terminal-style look purely through an override |
| `APP_NAME` | `Seerr Quota` | Page title / brand text |
| `FAVICON_URL` | `/favicon.svg` | The neutral icon shipped in `public/`; point this at your own if you want a different one |

## Validation at boot

The app MUST refuse to start on a misconfiguration it cannot safely proceed
under, and MUST say exactly which setting is wrong:

- Any missing secret for an upstream it's configured to use.
- `ADMIN_USERS` empty (nobody could administer it).
- `APP_URL` empty — no sane generic default.
- `enforcement_enabled = true` with SMTP unconfigured — enforcement without a
  way to tell members why they're held is the failure mode `D-4a` exists to
  prevent, so it must not be startable.
- `enforcement_enabled = true` with `default_quota_bytes` unset (`FR-POL-2a`) —
  an unset default is an *absence of a decision*, not "unlimited", and must
  never be silently treated as either.
- `grace_bytes` negative, or larger than `default_quota_bytes`.
- `DB_PATH` unwritable.

It MUST start, degraded and loudly, when an upstream is merely *unreachable* —
that is a runtime condition, not a misconfiguration, and refusing to boot
because Sonarr is restarting would be its own outage.
