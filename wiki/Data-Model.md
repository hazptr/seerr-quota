# Data Model

SQLite, via Drizzle + `better-sqlite3`, at `/db/seerr-quota.db` inside the
container (bind-mounted — see `docker-compose.yml`). WAL mode.

**Schema changes are additive only** — new tables, columns, and indexes,
applied idempotently at boot. Nothing that has ever shipped gets dropped or
retyped; the audit log in particular must remain readable by every future
version. The same rule applies here as to any sibling project: there is
no staging host to test a destructive migration on.

Ten tables. Nine are caches or policy and could be rebuilt from the upstream
APIs; **`audit` is the one table that cannot be reconstructed** and is the one
that matters most.

---

## `member`

One row per person known to the system. **Changed in 0.2.0**: keyed by the
forward-auth LOGIN username (`sso_username` is the historical column name;
the value is whatever `AUTH_USER_HEADER` carries, from any IdP — no longer
necessarily "Authentik username"). This is the one identifier a long
production history (`claim`, `deletion`, `audit`, `quota_policy`,
`request_decision`) is keyed on, so it MUST stay stable once a row is
linked to a Seerr account — see `src/lib/members/classify.ts`.

| Column | Type | Notes |
|---|---|---|
| `sso_username` | text PK | Login username, lowercase. For a brand-new member with no linked Seerr account yet, keyed `jellyfinUsername → username → email → seerr:{id}` (in that priority) instead |
| `authentik_uuid` | text, **deprecated 0.2.0** | Was "for stable re-matching if a username is ever changed" under the removed Authentik integration; never written by current code. `seerr_user_id` is the re-match key now. Kept (additive-only schema) so a pre-0.2.0 row's value still reads back |
| `display_name` | text | Seerr `displayName`/`username` (was Authentik `name` before 0.2.0) |
| `email` | text | Seerr email (was Authentik email before 0.2.0); still the fallback LOGIN match key for `src/lib/auth/memberGate.ts`'s email-header resolution |
| `entitled` | integer (bool) | Since 0.2.0: has a Seerr account. (Was: has the `jellyseerr` application binding in Authentik, before 0.2.0 — same column, different meaning) |
| `login_alias` | text null, **added 0.2.0** | Set the first time a login username is resolved to this member via the email-header fallback rather than an exact `sso_username` match (`src/lib/auth/memberGate.ts`) — future logins under that username then resolve instantly by alias. Unique when non-null; must never collide with another member's `sso_username` or `login_alias` |
| `is_operator` | integer (bool) | `ADMIN_USERS` ONLY (`FR-ENF-6`'s background half — no groups header exists off-request, since 0.2.0 there's no Authentik groups fetch to lean on either). **Must agree with `src/lib/auth/identity.ts`'s request-time resolution for the `ADMIN_USERS` half** — the sync imports that module's `isOperatorUser` rather than reimplementing it. The REQUEST-TIME check additionally ORs in `ADMIN_GROUP` from the live groups header, so an `ADMIN_GROUP`-only admin is request-time operator but NOT exempt from background enforcement unless also in `ADMIN_USERS` |
| `seerr_user_id` | integer null | Seerr `user.id` — since 0.2.0 this is ALSO the key-stability anchor: an existing member already linked here keeps its `sso_username` forever, however Seerr's own username/email for that account changes later |
| `jellyfin_user_id` | text null | Jellyfin GUID, normalised (no dashes, lowercase) |
| `sync_status` | text | `matched` / `no_seerr_account` / `not_entitled` / `ambiguous`. Since 0.2.0, `no_seerr_account` can no longer be produced for a new row (kept in the enum for a pre-0.2.0 row); `ambiguous` now means "two Seerr accounts derive the identical new login key," not an IdP/Seerr cross-match conflict |
| `last_hold_notified_at` | integer null | Throttles hold notifications (`FR-ENF-14`) |
| `sync_note` | text null | Why, when status isn't `matched` |
| `first_seen_at` | integer | Unix seconds |
| `last_synced_at` | integer | |

Rows are never deleted. A member whose Seerr account disappears flips
`entitled = 0` and keeps their history AND their `seerr_user_id` (not
nulled) — so a resurfaced account re-links to the same row rather than
creating a duplicate.

