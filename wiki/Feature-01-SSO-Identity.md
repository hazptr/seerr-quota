# Feature 1 — SSO & Identity

## Summary

The app uses the same login as everything else on the host: forward-auth
enforced at the reverse proxy, which injects configurable headers (default
`Remote-User` / `Remote-Groups` / `Remote-Email`). **Since 0.2.0 this app has
no identity-provider integration of its own** — it works behind ANY
forward-auth proxy (Authentik, Authelia, oauth2-proxy in front of any OIDC
IdP, Pomerium, ...), trusting whichever one is configured to set these
headers. The app never runs its own login, never stores a password, and
treats a request without the configured username header as unauthenticated
even on the loopback port.

## User stories

- As a **member**, I want to open `quota.example.com` and already be signed in,
  so that finding out I'm over quota doesn't also mean making an account.
- As the **operator**, I want the app gated by whatever forward-auth proxy
  already protects the rest of my stack, so that swapping or reconfiguring
  my identity provider never requires touching this app's code.
- As the **operator**, I want a member's history to survive even if my IdP's
  username for them ever changes (migration, rename, re-provisioning),
  so that I don't have to manually re-link claims/audit history.

## Functional requirements

- **FR-SSO-1** — The app MUST be publicly reachable only via the reverse proxy at
  `quota.example.com` with the forward-auth gate active for the whole vhost
  (whatever your IdP's include/directive is — Authentik outpost, Authelia,
  oauth2-proxy's `auth_request`, ...). The container port MUST bind to
  `127.0.0.1` only.
- **FR-SSO-2** — Identity MUST derive solely from the configured username
  header (`AUTH_USER_HEADER`, default `Remote-User`), resolved once in Next.js
  middleware. Any request lacking it MUST be rejected with **401**, including
  requests arriving on the loopback port.
- **FR-SSO-3** — The configured groups header (`AUTH_GROUPS_HEADER`, default
  `Remote-Groups`) MUST be parsed on both `|` and `,`. At REQUEST TIME, a user
  is **operator** if their resolved member key OR raw header username is in
  `ADMIN_USERS` (default `admin`), OR their groups include `ADMIN_GROUP`
  (default `admins`); everyone else is a **member**. (The BACKGROUND
  enforcement-exemption check, `member.is_operator`, differs — see
  `FR-SSO-9` below and `wiki/Feature-02-Account-Sync.md`.)
- **FR-SSO-4** — The app MUST NOT treat a client-supplied copy of the
  configured identity headers as authoritative. The reverse proxy's location
  block MUST set all configured headers unconditionally so a client-sent copy
  is overwritten, and the loopback bind MUST prevent reaching the app around
  the reverse proxy.
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
- **FR-SSO-9** *(0.2.0)* — **Login → member resolution.** The app MUST resolve
  the configured username header to a `member.sso_username` in this order,
  refusing (never guessing) past the first that fails:
  1. **Exact**: a `member` row already has `sso_username == headerUsername`.
  2. **Alias**: a `member` row already has `login_alias == headerUsername`
     (a PRIOR successful email resolution recorded it).
  3. **Email** — ONLY when `AUTH_EMAIL_HEADER` is explicitly configured
     (it defaults to EMPTY/disabled — see `FR-SSO-10` for why this must
     not default to an actual header name). When enabled, and the
     configured email header is present and non-blank, and EXACTLY ONE
     *entitled, non-operator, not-yet-aliased* member's `email` matches it
     case-insensitively, resolve to that member and record
     `headerUsername` as its `login_alias` — audited
     (`member.alias_linked`), first time only. Zero or more than one
     match, a target that is an operator (or whose key is in
     `ADMIN_USERS`), or a target that already has a different alias MUST
     ALL refuse, never guess or overwrite — an operator role, and an
     already-established alias, are only ever changed by an explicit
     operator action (`POST /api/admin/members/clear-alias`,
     `member.alias_cleared`).
  If none resolve, the raw header username is used unchanged (falls through
  to FR-SSO-8's "not linked yet" screen for a genuinely unknown login). Every
  downstream authorization check, audit `actor`, and DB lookup keyed on
  `sso_username` MUST use the RESOLVED key, never the raw header value —
  this is what stops one member from ever acting on another member's claims
  through a header collision with someone else's alias/`sso_username`.
- **FR-SSO-10** *(0.2.0, security review)* — `AUTH_EMAIL_HEADER` and
  `ADMIN_GROUP` MUST both default to EMPTY (disabled), never to an actual
  header/group name. Both are only as trustworthy as the operator's own
  proxy configuration — defaulting either one "on" would make an
  unverified assumption about a reverse proxy this app has no way to
  inspect, for a setting whose failure mode is identity confusion or
  privilege escalation, not a cosmetic default. An operator opts in by
  setting a real value after verifying (for `AUTH_EMAIL_HEADER`) that
  their proxy unconditionally overwrites that header on every request.

## Interactions

nginx vhost config for `quota.example.com`, shown here for an Authentik
outpost — the Authelia and oauth2-proxy equivalents (and the generic
pattern for any other IdP) live in `examples/forward-auth/`:

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
        proxy_set_header Remote-Email  $authentik_email;
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
`http://seerr-quota:3000/api/seerr/webhook`, so it never meets the
forward-auth gate. That is why FR-SSO-7 exists.

Identity resolution, middleware (header NAMES come from
`Config.identity.userHeader`/`groupsHeader`, not hardcoded):

```ts
const username = req.headers.get(AUTH_USER_HEADER)?.trim().toLowerCase();  // else 401
const groups   = (req.headers.get(AUTH_GROUPS_HEADER) ?? "").split(/[|,]/).filter(Boolean);
const isOperator = ADMIN_USERS.includes(username) || groups.includes(ADMIN_GROUP);
```

Login → member resolution (FR-SSO-9, `src/lib/auth/memberGate.ts`'s
`resolveMemberKey`), run once per request AFTER the above:

```ts
// 1. exact sso_username match -> use as-is
// 2. existing login_alias match -> resolve to that member
// 3. AUTH_EMAIL_HEADER, exactly one entitled member's email matches ->
//    resolve + record the alias (first time only, audited)
// else: fall through unresolved -> FR-SSO-8's "not linked yet" screen
```

IdP side — grant reverse-proxy access to the `quota.*` vhost for each person
who should see it, however your IdP expresses that (an Authentik policy
binding, an Authelia access-control rule, an oauth2-proxy allow-list, ...).
Full sequence in [[Deployment]].

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

- **IdP/forward-auth outpost down** → the reverse proxy 401s/redirects before
  the app is reached; no special handling needed. Gatus's `/healthz` probe
  bypasses the gate and so still reports the app itself as up, which is the
  intended signal separation.
- **Username casing** — login usernames are lowercase by convention here;
  normalise to lowercase for all comparisons and storage, but keep the raw
  header value for display.
- **Empty groups header** → member with no extra groups. Never crash.
- **Operator's own quota** — the operator is exempt from enforcement
  (`FR-ENF-6`) but still *has* usage and still appears in accounting. `admin`
  is a real requester with real bytes attributed; suppressing them would make
  the totals wrong.
- **Email-header match is ambiguous or absent (FR-SSO-9)** — zero or more
  than one entitled member shares the header's email, or the proxy never
  sends the header at all (or the feature isn't enabled at all): refuse,
  never guess. The login falls through to FR-SSO-8's "not linked yet"
  screen exactly as an unknown username would.
- **Email-header match resolves to an operator, or to a member who already
  has a different alias** — refuse, same as an ambiguous match. Writing an
  audit row the FIRST time this is refused for a given (header username,
  target member) pair (`member.alias_link_denied`), then staying silent on
  an exact repeat so a confused or malicious retry can't fill the log.
- **Header-username spoofing an existing alias/`sso_username`** — the alias
  write is guarded by a uniqueness check (app-level, re-verified by a DB
  unique index) before it's ever recorded; a collision is refused and
  audited (`invariant.violated`), never silently overwritten.
- **An operator needs to undo a bad alias link** — `POST
  /api/admin/members/clear-alias` clears `login_alias` (audited
  `member.alias_cleared`); the next successful email-fallback resolution
  (if the feature stays enabled) can then re-link it, going through the
  exact same checks as a first-time link.

## Removed in 0.2.0

- **Authentik-specific integration.** This app previously called Authentik's
  admin API directly (entitlement sync, the `FR-ADM-9` jellyseerr-vs-
  seerr-quota mismatch check) and required `AUTHENTIK_URL`/`AUTHENTIK_TOKEN`.
  All of that is gone — the app is IdP-agnostic now, working behind any
  forward-auth proxy. See `CHANGELOG.md` 0.2.0 for the full breaking-change
  list and `wiki/Feature-02-Account-Sync.md` for the new, Seerr-only roster
  model.
