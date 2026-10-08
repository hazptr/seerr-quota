# Feature 2 — Account Sync

## Summary

**Changed in 0.2.0** — the Authentik-entitlement integration was removed
(see `CHANGELOG.md`). Seerr is now the SOLE source of truth for who exists:
every Seerr user is a member. This feature reconciles the `member` table
against Seerr's own user list on a schedule, carries forward anyone whose
Seerr account disappears (never deleting a row), and assigns the global
default quota to every newly-seen member.

## User stories

- As the **operator**, I want every Seerr user to automatically have a
  quota-dashboard member row, so that onboarding someone is "give them
  access to Seerr and the quota.* vhost," nothing more.
- As the **operator**, I want a newly-added member to get the default quota
  automatically, so that nobody is accidentally unlimited because I forgot a
  step.
- As a **member**, I never want to be told I have no quota because a sync
  didn't run.

## Roster source (0.2.0)

```
Seerr user  ──reconcile──►  member row
(source of truth — created lazily, on first Seerr login or admin creation)
```

Every CURRENT Seerr user is `entitled = true`, `sync_status = 'matched'`.
There is no second, independent identity-provider entitlement list to
compare against any more — the drift this feature used to surface (someone
entitled in the IdP but with no Seerr account) can't arise under this model,
because entitlement and "has a Seerr account" are now the same fact.

The one thing this feature still has to get right is **key stability**:
`member.sso_username` is the login username a long production history
(`claim`, `deletion`, `audit`, `quota_policy`, `request_decision`) is keyed
on. A member row already linked to a Seerr account (`member.seerr_user_id`
set) keeps its `sso_username` forever, however Seerr's own username/email
for that account changes later — see `src/lib/members/classify.ts`'s header
comment for the exact algorithm (re-match by `seerr_user_id` first; only a
genuinely new Seerr account gets a freshly-derived key).

## Functional requirements

- **FR-SYNC-1** — Every `RECONCILE_INTERVAL`, the app MUST enumerate every
  Seerr user and upsert a `member` row for each, `entitled = true`,
  `sync_status = matched`.
- **FR-SYNC-2** *(Removed in 0.2.0 — superseded by FR-SYNC-1)*: matching
  Seerr users against a separate IdP-entitlement list no longer applies;
  there is no second list.
- **FR-SYNC-3** — A brand-new member's key MUST be derived deterministically
  (`jellyfinUsername` → `username` → `email` → `seerr:{id}`, normalized) and
  MUST NOT guess between two Seerr accounts that derive the identical key —
  both are surfaced `ambiguous` instead, with neither linked.
- **FR-SYNC-4** — Every member MUST be classified as exactly one of
  `matched`, `no_seerr_account`, `not_entitled`, `ambiguous`, with a
  human-readable `sync_note` whenever it isn't `matched`. `no_seerr_account`
  can no longer be PRODUCED for a new row since 0.2.0 (it presupposed a
  separate IdP-entitlement source with no Seerr account to match) — it
  stays in the enum only so a pre-0.2.0 row that already carries it still
  reads back fine.
- **FR-SYNC-5** — A member seen for the first time MUST receive the global
  default quota (a `quota_policy` row with `source = default`). No member
  may exist without a resolvable quota.
- **FR-SYNC-6** — A member whose Seerr account disappears MUST flip
  `entitled = 0` and MUST NOT be deleted; their claims, usage history and
  audit rows MUST remain intact and visible to the operator. `seerr_user_id`
  is preserved, not nulled, so a resurfaced account re-links to the SAME row
  rather than creating a duplicate.
- **FR-SYNC-7** *(Removed in 0.2.0)*: "the app MUST NOT create, modify, or
  delete Authentik users, groups, or bindings" no longer applies — there is
  no Authentik integration left to constrain. The spirit survives as a
  general rule: this feature still never writes to Seerr either, only reads
  its user list.
- **FR-SYNC-8** — Auto-provisioning a Seerr account MUST be an explicit
  per-user operator action (a button), not automatic, until the Seerr
  import path is verified (`P2-3` in the [[Backlog]]).