> **Match rule, 0.2.0** (`D-9`): re-match an EXISTING member by
> `seerr_user_id` first — this is what makes the key stable across a Seerr-
> side rename. Only a Seerr user with no linked row derives a brand-new key
> (`jellyfinUsername` → `username` → `email` → `seerr:{id}`). Two distinct
> Seerr accounts deriving the identical new key are both refused a link and
> surfaced as a single `ambiguous` row — never guess which is which.

Expected outcome on a healthy sync, 0.2.0: every current Seerr user
classifies `matched`. A pre-0.2.0 `no_seerr_account`/`not_entitled` row only
persists from before this cutover, or (for `not_entitled`) a member whose
Seerr account has since disappeared.

---

## `quota_policy`

| Column | Type | Notes |
|---|---|---|
| `sso_username` | text PK → `member` | |
| `quota_bytes` | integer null | `null` = **inherit the global default** (resolved at read time — NOT materialised into the row). `0` = unlimited. `N` = that limit |
| `source` | text | `default` / `override` |
| `note` | text null | Free text the operator can leave, shown in admin UI |
| `updated_at` | integer | |
| `updated_by` | text | `sso_username` of whoever set it |

`0 = unlimited` matches Seerr's own convention for `movieQuotaLimit` and avoids
a separate nullable "unlimited" flag. `null` and `0` mean different things and
the UI must not conflate them.

> **Inheritance is resolved at read time, never materialised.** A member with no
> override stores `null` — changing `app_setting.default_quota_bytes` then
> applies to them immediately, with no batch update and nothing to drift out of
> sync. Copying the default's *value* into each member's row would mean every
> default change is a fan-out write, and any partial failure leaves members
> silently on a stale limit.
>
> Consequently **effective-quota resolution needs BOTH inputs** — the member's
> override and the global default:
>
> | override | default | effective |
> |---|---|---|
> | `0` | *any* | unlimited |
> | `N` | *any* | limited `N` |
> | `null` | `0` | unlimited |
> | `null` | `N` | limited `N` |
> | `null` | unset | **unconfigured** (`FR-POL-2a`) |
>
> A one-argument resolver cannot express this: it has to treat `null` as either
> "inherit" or "unconfigured", and those are different states.

Operator is exempt from enforcement regardless of stored value (`FR-ENF-6`),
mirroring how Seerr's own `ADMIN` permission skips quota.

---

## `app_setting`

Operator-editable runtime settings, key/value. Seeded from config at first boot;
after that the DB wins — an env-seeds-then-DB-owns pattern (Authentik's own
`AVATARS` setting works the same way), worth knowing about because it
surprises people.

| Column | Type |
|---|---|
| `key` | text PK |
| `value` | text (JSON) |
| `updated_at` | integer |
| `updated_by` | text |

Keys: `default_quota_bytes`, `enforcement_enabled`, `delete_recent_play_days`,
`grace_bytes`, `stale_snapshot_max_age_s`. Full list and defaults in
[[Configuration]].

---

## `title`

A synced projection of one library item from Radarr or Sonarr.

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | `movie:{radarrId}` / `series:{sonarrId}` |
| `media_type` | text | `movie` / `tv` |
| `arr_instance` | text | `radarr` / `sonarr` in this deployment. The `-4k` variants are **reserved and never written**: `Configuration.md` declares one `RADARR_URL`/`SONARR_URL`, and Seerr's 4K server slots point at those same instances (`D-3`/`FR-ACCT-5`). They exist only so a second physical instance wouldn't need a schema change |
| `arr_id` | integer | The id to call DELETE with |
| `tmdb_id` | integer null | Join key to Seerr `media.tmdbId` |
| `tvdb_id` | integer null | Join key for TV |
| `title` | text | |
| `year` | integer null | |
| `size_bytes` | integer | `sizeOnDisk` (movie) / `statistics.sizeOnDisk` (series) |
| `path` | text | For the confirm screen — show people the real path |
| `added_at` | integer null | Radarr/Sonarr `added` |
| `protected` | integer (bool) | Operator pin; blocks member deletion (`D-6`) |
| `protected_reason` | text null | |
| `split_into_seasons` | integer (bool) | `P4-1` Wave 1 (shipped 2026-08-25). `true` once a whole-series row has been explicitly split into per-season rows. Default `false` — every title today, movies included (only ever meaningful for `media_type: 'tv'`) |
| `last_synced_at` | integer | |

