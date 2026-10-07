# Deployment

This page assumes: a Docker host, a Seerr (Jellyseerr) instance already
running, Radarr/Sonarr/Jellyfin, and a forward-auth-capable reverse proxy
already gating the rest of your stack — in front of whatever identity
provider you use (Authentik, Authelia, oauth2-proxy in front of any OIDC
IdP, Pomerium, or anything else that can forward-auth and set headers). If
any of those pieces don't exist yet, set them up first — this app is a
sidecar, not a replacement for any of them. Since 0.2.0 this app has no
identity-provider integration of its own at all — see §2/§3 below.

## 1. Compose

```yaml
services:
  seerr-quota:
    image: ghcr.io/hazptr/seerr-quota:latest
    container_name: seerr-quota
    user: "${PUID:-1000}:${PGID:-1000}"
    restart: unless-stopped
    env_file: .env
    ports:
      - "127.0.0.1:8101:3000"   # loopback only; put a reverse proxy in front
    volumes:
      - ./data/db:/db
      - /path/to/media:/mnt/media:ro   # free-space reporting only (FR-ADM-2)
    mem_limit: 512m
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      start_period: 20s
      interval: 15s
      timeout: 3s
      retries: 3
    networks:
      - proxy

networks:
  proxy:
    external: true
```

See [`docker-compose.yml`](../docker-compose.yml) at the repo root for the
canonical version of this, and [`.env.example`](../.env.example) for every
environment variable.

Notes that matter:

- **`user:`** — not optional if you bind-mount `./data/db`: the container
  must be able to write to it. Match the UID/GID that owns that directory on
  the host.
- **`mem_limit: 512m`** — Node sizes its heap to the HOST's total RAM if left
  uncapped, not the container's `mem_limit`. The image already sets
  `--max-old-space-size` to stay inside a 512 MB container (see
  `app/Dockerfile`); if you raise `mem_limit`, raise that too, or the
  container gets OOM-killed rather than the heap bounded.
- **If you enable enforcement** (`ENFORCEMENT_ENABLED=true`), this app also
  needs outbound access to whatever SMTP relay you configure via
  `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` — join whatever network that relay is
  reachable on.

## 2. Reverse proxy (forward-auth) — any IdP

Since 0.2.0 this app has **no identity-provider integration of its own**: it
trusts whatever forward-auth proxy sits in front of it, reading only three
configurable headers (`AUTH_USER_HEADER`/`AUTH_GROUPS_HEADER`/
`AUTH_EMAIL_HEADER`, default `Remote-User`/`Remote-Groups`/`Remote-Email` —
`wiki/Configuration.md` §Identity). A vhost for `quota.example.com` (or
whatever subdomain you choose), gated by the same forward-auth mechanism as
every other protected service in your stack. The essentials, however your
reverse proxy expresses them:

1. Your IdP's forward-auth include/directive (Authentik outpost, Authelia,
   oauth2-proxy's `auth_request`, ...), applied to the whole vhost.
2. Forward the configured username/groups/email headers from the auth
   response to the upstream — **unconditionally overwritten**, so a client
   can never forge them. The email header is optional (used only for the
   one-time member-resolution fallback, `wiki/Feature-01-SSO-Identity.md`);
   leaving it unset is fine.