- **FR-SYNC-9** — Every sync run MUST record a `sync_run` row. Every
  classification *change* MUST write an audit row; unchanged classifications
  MUST NOT (or the log fills with noise every 15 minutes).
- **FR-SYNC-10** — If the Seerr user-list API is unreachable, the sync step
  MUST fail in isolation, leave the previous `member` state intact, mark the
  data stale, and MUST NOT mass-flip everyone to `not_entitled`. *(Extended,
  security review PR #17)*: the SAME refusal applies to a Seerr response
  that merely LOOKS successful but is suspiciously small — an empty list
  while at least one member is currently entitled, a list in which EVERY
  confirmed-linked member has vanished (any roster size), or a list that
  would flip more than half of more than two confirmed-linked members to
  `not_entitled` in one cycle. Only rows with a confirmed Seerr link count.
  All refuse exactly like an upstream error
  (a `sync.failed` audit row, nothing applied) — see
  `src/lib/members/classify.ts`'s `checkMassRevocationRisk`. An operator's
  one-shot force (`FR-ADM-10a`) overrides the flip thresholds only; an empty
  list is refused even when forced.
- **Known gap** — a member who deletes and recreates their Seerr account
  gets a new `seerr:{id}` row marked `ambiguous` rather than re-attaching to
  their old row (a linked row is never adopted by a different Seerr id).
  There is no UI to merge the two yet; resolve it in the database.

## Interactions

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
> needs (`FR-ACCT-6`).

Note the Seerr API is reachable at `http://jellyseerr:5055` on the proxy
network — the container name stays `jellyseerr` even on a Seerr (rebranded
from Jellyseerr) deployment, since that's just whatever you name the
container. The API key lives in Seerr's own `settings.json` under
`main.apiKey` and must be copied into this stack's `.env`, not read from that
file at runtime.

**Identity provider** — 0.2.0 removed any direct call from this feature to
an IdP's API entirely. Login identity still comes from forward-auth headers
(`wiki/Feature-01-SSO-Identity.md`), but THIS feature no longer talks to
Authentik or any other IdP's admin API — see `CHANGELOG.md` 0.2.0.

## Acceptance criteria

- **Given** a Seerr user with no existing `member` row, **when** a sync
  runs, **then** a new `member` row is created, `matched`, entitled, with
  the default quota applied.
- **Given** an existing member already linked to a Seerr account,
  **when** that Seerr account's username/email changes, **then** the
  member's `sso_username` is UNCHANGED and no duplicate row is created.
- **Given** two Seerr accounts that derive the identical new login key,
  **when** a sync runs, **then** exactly one `ambiguous` row is written,
  neither account is linked, and the admin dashboard says so explicitly.
- **Given** the Seerr user-list API returns 500, **when** a sync runs,
  **then** `sync_run.steps.seerr_users.ok = false`, member rows are
  unchanged, and the UI shows a staleness banner.
- **Given** a brand-new member, **when** first seen, **then** exactly one
  audit row records their creation and default quota assignment.

## Edge cases & failure modes

- **A member's Seerr username/email changes** — the member's `sso_username`
  is never re-derived once `seerr_user_id` is linked; only the
  display/contact fields (`display_name`, `email`, `jellyfin_user_id`)
  refresh.
- **Two Seerr accounts share a derived key** (e.g. identical
  `jellyfinUsername`) — classifies `ambiguous`; resolution is manual and
  operator-driven; neither account is linked to a row until resolved.
- **Seerr user deleted out from under us** — claims keyed on `sso_username`,
  not `seerr_user_id`, so usage survives; the member reclassifies to
  `not_entitled`, `seerr_user_id` is PRESERVED (not nulled) so a resurfaced
  account re-links to the same row.

## Open questions

- **Should losing a Seerr account trigger anything?** Proposal: no automatic
  action. Their claims stay attributed (the bytes are still on disk and
  still theirs), and the operator decides whether to reassign or delete.
  Automatically freeing a departed member's media would be the most
  destructive possible default.