Titles that vanish upstream (deleted outside this app) are marked
`last_synced_at` stale and excluded from usage — not deleted, so the audit log's
foreign references stay resolvable.

> **Per-season rows (`P4-1`).** A TV series can be split into per-season
> rows, keyed `series:{sonarrId}:s{n}`, coexisting alongside the
> pre-existing whole-series `series:{sonarrId}` row — which is never
> deleted once split, only excluded from new attribution and fleet
> distinct-byte totals (a later wave's rule, not enforced by
> `split_into_seasons` alone). The flag gates this: `false` (the default,
> and every title as of Wave 1) means library sync behaves exactly as
> before. Once an operator flips it `true` for one series (no trigger
> exists yet — that's `P4-1` Wave 3), the next sync additionally upserts
> one season row per season that has at least one episode file, sized from
> `GET /api/v3/episodefile?seriesId={id}`'s real per-file `size` (summed
> per `seasonNumber`, verified against a live Sonarr instance) —
> not derived from the whole-series total. Sonarr gives no per-season
> `path`, so a season row reuses the parent series' on-disk `path`
> unchanged rather than a fabricated subfolder; its title is synthesized as
> `"{series title} — Season {n}"`. See `wiki/Backlog.md` P4-1 for the
> staged wave plan (Wave 1 ships schema + library sync only; Waves 2–5 —
> playback, attribution, deletion, UI — are not built yet).

> **4K caveat, inherited.** Both Radarr *server slots in Seerr* point at the
> same physical Radarr (`radarr:7878`), differing only by `is4k`; same for
> Sonarr. So a 4K and a non-4K request resolve to **one** physical title, and
> attribution must key on the physical `(arr host, arr_id)` pair, never on the
> Seerr server slot. This applies to any deployment running a single Radarr/
> Sonarr instance behind Seerr's separate 4K/non-4K server slots.
>
> Consequence confirmed during P1-5: library sync only ever writes `radarr` /
> `sonarr`. Don't write code that branches on the `-4k` values expecting them to
> appear.

---

## `claim`

The heart of it: who is responsible for which bytes. One row per
(title, member) pair.

| Column | Type | Notes |
|---|---|---|
| `id` | integer PK | |
| `title_id` | text → `title` | |
| `sso_username` | text → `member` | |
| `seerr_request_id` | integer null | The request that created it; null for operator-assigned |
| `charged_bytes` | integer | The title's **full** `size_bytes` at last reconcile (`D-3` — claims are not divided) |
| `active` | integer (bool) | |
| `created_at` | integer | |
| `released_at` | integer null | Set when a member releases their claim |
| `released_by` | text null | |

Indexes on `(sso_username, active)` and `(title_id, active)`.

