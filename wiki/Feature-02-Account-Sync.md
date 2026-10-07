# Feature 2 — Account Sync

## Summary

Authentik is the source of truth for who exists and who is entitled to Seerr;
Seerr accounts only materialise when someone first logs in. This feature
reconciles the two on a schedule, classifies every mismatch, and surfaces the
drift — so "who has a quota" is never quietly different from "who can request".

## User stories

- As the **operator**, I want a single screen that tells me every person who can
  request media and whether they have a Seerr account yet, so that onboarding
  someone isn't a four-system scavenger hunt.
- As the **operator**, I want a newly-added member to get the default quota
  automatically, so that nobody is accidentally unlimited because I forgot a step.
- As a **member**, I never want to be told I have no quota because a sync didn't
  run.

## The chain, and why it drifts

```
Authentik user  ──LDAP──►  Jellyfin user  ──login──►  Seerr user
 (source of truth)          (auto-created)            (created lazily,
 (e.g. terraform-managed)                              on FIRST Seerr login)
```

Concretely, on a typical deployment: most Authentik users with the Seerr
application binding will also have a matching Seerr row, classified
`matched`. Some entitled users may never have logged into Seerr yet — they
classify `no_seerr_account`. And Seerr often carries at least one row with
no Authentik counterpart at all (a Seerr-internal service/admin account) —
that classifies `not_entitled`.

Any entitled person with no Seerr account, and any Seerr account with no
entitled person behind it, is exactly the drift this feature exists to make
visible.

## Functional requirements

- **FR-SYNC-1** — Every `RECONCILE_INTERVAL`, the app MUST enumerate Authentik
  users and determine, for each, whether they hold the `jellyseerr` application
  binding, and upsert a `member` row.
- **FR-SYNC-2** — The app MUST match members to Seerr users by
  `user.jellyfinUsername` compared case-insensitively to `sso_username`,
  falling back to `user.email` compared case-insensitively to `member.email`.
- **FR-SYNC-3** — If a match is not one-to-one in both directions, both sides
  MUST be marked `ambiguous`, MUST NOT have anything attributed to them, and
  MUST be surfaced in the admin UI. The app MUST NOT guess between candidates.
- **FR-SYNC-4** — Every member MUST be classified as exactly one of `matched`,
  `no_seerr_account`, `not_entitled`, `ambiguous`, with a human-readable
  `sync_note` whenever it isn't `matched`.
- **FR-SYNC-5** — A member seen for the first time MUST receive the global
  default quota (a `quota_policy` row with `source = default`). No member may
  exist without a resolvable quota.
- **FR-SYNC-6** — A member who loses the `jellyseerr` binding MUST flip
  `entitled = 0` and MUST NOT be deleted; their claims, usage history and audit
  rows MUST remain intact and visible to the operator.
- **FR-SYNC-7** — The app MUST NOT create, modify, or delete Authentik users,
  groups, or bindings. Authentik is read-only to this app, without exception —
  it is terraform-managed and out-of-band edits get reverted.
- **FR-SYNC-8** — Auto-provisioning a Seerr account MUST be an explicit
  per-user operator action (a button), not automatic, until the Seerr
  import path is verified (`P2-3` in the [[Backlog]]).
- **FR-SYNC-9** — Every sync run MUST record a `sync_run` row. Every
  classification *change* MUST write an audit row; unchanged classifications
  MUST NOT (or the log fills with noise every 15 minutes).
- **FR-SYNC-10** — If the Authentik API is unreachable, the sync step MUST fail
  in isolation, leave the previous `member` state intact, mark the data stale,
  and MUST NOT mass-flip everyone to `not_entitled`.

## Interactions

**Authentik** (`✓ verified` live — P0-3):

```
GET /api/v3/core/applications/jellyseerr/        ← detail-by-slug, NOT the list
GET /api/v3/policies/bindings/?target=<application uuid>
GET /api/v3/core/users/?is_active=true           ← needed for the stable `uuid`
```

> **Do not use `GET /core/applications/?slug=jellyseerr`.** The list endpoint
> filters to applications the *calling* identity may launch, evaluating policies
> per request — called twice with the same admin token it returned an empty set
> once and the wrong application once. `?superuser_full_list=true` bypasses it
> but is unavailable to a non-admin token, which is exactly what this app uses.
> The **detail-by-slug** form is deterministic (verified consistent across three
> runs). Better still, skip the runtime lookup entirely: `jellyseerr` is already
> a `local.proxy_services` key, so export its UUID as a terraform `output` and
> pass it in via `.env`.

