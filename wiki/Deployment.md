# Deployment

This page assumes: a Docker host, a Seerr (Jellyseerr) instance already
running, Radarr/Sonarr/Jellyfin, and an Authentik (or compatible OIDC)
instance already gating the rest of your stack behind a reverse-proxy
forward-auth setup. If any of those pieces don't exist yet, set them up
first — this app is a sidecar, not a replacement for any of them.

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

## 2. Reverse proxy (forward-auth)

A vhost for `quota.example.com` (or whatever subdomain you choose), gated by
the same forward-auth mechanism as every other protected service in your
stack. The essentials, however your reverse proxy expresses them:

1. Authentik's (or your IdP's) forward-auth include/directive, applied to
   the whole vhost.
2. Forward `Remote-User` and `Remote-Groups` (or equivalent) headers from
   the auth response to the upstream — **unconditionally overwritten**, so a
   client can never forge them.
3. `location = /healthz` **outside** the auth gate (so a liveness prober
   doesn't get redirected to a login page).

For the in-Seerr quota banner (optional, `FR-BAN-*`) see
[`examples/seerr-banner.nginx.snippet`](../examples/seerr-banner.nginx.snippet)
and [[Feature-10-In-Seerr-Banner]].

Reload your proxy after applying (e.g. `nginx -t && nginx -s reload` inside
the proxy container).

## 3. Identity provider (Authentik or compatible)

An [`examples/authentik.tf.snippet`](../examples/authentik.tf.snippet) is
included as a terraform-shaped starting point if you manage Authentik as
code; adapt it to however your own config is organized (or do the
equivalent by hand in the Authentik UI).

What this app needs from your IdP:

1. **An application/provider entry** for `seerr-quota`, proxied the same way
   every other forward-auth-protected app in your stack is.
2. **Access granted** to every member who should see the quota dashboard —
   typically "the same people who have access to Seerr."
3. **A dedicated, read-only service credential** (`AUTHENTIK_TOKEN`). Per
   `wiki/Feature-02-Account-Sync.md`, a read-only token in Authentik means a
   dedicated service-account user in a group holding a role with exactly
   three global permissions: `authentik_core.view_application`,
   `authentik_core.view_user`, `authentik_policies.view_policybinding`. No
   write permission anywhere — Authentik does not support scoping a token
   more narrowly than the user it belongs to, so the user itself has to be
   narrow.

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