3. `location = /healthz` **outside** the auth gate (so a liveness prober
   doesn't get redirected to a login page).

Worked examples for three common setups live in
[`examples/forward-auth/`](../examples/forward-auth/):
[`authentik-outpost.nginx.snippet`](../examples/forward-auth/authentik-outpost.nginx.snippet),
[`authelia.nginx.snippet`](../examples/forward-auth/authelia.nginx.snippet), and
[`oauth2-proxy.nginx.snippet`](../examples/forward-auth/oauth2-proxy.nginx.snippet)
— adapt whichever matches your IdP, or use them as a shape for a different one.

For the in-Seerr quota banner (optional, `FR-BAN-*`) see
[`examples/seerr-banner.nginx.snippet`](../examples/seerr-banner.nginx.snippet)
and [[Feature-10-In-Seerr-Banner]].

Reload your proxy after applying (e.g. `nginx -t && nginx -s reload` inside
the proxy container).

## 3. Member roster — comes from Seerr, not your IdP

Since 0.2.0 the member roster is Seerr's own user list (`wiki/
Feature-02-Account-Sync.md`) — there is no separate IdP-side entitlement
step and no IdP credential for this app to hold at all. What you actually
need to get a member a working dashboard:

1. **Reverse-proxy access** to the `quota.*` vhost from §2 above — however
   your IdP expresses "this user may reach this app" (an Authentik policy
   binding, an Authelia access-control rule, an oauth2-proxy
   email/group allow-list, ...), typically "the same people who have access
   to Seerr."
2. **A Seerr account** for that person — this app creates (or links) their
   `member` row the next time the reconciler runs, keyed by whatever
   username they'll actually log in with (see `wiki/Feature-02-Account-Sync.md`
   for the exact key-derivation and the email-header fallback if the proxy's
   username ever doesn't match Seerr's).

## 4. Seerr-side prerequisites

Two changes inside Seerr itself:

1. **Webhook** — Settings → Notifications → Webhook →
   `http://seerr-quota:3000/api/seerr/webhook`, notification type
   *Request Pending Approval*. Put `SEERR_WEBHOOK_SECRET` in a **Custom
   Headers** entry named `X-Seerr-Webhook-Secret`. Trim the default JSON
   payload template down to `{{request_id}}`; nothing else in it is trusted
   (`FR-ENF-8`).
2. **Remove auto-approval** from member accounts so requests land pending
   (prerequisite for enforcement, see `wiki/Feature-05-Enforcement.md`).
   **Do this only in the same window as enabling enforcement** — done early,
   every request sits pending until an operator manually approves it.

Any count-based request quotas you already have configured in Seerr are
independent of this app and need no changes (`D-1` in `wiki/Architecture.md`).

## 5. Health monitoring

Point whatever uptime monitor you use (Gatus, Uptime Kuma, etc.) at
`GET /healthz` — unauthenticated, no identity resolution, no upstream call,
just a liveness probe:

```yaml
  - name: seerr-quota
    url: http://seerr-quota:3000/healthz
    interval: 60s
    conditions: ["[STATUS] == 200", "[BODY].status == ok"]
```

## 6. Backups

1. **What to back up**: the SQLite DB under `DB_PATH` (bind-mounted, not a
   named volume, so it's easy to include in whatever backs up the host). It
   holds the audit log, which is the one thing here that cannot be
   reconstructed from the upstream APIs.
2. **How**: a live SQLite file captured mid-write may not restore cleanly.
   Use SQLite's own online backup before copying, e.g.:

   ```bash
   sqlite3 /path/to/seerr-quota.db ".backup '/path/to/backup/seerr-quota.db'"
   ```

   The app doesn't hold an exclusive lock outside of individual writes, so a
   plain `.backup` works without pausing the container.

## 7. Order of operations for the first deploy

The safe sequence — each step is reversible until the last one:

1. Deploy the app with `ENFORCEMENT_ENABLED=false` and no
   `DEFAULT_QUOTA_BYTES`. It reconciles and reports; it changes nothing.
2. Watch the numbers for a while before deciding on quota sizes. The admin
   dashboard's quota-preview (`FR-POL-4`) shows exactly who'd be affected by
   a proposed default, before you commit to one.
3. Set per-member quotas using that preview.
4. In **one window**: remove auto-approval from member accounts in Seerr and
   set `ENFORCEMENT_ENABLED=true`. Verify with one real request.
5. Tell your members before they hit it. A quota that arrives without
   warning reads as a punishment; one that arrives with "here's your
   dashboard, here's how to free space" reads as a tool.

## Verification commands

```bash
# app up, gate bypassed
curl -s localhost:8101/healthz            # -> {"status":"ok","service":"seerr-quota"}

# gate active (should redirect to your IdP, not 200)
curl -sI https://quota.example.com/ | head -1

# unit tests via the Docker test stage
docker build --target test -t seerr-quota-test ./app && docker run --rm seerr-quota-test
docker run --rm seerr-quota-test npx tsc --noEmit
```
