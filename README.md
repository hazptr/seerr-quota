# seerr-quota

A per-user **disk quota, self-service cleanup, and audit** sidecar for
[Seerr](https://github.com/sct/overseerr) / [Jellyseerr](https://github.com/Fallenbagel/jellyseerr), backed by Radarr, Sonarr,
Jellyfin, and Authentik.

Seerr can throttle *how many* things someone requests. It has no concept of
*how much disk* those requests consume, no way for a user to reclaim their own
space, and no audit trail. This service adds all three, plus an operator
dashboard, on top of an existing media stack — Seerr, Radarr, Sonarr, and
Jellyfin stay the source of truth for requests, library, and playback.

## What it does

- **Attribution.** Periodically joins Seerr's requests against Radarr/Sonarr
  `sizeOnDisk` and Jellyfin playback state to work out how many bytes each
  person is responsible for. Every requester on a shared title is charged
  the **full** size — never split — because an even split is exploitable by
  collusion (see [`wiki/Architecture.md`](wiki/Architecture.md) `D-3`).
- **Quota policy.** Each member gets a size quota (a global default, or a
  per-member override, `0` = unlimited).
- **Enforcement.** Over quota, new requests are **held** — left pending in
  Seerr with a clear reason delivered via an in-Seerr banner and email —
  rather than declined, so the app self-heals the moment a member frees
  space. Enforcement fails **open** on stale data or an upstream error.
- **Self-service deletion.** A member who's over quota can log in, see
  exactly what they're holding, and delete their own titles to get back
  under — always a deliberate, three-step, cancellable action with a grace
  period before anything is actually removed, never a single click and
  never a background job (see [`AGENTS.md`](AGENTS.md) rule 2/3).
- **Audit log.** An append-only record of every approve, decline, quota
  change, and deletion — including every denial.
- **Operator dashboard.** Quotas, drift between the identity provider and
  Seerr accounts, sync health, and the full audit log in one place.
- **SSO.** Gated by an Authentik (or any OIDC-compatible) forward-auth
  reverse-proxy setup, the same way the rest of a self-hosted stack typically
  is.
- **Theming.** A Seerr-matched default (dark + light), fully re-themeable at
  runtime via `THEME_CSS` — no rebuild required.

## Start here

| You want | Read |
|---|---|
| The whole picture, in reading order | [`wiki/Home.md`](wiki/Home.md) |
| What's built and what's left | [`wiki/Backlog.md`](wiki/Backlog.md) |
| How the pieces fit + the decisions behind them | [`wiki/Architecture.md`](wiki/Architecture.md) |
| A specific requirement | [`wiki/Features.md`](wiki/Features.md) → the feature page |
| Every setting + its default | [`wiki/Configuration.md`](wiki/Configuration.md) |
| Deploying it | [`wiki/Deployment.md`](wiki/Deployment.md) |
| Customizing the look | [`wiki/Theming.md`](wiki/Theming.md) |

## Requirements

- A running Seerr (or Jellyseerr) instance, with Radarr, Sonarr, and
  Jellyfin behind it.
- An Authentik (or other OIDC-compatible) instance already gating the rest
  of your stack behind a reverse-proxy forward-auth setup.
- Docker + Docker Compose on the host.

If any of those pieces don't exist yet, set them up first — this app is a
sidecar, not a replacement for any of them.

## Quickstart

```bash
mkdir -p data/db && sudo chown 1000:1000 data/db   # match user: below if you change PUID/PGID
cp .env.example .env                               # fill in your API keys and secrets
docker compose up -d
```

```yaml
# docker-compose.yml
services:
  seerr-quota:
    image: ghcr.io/hazptr/seerr-quota:0.1.0
    restart: unless-stopped
    user: "${PUID:-1000}:${PGID:-1000}"
    env_file: .env
    environment:
      ADMIN_USERS: "your-sso-username"
      AUTHENTIK_URL: "https://auth.example.com"
      APP_URL: "https://quota.example.com"
    volumes:
      - ./data/db:/db
      - /path/to/media:/mnt/media:ro
    ports:
      - "127.0.0.1:8101:3000"
```

See [`docker-compose.yml`](docker-compose.yml) and
[`.env.example`](.env.example) for a fuller example, and
[`wiki/Configuration.md`](wiki/Configuration.md) for every setting (several
of the above have no built-in default and are required at boot — the app
refuses to start and tells you exactly which one is missing).

## Reverse proxy / SSO

This app expects to sit behind a forward-auth reverse proxy that resolves
identity and injects `Remote-User` / `Remote-Groups` headers — it has no
login system of its own, and treats a request with no `Remote-User` as
unauthenticated even on the loopback port. See
[`wiki/Deployment.md`](wiki/Deployment.md) for worked examples with SWAG/
nginx and Authentik (Traefik works the same way, with its own forward-auth
middleware).

## Theming

Ships with a Seerr-matched default theme (dark + light). Override any token
or add rules at runtime via `THEME_CSS` — no rebuild required, and a
terminal-style look is achievable entirely through an override. See
[`wiki/Theming.md`](wiki/Theming.md) and [`wiki/Configuration.md`](wiki/Configuration.md).

## Versioning

Semantic versioning. Images are tagged `X.Y.Z`, `X.Y`, `X`, and `latest` on
release, plus a rolling `edge` tag built from `main`. See
[`CHANGELOG.md`](CHANGELOG.md).

## Development

```bash
cd app
npm install
npm run dev
```

"Done" is measured by the Docker `test` stage, not a host shortcut:

```bash
docker build --target test -t seerr-quota-test ./app
docker run --rm seerr-quota-test
docker run --rm seerr-quota-test npx tsc --noEmit
```

See [`app/README.md`](app/README.md) for more on local development, and
[`AGENTS.md`](AGENTS.md) for the engineering rules this project holds itself
to (deletion safety, append-only audit, fail-open enforcement, and more).

## Ground rules this project follows

- **Deleting media is the only destructive thing this app does**, and it is
  always human-initiated, always multi-step, always audited. There is no
  automatic age-out here — that's deliberately left to a separate tool (e.g.
  Maintainerr) if you want one.
- **Your identity provider is the source of truth.** This app never invents
  an account or a permission.
- **No rollback by design.** This app assumes it runs in a real deployment
  with no staging environment — see [`AGENTS.md`](AGENTS.md) for the
  engineering rules that follow from that.

## License

MIT — see [`LICENSE`](LICENSE).
