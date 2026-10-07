# Feature 10 — In-Seerr quota banner

## Summary

Show members their quota status **inside Seerr**, where they actually are when
they request something — a banner across the top of every Seerr page telling
them they're over quota, by how much, how many requests are held, and where to
go. Injected by SWAG via `sub_filter`, exactly as the Authentik theme already
injects its scripts. No fork of Seerr, no patched image.

## Why this exists

`D-4a` holds an over-quota request rather than declining it, because Seerr's
API cannot carry a decline reason. That solved the "bare, unexplained
rejection" problem — but it created a quieter one: **a held request just shows
"Pending" in Seerr, which looks like nothing is wrong.** The member has no
signal at all unless they read the email from `FR-ENF-13`.

Email is a poor primary channel here. It arrives out of context, minutes later,
in an inbox the person may not check for days, and it's the same channel Seerr
already uses for "your request is available" — so it competes with itself.
The place to tell someone their request is stuck is the page where they made it.

## User stories

- As a **member**, I want to see immediately and without leaving Seerr that I'm
  out of room, so I don't file five more requests wondering why nothing happens.
- As a **member**, I want the banner to tell me the number and where to fix it,
  not just "you have a problem".
- As the **operator**, I don't want a Seerr upgrade to break Seerr because of
  something I bolted on.

## Approach

```
member's browser → seerr.example.com (reverse proxy)
                     │
                     ├─ HTML response ──► sub_filter injects, before </head>:
                     │                      <script defer src="/_/quota-banner.js">
                     │
                     ├─ GET /_/quota-banner.js ──► alias to a static copy of quota-banner.js
                     │
                     └─ GET /_quota-status ─────► proxy to seerr-quota:3000
                                                  (Authentik gate + Remote-User,
                                                   SAME ORIGIN — no CORS)
```

Serving the status endpoint under **`seerr.example.com/_quota-status`** rather
than calling `quota.example.com` cross-origin is the whole trick: same origin
means no CORS preflight, no cookie `SameSite` problems, and the existing
Authentik forward-auth on that vhost supplies `Remote-User` — so the endpoint
sees exactly the same identity the app does everywhere else.

## Functional requirements

- **FR-BAN-1** — SWAG MUST inject a single `<script defer>` tag before `</head>`
  on HTML responses from `seerr.example.com`, using `sub_filter` with
  `sub_filter_once on` and `sub_filter_types text/html`, and MUST set
  `proxy_set_header Accept-Encoding "";` so the body is uncompressed and the
  filter can match.
- **FR-BAN-2** — The status endpoint MUST be same-origin
  (`seerr.example.com/_quota-status`), behind the existing Authentik gate, with
  `Remote-User` injected by nginx.
- **FR-BAN-3** — The endpoint MUST return **only the calling member's own**
  status: usage, effective quota, shortfall, held-request count, and a link. It
  MUST NOT return any other member's data, and MUST NOT be reachable without
  `Remote-User` (`FR-SSO-2`).
- **FR-BAN-4** — The banner MUST render only when there is something to say:
  the member is over quota, or holds ≥1 held request. A member in good standing
  MUST see nothing at all — a permanent chrome element that usually says
  "you're fine" trains people to ignore it.
- **FR-BAN-5** — The banner MUST state the concrete numbers: current usage,
  quota, how much to free, and how many requests are waiting. Not "you are over
  your limit".
- **FR-BAN-6** — The banner MUST link to the app's own URL, taken from the
  `APP_URL` setting rather than hardcoded, since that is where the member can
  see and (from `P2-4`) delete their titles.
- **FR-BAN-7** — **The script MUST fail silently and completely.** Any error —
  the app down, a non-200, malformed JSON, a slow response — results in no
  banner and no console noise, and MUST NOT alter, block, or break any part of
  Seerr. Seerr working is worth more than the banner rendering.
- **FR-BAN-8** — Seerr is a client-routed app; the banner MUST survive
  client-side navigation without a full page load, and MUST NOT stack duplicate
  banners. Use an install-once guard on `window` plus re-attachment on route
  change.
- **FR-BAN-9** — The script MUST NOT depend on any Seerr-internal CSS class,
  DOM id, or component structure. It attaches to `document.body` and styles
  itself inline. A Seerr upgrade that rewrites the UI must not break it.
- **FR-BAN-10** — Styling MUST use the `--term-*` palette values from
  [[Theming]] so the banner reads as part of the same system,
  and MUST respect `prefers-color-scheme`. It MUST be dismissible for the
  session (not permanently — the condition is still true tomorrow).
- **FR-BAN-11** — The endpoint MUST be cheap: served from the last attribution
  snapshot, no upstream calls, no recomputation. It is hit on every Seerr page
  load by every user.
- **FR-BAN-12** — The banner MUST NOT be the only channel. It complements the
  email in `FR-ENF-13`; a member who never opens Seerr again still gets told.

## Interactions

**nginx** — your Seerr vhost config, mirroring the forward-auth block every
other protected vhost already uses:

```nginx
location = /_/quota-banner.js {
    alias /config/www/quota-banner.js;
    default_type application/javascript;
    add_header Cache-Control "public, max-age=60" always;   # short: iterate fast
}

location = /_quota-status {
    include /config/nginx/authentik-location.conf;
    proxy_set_header Remote-User   $authentik_username;
    proxy_set_header Remote-Groups $authentik_groups;
    include /config/nginx/proxy.conf;
    include /config/nginx/resolver.conf;
    set $upstream_app  seerr-quota;
    set $upstream_port 3000;
    set $upstream_proto http;
    proxy_pass $upstream_proto://$upstream_app:$upstream_port/api/quota-status;
}

location / {
    # … existing Seerr proxy block, plus:
    proxy_set_header Accept-Encoding "";
    sub_filter '</head>' '<script defer src="/_/quota-banner.js"></script></head>';
    sub_filter_once on;
    sub_filter_types text/html;
}
```

**The app** — `GET /api/quota-status`, identity from `Remote-User`, reading the
existing snapshot:

```json
{ "state": "over_quota", "usageBytes": 450000000000, "quotaBytes": 400000000000,
  "shortfallBytes": 50000000000, "heldRequests": 3, "url": "https://quota.example.com" }
```
`state` ∈ `ok` / `over_quota` / `held_only` / `unconfigured`.

**Precedence, when more than one could apply:**
1. `over_quota` — a known limit is exceeded. Render the full numbers.
2. `held_only` — **any** held requests, whatever the quota state. Render the
   held count and the link, but no quota figures (there may be none to state).
3. `unconfigured` / `ok` — render nothing.

`held_only` deliberately outranks `unconfigured`: a held request is a concrete
thing the member can already see sitting at "Pending" in Seerr, so saying
nothing about it is the one outcome guaranteed to confuse them. This
combination only arises if the global default is cleared after holds already
exist — rare, but "your requests are stuck and nothing explains why" is exactly
the failure this feature exists to prevent.

**The script** — `examples/quota-banner.js`, a self-contained IIFE with
an install-once guard.

## Acceptance criteria

- **Given** a member over quota, **when** they load any Seerr page, **then** a
  banner states their usage, quota, shortfall, held count, and links to
  `quota.example.com`.
- **Given** a member in good standing, **when** they load Seerr, **then** no
  banner renders and no visible change occurs.
- **Given** `seerr-quota` is stopped, **when** a member loads Seerr, **then**
  Seerr works completely normally, with no banner and no console error.
- **Given** a member navigates between Seerr pages client-side, **when** the
  route changes, **then** exactly one banner is present — never zero, never two.
- **Given** any member, **when** they call `/_quota-status` directly, **then**
  they receive only their own figures.
- **Given** an unauthenticated request to `/_quota-status`, **then** the
  Authentik gate rejects it before the app is reached.
- **Given** dark mode, **when** the banner renders, **then** it matches the
  palette of the rest of the system.

## Edge cases & failure modes

- **Seerr upgrade changes the HTML shell** — `</head>` is about as stable a
  target as exists, and `FR-BAN-9` forbids depending on anything Seerr-internal.
  Add this to the smoke test when bumping Seerr's tag.
- **`sub_filter` silently not matching** — the classic cause is forgetting
  `proxy_set_header Accept-Encoding "";`, which leaves the body gzipped so the
  literal `</head>` never appears — see `examples/seerr-banner.nginx.snippet`.
- **Bandwidth** — disabling upstream gzip applies to Seerr's HTML documents
  only, not its JS/CSS/image assets. The same trade-off most forward-auth login pages already make.
- **A member with no email on file** — the banner becomes their *only*
  channel, which is an argument for building it, not against.

## Rejected alternatives

- **Seerr's own decline notification.** No reason field exists anywhere in its
  API — verified, P0-1 §C. This is what forced
  `D-4a` in the first place.
- **Filing a Seerr "issue" against the media.** Issues attach to *media*, not to
  a user's request, so every other member would see it. Wrong semantics, and
  it pollutes a feature meant for real content problems.
- **Forking or patching the Seerr image.** Avoid forking upstream images where
  possible; a patched image needs redoing on every upgrade, which is exactly
  what the CSS-injection approach avoids.
- **Seerr's web push.** That's Seerr's own subscription mechanism
  (`user_push_subscription`); this app can't send through it.

## Open questions

- **Should the banner also appear at the moment of requesting**, rather than
  only as persistent page chrome? That would mean hooking Seerr's request modal
  — Seerr-internal DOM, which `FR-BAN-9` forbids. Persistent chrome is the
  honest version. Revisit only if members report missing it.
- **Should it show a warning *approaching* the quota** (e.g. >85%)? Cheap to
  add and arguably kinder than a surprise at 100%. Not in v1; `FR-BAN-4`'s
  "only when there's something to say" would need widening to "something
  actionable", which is a judgement call worth making with real usage data.