> The binding's embedded `user_obj` carries username, name, email and
> `is_active`, but **not** the stable `uuid` that `FR-SYNC-1`/rename-tracking
> needs. That requires the separate bulk `GET /core/users/?is_active=true`,
> joined on `pk`.

Entitlement is expressed as a per-(user, application) policy binding —
`authentik_policy_binding.user_access` if you manage Authentik with
terraform, one binding per pair, with app-default `deny`. So "is this user
entitled" == "does a binding exist for (user, jellyseerr)". Verified live
against a real deployment: the query returned exactly the expected set of
users with zero drift from what the IaC declared, all as user-type bindings
with no group grants.

**Seerr** (`✓ verified` live — P0-1 §B):

```
GET /api/v1/user?take=100
  → { pageInfo, results: [{ id, email, username, displayName,
                            jellyfinUsername, jellyfinUserId,
                            permissions, userType, requestCount,
                            movieQuotaLimit/Days, tvQuotaLimit/Days }] }
```

> **Don't build the field list from Seerr's bundled OpenAPI spec** — its `User`
> schema is stale and omits `jellyfinUsername`, `jellyfinUserId`, `displayName`
> and every quota field, all of which the API actually returns. Use the live
> capture in P0-1 §B.
>
> `jellyfinUserId` is returned and **should be stored** (`member.jellyfin_user_id`).
> It is a stabler identity than `jellyfinUsername` — a rename breaks the
> username match but not this — and it is the join key playback accounting
> needs (`FR-ACCT-6`). Match on username first per `FR-SYNC-2`, but persist the
> id and prefer it for re-matching.

Note the Seerr API is reachable at `http://jellyseerr:5055` on the proxy
network — the container name stays `jellyseerr` even on a Seerr (rebranded
from Jellyseerr) deployment, since that's just whatever you name the
container. The API key lives in Seerr's own `settings.json` under
`main.apiKey` and must be copied into this stack's `.env`, not read from that
file at runtime.

## Acceptance criteria

- **Given** a member holds the `jellyseerr` binding and has no Seerr row,
  **when** a sync runs, **then** they appear as `no_seerr_account` with the
  default quota applied and no attributed usage.
- **Given** a Seerr-internal service account exists in Seerr with no matching
  Authentik member, **when** a sync runs, **then** it is reported
  `not_entitled` and excluded from fleet usage totals.
- **Given** two Seerr users share an email, **when** a sync runs, **then** both
  are `ambiguous`, nothing is attributed to either, and the admin dashboard says
  so explicitly.
- **Given** the Authentik API returns 500, **when** a sync runs, **then**
  `sync_run.steps.identity.ok = false`, member rows are unchanged, and the UI
  shows a staleness banner.
- **Given** a brand-new member, **when** first seen, **then** exactly one audit
  row records their creation and default quota assignment.

## Edge cases & failure modes

- **Username changed in Authentik** — `authentik_uuid` is stored precisely so a
  rename is recognised as the same person rather than a new member plus an
  orphan. On a detected rename, carry the row forward and audit it.
- **A member with two Jellyfin accounts** — a real risk for any shared/
  household login. Falls out as `ambiguous`; resolution is manual and
  operator-driven.
- **Deactivated Authentik users** — `is_active = false` and no bindings, so
  they classify as `not_entitled` and are hidden from the default fleet view
  behind a "show inactive" toggle.
- **Seerr user deleted out from under us** — claims keyed on `sso_username`, not
  `seerr_user_id`, so usage survives; `seerr_user_id` goes null and the member
  reclassifies to `no_seerr_account`.

## Open questions

- **Do entitled-but-never-logged-in members actually want Seerr access?**
  They hold the binding but have never logged in. The operator may prefer to
  revoke the binding rather than provision accounts. This feature only makes
  the choice visible; it doesn't make it.
- **Should losing entitlement trigger anything?** Proposal: no automatic action.
  Their claims stay attributed (the bytes are still on disk and still theirs),
  and the operator decides whether to reassign or delete. Automatically freeing
  a departed member's media would be the most destructive possible default.