A member's usage is `SELECT SUM(charged_bytes) FROM claim WHERE sso_username = ?
AND active = 1`. Kept materialised rather than computed on read so the member
UI, admin dashboard, and enforcement decision all quote the *same* number from
the *same* snapshot — three views disagreeing about someone's usage is the
fastest way to lose trust in the whole thing.

**Per-member usage overlaps and MUST NOT be summed** to get a fleet total —
under `D-3` two claimants on one title are each charged its full size. Fleet
totals go over distinct `title_id` (`FR-ACCT-3`).

---

## `playback`

| Column | Type | Notes |
|---|---|---|
| `title_id` | text → `title` | Part of PK |
| `jellyfin_user_id` | text | Part of PK; normalised |
| `play_count` | integer | |
| `played` | integer (bool) | Jellyfin's `Played` flag — finished, as opposed to merely started |
| `position_ticks` | integer | Jellyfin's `PlaybackPositionTicks`. `> 0` with `played = 0` means **unfinished** — the signal `FR-DEL-4`'s `in_progress` guard turns on |
| `episodes_played` / `episodes_total` | integer null | TV only, so "watched 5 of 10" is representable |
| `last_played_at` | integer null | |
| `last_synced_at` | integer | |

Plus a derived, denormalised convenience on `title`: `watched_by_anyone`,
`last_played_any_at`. TV counts as played if **any** episode has been played
(`FR-ACCT-6`), matching the reference watch-history computation this was validated against.

> **Season-scoped watched state (`P4-1` Wave 2, shipped 2026-08-25).** A
> season `title` row (`series:{sonarrId}:s{n}`, Wave 1) gets its own
> `playback` rows and its own derived `watched_by_anyone`/
> `last_played_any_at`, computed with the **exact same** "any episode played"
> rule the whole-series row already used — one level down. Mechanically,
> `src/lib/playback/sync.ts` buckets Jellyfin episodes by
> `(seriesItemId, seasonNumber)` in addition to its existing whole-series
> bucket (`seasonNumber` comes from Jellyfin's `ParentIndexNumber`, already
> present by default on both the REST and SQLite paths —
> verified against a live Jellyfin instance). For a series with
> `title.split_into_seasons = true`, every season with at least one episode
> in Jellyfin this run gets its own `writeTitlePlayback` call, **in addition
> to** (never instead of) the whole-series row's existing all-episodes
> write — the parent row keeps its own aggregate for as long as it's synced,
> matching Wave 1's "frozen but not removed" design. An episode with no
> season number (Jellyfin recorded no `ParentIndexNumber`, e.g. certain
> specials) is excluded from every season bucket but still counted in the
> whole-series bucket, exactly as before. For an unsplit series (every
> series in production as of this wave), this is a no-op: zero extra writes,
> byte-identical output to before Wave 2. This answers
> [[Feature-03-Usage-Accounting]] §"Open questions"'s "should partially-
> watched count as watched?" note for playback state; per-season **byte**
> attribution (routing claims to season rows) is still `P4-1` Wave 3, not
> this wave.

---

## `request_decision`

One row per enforcement verdict. Distinct from `audit` because it is also the
idempotency key — the poller must not re-decide something the webhook already
handled.

| Column | Type | Notes |
|---|---|---|
| `seerr_request_id` | integer PK | |
| `sso_username` | text | |
| `decision` | text | `approve` / `hold` / `decline` / `skip` — see `D-4a`. `hold` is the normal over-quota outcome; `decline` only via operator action or hold age-out |
| `reason` | text | Machine-readable, and always the **true** reason — never overwritten to signal that enforcement was off. Verdict reasons: `under_quota`, `over_quota`, `operator_exempt`, `hold_expired`. Skip reasons, kept distinct because the attention panel must respond differently to each: `stale_snapshot`, `unknown_member`, `member_not_matched`, `quota_unconfigured`, `usage_unavailable` |
| `enforced` | integer (bool) | `false` when `enforcement_enabled` was off at decision time — a shadow verdict, no Seerr call made (`FR-ENF-5`) |
| `usage_bytes` | integer **null** | Snapshot of the inputs, so a past verdict stays explainable. Null on a `usage_unavailable` skip |
| `quota_bytes` | integer **null** | Null on a `quota_unconfigured` skip — writing `0` would mean *unlimited* (`FR-POL-2a`) |
| `source` | text | `webhook` / `poller` / `manual`. **Deliberately a different vocabulary from `audit.source`** (`ui`/`webhook`/`poller`/`cron`/`cli`) — this records how the *decision* was triggered, the audit column records how the *action* reached the system. An operator's `manual` decision maps to audit `ui` |
| `seerr_status` | integer null | HTTP status Seerr returned. Null for `hold`/`skip` — neither makes a Seerr call |
| `held_since` | integer null | When the hold started, for `HOLD_MAX_DAYS` (`FR-ENF-12`) |
| `notified_at` | integer null | When the member was told about this decision (`FR-ENF-15`) |
| `decided_at` | integer | |

---

## `deletion`

| Column | Type | Notes |
|---|---|---|
| `id` | integer PK | |
| `sso_username` | text | Who acted — and, for a scheduled row, who may cancel it (`FR-DEL-24`) |
| `title_id` | text → `title` | |
| `mode` | text | `delete_files` / `release_claim` (`D-6`) |
| `state` | text | `requested` / `scheduled` / `executing` / `done` / `failed` / `blocked` / `cancelled` |
| `bytes_claimed` | integer | Their share at the time |
| `bytes_freed` | integer null | Actual, post-execution |
| `arr_call` | text null | The exact URL+method issued |
| `arr_status` | integer null | |
| `error` | text null | |
| `requested_at` | integer | When the human confirmed |
| `scheduled_for` | integer null | When the sweeper may execute (`requested_at + DELETE_GRACE_PERIOD`). Null for rows that were never scheduled |
| `cancelled_at` | integer null | |
| `cancelled_by` | text null | An `sso_username`, or `system` when an execution-time guard cancelled it (`FR-DEL-26`) |
| `cancel_reason` | text null | Short token: `owner_cancelled`, `operator_cancelled`, `downgraded_to_release`, `guard_blocked_at_execution:<reason>` |
| `executed_at` | integer null | |

Indexes: `(state, scheduled_for)` for the sweeper's only query, and
`(sso_username, state)` for the per-member pending-bytes lookup on the
dashboard's hot path.

### The lifecycle (`FR-DEL-22` … `FR-DEL-28`)

A member-initiated **file** deletion now starts at `scheduled`, not
`executing`:

```
confirm ──► scheduled ──┬─► executing ──┬─► done
                        │               └─► failed
                        └─► cancelled
                              ▲
      owner or operator cancels (FR-DEL-24), OR the sweeper's
      fresh re-check refuses it (FR-DEL-26)
