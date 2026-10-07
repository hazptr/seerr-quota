# Feature 1 — SSO & Identity

## Summary

The app uses the same login as everything else on the host: Authentik
forward-auth enforced at the reverse proxy, which injects `Remote-User` / `Remote-Groups`.
The app never runs its own login, never stores a password, and treats a request
without `Remote-User` as unauthenticated even on the loopback port.

## User stories

- As a **member**, I want to open `quota.example.com` and already be signed in,
  so that finding out I'm over quota doesn't also mean making an account.
- As the **operator**, I want the app gated by the same Authentik binding that
  gates Seerr, so that "who can use Seerr" and "who has a quota" can't drift
  apart.

## Functional requirements

- **FR-SSO-1** — The app MUST be publicly reachable only via the reverse proxy at
  `quota.example.com` with both Authentik includes active
  (`authentik-server.conf` in the server block, `authentik-location.conf` in
  each gated location). The container port MUST bind to `127.0.0.1` only.
- **FR-SSO-2** — Identity MUST derive solely from the `Remote-User` header,
  resolved once in Next.js middleware. Any request lacking it MUST be rejected
  with **401**, including requests arriving on the loopback port.
- **FR-SSO-3** — `Remote-Groups` MUST be parsed on both `|` and `,`. A user is
  **operator** if their username is in `ADMIN_USERS` (default `admin`) or
  their groups include `admins`; everyone else is a **member**.
- **FR-SSO-4** — The app MUST NOT treat a client-supplied `Remote-User` or
  `Remote-Groups` as authoritative. The nginx location block MUST set both
  headers unconditionally so a client-sent copy is overwritten, and the
  loopback bind MUST prevent reaching the app around the reverse proxy.
- **FR-SSO-5** — Every operator-only route (quota edits, protect/unprotect,
  fleet views, other members' data, audit export) MUST re-check the role
  server-side on each request and return **403** for members. Hiding a control
  in the UI is not authorization.
- **FR-SSO-6** — There MUST be an unauthenticated `GET /healthz` for Gatus,
  exempt from FR-SSO-2, returning liveness only — no identity resolution, no
  upstream API call, no DB query beyond an open check.
- **FR-SSO-7** — `POST /api/seerr/webhook` is exempt from FR-SSO-2 (Seerr can't
  authenticate through the gate) and MUST instead require a shared secret
  presented as a header, compared in constant time. A request with a missing or
  wrong secret MUST 401 and MUST write an audit row (`outcome = denied`).
- **FR-SSO-8** — A member who is authenticated but has no `member` row, or whose
  `sync_status` is not `matched`, MUST get an informative screen explaining the
  situation and naming the operator — never a raw error, and never an empty
  dashboard that looks like "you're using 0 bytes".

## Interactions

nginx vhost config for `quota.example.com`, same shape as every other
forward-auth-protected vhost:

```nginx
server {
    listen 443 ssl;
    server_name quota.*;
    include /config/nginx/ssl.conf;
    include /config/nginx/authentik-server.conf;

    # Unauthenticated liveness for Gatus (FR-SSO-6) — must BYPASS the gate.
    location = /healthz {
        include /config/nginx/proxy.conf;
        include /config/nginx/resolver.conf;
        set $upstream_app seerr-quota;
        set $upstream_port 3000;
        set $upstream_proto http;
        proxy_pass $upstream_proto://$upstream_app:$upstream_port;
    }

    location / {
        include /config/nginx/authentik-location.conf;
        proxy_set_header Remote-User   $authentik_username;
        proxy_set_header Remote-Groups $authentik_groups;
        include /config/nginx/proxy.conf;
        include /config/nginx/resolver.conf;
        set $upstream_app seerr-quota;
        set $upstream_port 3000;
        set $upstream_proto http;
        proxy_pass $upstream_proto://$upstream_app:$upstream_port;
    }
}
```

The Seerr webhook does **not** traverse this vhost — Seerr reaches the app
directly over the shared Docker network at
`http://seerr-quota:3000/api/seerr/webhook`, so it never meets the Authentik
gate. That is why FR-SSO-7 exists.

Identity resolution, middleware:

```ts
const username = req.headers.get("Remote-User")?.trim().toLowerCase();  // else 401
const groups   = (req.headers.get("Remote-Groups") ?? "").split(/[|,]/).filter(Boolean);
const isOperator = ADMIN_USERS.includes(username) || groups.includes("admins");
```

Authentik side — a new forward-auth application entry, slug `seerr-quota`,
plus access granted to each member who should see it. Full sequence in
[[Deployment]].

## Acceptance criteria

- **Given** no `Remote-User`, **when** any route except `/healthz` and the
  webhook is hit, **then** 401.
- **Given** `Remote-User: alice`, **when** they open the app, **then** they are
  authenticated as member `alice` with no password prompt and see only their
  own usage.
- **Given** `Remote-User: alice`, **when** they request an operator route or
  another member's data by ID, **then** 403 and an audit row with
  `outcome = denied`.
- **Given** a request to the container port directly (not via the reverse proxy),
  **when** issued, **then** it is unreachable.
- **Given** a client that sets its own `Remote-User: admin` header through
  the reverse proxy, **when** the request is proxied, **then** nginx has overwritten it and
  the app sees the real Authentik username.
- **Given** the webhook secret is wrong, **when** `POST /api/seerr/webhook` is
  called, **then** 401 and an audit row.

## Edge cases & failure modes

- **Authentik outpost down** → the reverse proxy 401s/redirects before the app is reached;
  no special handling needed. Gatus's `/healthz` probe bypasses the gate and so
  still reports the app itself as up, which is the intended signal separation.
- **Username casing** — Authentik usernames are lowercase by convention here;
  normalise to lowercase for all comparisons and storage, but keep the raw
  header value for display.
- **Empty `Remote-Groups`** → member with no extra groups. Never crash.
- **Operator's own quota** — the operator is exempt from enforcement
  (`FR-ENF-6`) but still *has* usage and still appears in accounting. `admin`
  is a real requester with real bytes attributed; suppressing them would make
  the totals wrong.

## Open questions

- **A dedicated Authentik group, or reuse the `jellyseerr` binding?** Default
  proposal: gate the app on its own `seerr-quota` slug (so access is grantable
  independently) but derive *membership and entitlement* from the `jellyseerr`
  binding. Someone with a quota but no access to this app can't self-serve,
  which defeats the point — so in practice the two lists should be kept
  identical, and [[Feature-07-Admin-Dashboard]] `FR-ADM-9` surfaces it when
  they aren't.