```

`release_claim` rows never enter `scheduled` — a release destroys nothing, so
it still completes inline and lands straight in `done` (`FR-DEL-23`).

Both the `scheduled → executing` and `scheduled → cancelled` transitions are
conditional `UPDATE`s guarded on the row still being `scheduled`. That is the
concurrency control, not decoration: a member clicking Cancel at the moment the
sweeper picks the row up must produce exactly one winner, and a deletion must
never be attempted twice (AGENTS.md rule 11).

**Pending bytes are credited to the member immediately** (`FR-DEL-27`).
Effective usage is `SUM(active claims) − SUM(bytes_claimed WHERE state =
'scheduled')`. The `claim` rows are deliberately untouched while a deletion is
pending — the files are still on disk and still attributed — so the member's
title list stays honest and only the headline figure moves.

A **partial batch failure is normal** and must be representable: deleting six
titles where the fourth 500s leaves three `done`, one `failed`, two
`requested`. The UI reports per-title outcomes, never a single "success".

---

## `sync_run`

| Column | Type | Notes |
|---|---|---|
| `id` | integer PK | |
| `started_at` / `finished_at` | integer | |
| `steps` | text (JSON) | Per-step `{ok, count, ms, error}` for the six reconciler steps |
| `ok` | integer (bool) | |

Drives the "data as of …" stamp every screen shows, and the staleness guard
that suspends enforcement (`STALE_SNAPSHOT_MAX_AGE`).

---

## `audit`

**Append-only.** No `UPDATE`, no `DELETE`, no retention job. See
[[Feature-08-Audit-Log]] for the full action vocabulary and the guarantees.

| Column | Type | Notes |
|---|---|---|
| `id` | integer PK | |
| `ts` | integer | Unix ms |
| `actor` | text | `sso_username`, or `system` for reconciler/webhook actions |
| `actor_role` | text | `member` / `operator` / `system` |
| `on_behalf_of` | text null | Set when an operator acts on a member's data |
| `action` | text | See the vocabulary in [[Feature-08-Audit-Log]] |
| `target_type` | text null | `member` / `title` / `request` / `setting` / `route` — `route` exists for `access.denied`, whose target is an attempted URL rather than a domain object |
| `target_id` | text null | |
| `before` | text null (JSON) | |
| `after` | text null (JSON) | |
| `outcome` | text | `ok` / `denied` / `error` |
| `detail` | text null (JSON) | Reason, upstream response, error message |
| `source` | text | `ui` / `webhook` / `poller` / `cron` / `cli` |
| `correlation_id` | text | Groups the rows of one multi-step operation |

Indexes on `ts`, `actor`, `action`, `target_id`, `correlation_id`.

Two properties worth stating explicitly because they are easy to lose:

1. **Denials are logged.** A member trying to delete something they don't own
   produces an `outcome = denied` row. An audit log that only records successes
   cannot answer "did anyone try?".
2. **Every row is also written to stdout** as one JSON object. If the DB write
   is what failed, the event still exists in `docker logs`.
