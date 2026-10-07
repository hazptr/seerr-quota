# Feature 3 — Usage Accounting

## Summary

Turn "N requests" into "X bytes this person is responsible for", by joining
Seerr's requests against Radarr/Sonarr `sizeOnDisk` and Jellyfin playback state.
This is the number everything else in the app depends on, so it has to be
defensible: the operator must be able to point at any figure and trace it to
real files on disk.

The join logic this app implements was prototyped and validated against a
real production library before being built into the app proper — this
feature is largely "make that continuous, and make attribution explicit."

## User stories

- As a **member**, I want to see exactly which titles make up my usage and how
  big each one is, so that "you're using 340 GB" is a fact I can act on rather
  than an accusation.
- As a **member**, I want to see which of my titles nobody has ever watched, so
  I know what to delete first.
- As the **operator**, I want per-user totals that sum to the real attributed
  library size, so the dashboard isn't quietly double-counting.

## The model

```
 Seerr request ──► media (tmdbId / tvdbId) ──► Radarr movie / Sonarr series
      │                                              │
      │                                        sizeOnDisk (bytes)
      │                                              │
      └──► requestedById ──► member          ┌───────┴────────┐
                  │                          │  charged in     │
                  └──────────────────────────►  FULL to every  │ = claim.charged_bytes
                                             │  requester (D-3)│
                                             └─────────────────┘
 Jellyfin BaseItems/UserData ──► played? last played? ──► shown alongside,
                                                          never affects the charge
```

**Usage = `SUM(claim.charged_bytes) WHERE active = 1`.** Playback state is
displayed and used for delete guard-rails, but never changes what someone is
charged — "you watched it" doesn't make it free, it just makes it a worse
deletion candidate.

## Functional requirements

- **FR-ACCT-1** — Usage MUST be computed from actual `sizeOnDisk` reported by
  Radarr/Sonarr. Requests that are pending, declined, or not yet available MUST
  contribute **zero** bytes (`D-2`). Gate on the **request** status
  (`MediaRequestStatus ∈ {APPROVED, COMPLETED}`), **not** the media-level
  status: a real deployment found cases where Seerr reports `DELETED`/
  `UNKNOWN` on the media while Radarr still holds real bytes on disk for it.
  The bytes are what is real; Seerr's media status is a derived field that
  drifts.
- **FR-ACCT-2** — Every active claim on a title MUST be charged the title's
  **full** `size_bytes` (`D-3`). Claims are not divided, and a title's byte count
  MUST NOT change because the number of claimants changed.
- **FR-ACCT-3** — Because per-member usage overlaps, **fleet totals MUST be
  computed over distinct titles**, never by summing per-member usage. Any UI that
  shows a per-member column alongside a fleet total MUST label the former as
  overlapping, and MUST NOT present a column sum that silently double-counts.
  The invariant to assert in tests: `fleet_total == SUM(size_bytes)` over titles
  with ≥1 active claim, and `charged_bytes <= title.size_bytes` for every active
  claim.
- **FR-ACCT-4** — Movies MUST join on `tmdbId`; TV MUST join on `tvdbId`.
  A request whose media cannot be resolved to a library item MUST be recorded as
  **unresolved** with a reason, MUST contribute zero bytes, and MUST be visible
  to the operator — silently dropping it would understate someone's usage.
  Unresolved requests get **no table of their own**: they are cheap to recompute
  and are recorded per run in `sync_run.steps` (JSON), which the admin
  dashboard's attention panel reads (`FR-ADM-4`). The same applies to a request
  whose requester matches no member.
- **FR-ACCT-5** — Attribution MUST key on the physical `(arr host, arr_id)`
  pair, never on the Seerr server slot, because the 4K and non-4K Radarr/Sonarr
  entries point at the same instance and would otherwise double-count.
- **FR-ACCT-6** — Playback state MUST be synced per (title, Jellyfin user),
  capturing **`Played`** and **`PlaybackPositionTicks`** as well as play count
  and last-played date — an unfinished resume position is what distinguishes
  "someone is partway through this" from "someone watched it once", and the
  deletion guards in `FR-DEL-4` depend on the difference. For a TV series, also
  capture episodes-played vs episodes-total, so "watched 5 of 10" is
  representable. A series counts as *played* if any episode has been played, and
  as *in progress* if some but not all have been.
- **FR-ACCT-6a** — **"Played" is not a label.** `FR-ACCT-6`'s any-episode rule
  is correct for the deletion guards (`recently_played` has to fail safe on
  "somebody touched this recently"), but rendering that boolean to a person as
  *watched* is wrong: it says a 89-episode series somebody sampled once has
  been watched. Every member- or operator-facing surface MUST therefore show a
  **three-state** value derived from the episode counts `FR-ACCT-6` already
  requires — `unwatched` / `N/M eps` / `watched` — and the delete flow's
  per-title warning MUST say how much, not merely whether.

  This was a real defect, reported by a member as "I only watched one episode
  of a show and it's showing watched", and fixed the same day. Note the spec
  was already right — `FR-ACCT-6` demanded episodes-played vs episodes-total
  *"so 'watched 5 of 10' is representable"*, and `playback` has stored both
  since `P1-4`. Nothing surfaced them, so the UI fell back to the boolean.
  Worth remembering as a shape: the data being captured is not the same as the data
  being *used*, and only the second one is visible to anyone.

  `title.watched_by_anyone` keeps its meaning and stays the guards' input;
  `deriveWatchState` (`src/lib/playback/watchState.ts`) is display-only.

- **FR-ACCT-8** — **A requester MUST NOT be charged for bytes that were
  already on disk before they asked.** `D-3` still applies in full: a title is
  never DIVIDED between co-claimants, and everyone who caused it pays the whole
  thing. What this adds is that "what they asked for" cannot include what was
  already there.

  A claim's charge is therefore the sum of the title's files whose acquisition
  date is at or after that member's **earliest** request for it (earliest,
  because someone who asked in 2024 and again in 2026 caused everything from
  2024 onward). With no per-file data the charge falls back to the full size —
  the pre-`FR-ACCT-8` behaviour, and the direction that never under-charges.

  **Why it was needed:** on a real deployment, a member requested a later
  season of a series whose earlier seasons had already been on disk for
  years, and was charged for all of that pre-existing library — for a season
  that had not downloaded a single file of its own. Attribution is at series
  granularity (the `P4-1` gap), so one season request adopts the entire show.
  A fleet-wide sweep of active claims found more than one affected title,
  some with hundreds of GB of pre-existing bytes mixed into otherwise-genuine
  new charges — which is why the rule has to be **per file** rather than a
  per-title "did this predate the request?" flag: a per-title flag would also
  erase the genuinely-caused bytes on a title that's a mix of old and new.

  **Scope, deliberately narrow:**
  - **TV only.** `title.added_at` is the *arr's* add date, not the file's — a
    movie can sit in Radarr monitored-but-missing for years and download only
    when somebody requests it, so that date cannot answer the question for
    movies. Seerr also marks an already-present movie Available rather than
    letting it be re-requested, and the sweep found zero affected movies.
  - **Fetched only where it can change the answer.** A claim can contain
    pre-existing bytes only if the title was on disk before the request, so
    `added_at < request` is a complete and cheap pre-filter (a file cannot
    predate its series being added). Normal runs make zero extra upstream
    calls; the alternative was ~97 Sonarr calls every reconcile.
  - **Known limitation:** a quality UPGRADE rewrites a file's `dateAdded`, so
    an upgrade applied after someone's request looks caused-by-them.
    Distinguishing an upgrade from a first acquisition needs per-episode
    history this app doesn't keep. It errs toward charging, which is the safe
    side.

- **FR-ACCT-7** — A member's usage MUST only ever change as a result of their
  own requests, their own deletions, or a title's real size changing on disk.
  It MUST NOT change because another member acted (`D-3` — this is guaranteed by
  full charging; the even-split model that made this possible was reversed).
- **FR-ACCT-8** — Every figure shown MUST carry the timestamp of the snapshot it
  came from, and MUST be visibly marked stale when older than
  `STALE_SNAPSHOT_MAX_AGE`.
- **FR-ACCT-9** — Sizes MUST be displayed in decimal units (GB = 10⁹ bytes),
  matching how Radarr/Sonarr report and how the existing analysis reports,
  and MUST be labelled. Mixing GiB and GB across screens is a support burden
  nobody needs.
- **FR-ACCT-10** — The reconciler MUST tolerate a partial upstream failure: if
  Sonarr is unreachable, movie attribution MUST still update, TV data MUST go
  stale rather than zero, and no claim may be silently dropped because its
  source was briefly unavailable.

## Interactions

**Radarr** (`✓ verified` against a live instance):
```
GET /api/v3/movie      → [{ id, tmdbId, title, year, hasFile, sizeOnDisk,
                            added, path, ... }]
```

**Sonarr** (`✓ verified`):
```
GET /api/v3/series     → [{ id, tvdbId, title, year, path, added,
                            statistics: { sizeOnDisk, episodeFileCount, ... } }]
```

Both are reachable on the proxy network at `radarr:7878` / `sonarr:8989`. Note their
API ports are **not** published to the host — the existing script works around
this with `docker exec ... curl`, which this app doesn't need since it lives on
the same network. API keys come from each `config.xml` into this stack's `.env`.

**Seerr** (`✓ verified` live — P0-1 §A):
```
GET /api/v1/request?take=100&skip=N&sort=added
   params: take, skip, filter, sort(added|modified), sortDirection,
           requestedBy, mediaType
   → { pageInfo, results: [{ id, status, type, is4k, isAutoRequest, createdAt,
                             requestedBy: { id, jellyfinUsername, jellyfinUserId },
                             media: { tmdbId, tvdbId, status, jellyfinMediaId },
                             seasons: [{ seasonNumber, status }] }] }
```

> **Use these status enums — NOT the OpenAPI spec bundled in the image, which is
> stale.** Ground truth is `/app/dist/constants/media.js`, confirmed against all
> 92 live requests:
>
> ```
> MediaRequestStatus: 1=PENDING 2=APPROVED 3=DECLINED 4=FAILED 5=COMPLETED
> MediaStatus:        1=UNKNOWN 2=PENDING 3=PROCESSING 4=PARTIALLY_AVAILABLE
>                     5=AVAILABLE 6=BLOCKLISTED 7=DELETED
> ```
>
> The bundled spec omits `FAILED`/`COMPLETED` and claims `6=DELETED`. Two live
> consequences if you code off it: **66 of 92 real requests are status 5**
> (`COMPLETED`), so a switch written off the old spec falls through to its
> default on the majority of rows; and the two genuinely deleted media rows in
> prod are status **7**, so a `status == 6` "is deleted" check is actually
> testing `BLOCKLISTED` — which would break `FR-ACCT-1` on exactly the
> deleted-then-relisted edge case this page calls out below.

> `media.jellyfinMediaId` is **nullable and was null on every row checked**,
> including available ones — do not assume it is populated once a title is
> `AVAILABLE`. Join playback on `tmdbId`/`tvdbId` via the library, not on this
> field. `requestedBy.jellyfinUserId` **is** reliably present and is the better
> key for the Jellyfin playback join (`FR-ACCT-6`) since usernames can change.

**Jellyfin** — `✓ REST verified live and in production` (10.11.11), auth via
`X-Emby-Token`. **Two findings that contradict the obvious reading of the API**,
either of which would have silently lost data:

- **`isPlayed=true` drops unfinished plays.** An item with `PlayCount > 0,
  Played: false` is excluded — on a real deployment that hid a double-digit
  number of movies for a single user, which is exactly the in-progress state
  `FR-DEL-4`'s guard depends on. Query without the filter and use
  `PlayCount > 0`.
- **Series-level `PlayCount` is always 0.** Jellyfin aggregates only
  `UnplayedItemCount`/`Played` (meaning *all* episodes done) at series level —
  the opposite of `FR-ACCT-6`. Fetch `Movie,Episode` per user, never `Series`.
- `ProviderIds` needs `fields=ProviderIds` explicitly; absent otherwise.

Cross-checked against the SQLite source on a real deployment: 100% agreement
across the whole library, and identical answers on every historically
fulfilled request checked.

Historical note — the DB fallback and why it was abandoned: REST needs an API
key that does not exist; the read-only DB fallback **fails in the container**
with `attempt to write a readonly database`. SQLite cannot open a WAL-mode
database read-only — it must write the `-shm` file — and Jellyfin holds
`jellyfin.db` in WAL mode continuously. The P1-4 spike validated the read-only fallback against every item in the reference library because
it ran on the *host* as the user owning the directory, with write access to
it; bind-mounted `:ro`, the same code cannot.

Options, least-bad first: **issue a Jellyfin API key** and move to REST (`P3-7`,
operator decision #7 — this is now a fix, not an optimisation); or copy the DB
into the app's own writable volume before reading — a `docker pause` +
raw-copy pattern, the same shape a backup job might use for any other
service's live database. Mounting Jellyfin's live datadir read-write from
another container is **not** an option.

Original spike detail follows (still accurate about the join logic, which
reproduced the reference exactly):
`GET /System/Info/Public` answers unauthenticated, but `GET /Users` and
`GET /Items` both **401**: they need an API key, and no dedicated key for this
app exists. Creating one is a production change requiring operator sign-off, so
the spike stopped rather than provisioning credentials, and building against an
unexercised response shape would repeat the exact mistake that Seerr's stale
OpenAPI spec already caused here.

So playback uses the **documented read-only `jellyfin.db` fallback**, behind a
narrow `JellyfinPlaybackSource` interface so a REST implementation drops in
without touching call sites. Opened `{readonly: true, fileMustExist: true}`, and
the read-only guarantee is asserted by a test that a write attempt throws.
It joins via Jellyfin's `BaseItemProviders` table on `Tmdb`/`Tvdb` provider ids
rather than Seerr's `jellyfinMediaId`, which is unreliable (see the note above).

**Validated against an independent reference implementation on a real
library** — zero disagreements across every historically fulfilled request
checked. One live quirk found and handled: some `UserData` rows carry
duplicate `CustomDataKey` entries with identical `PlayCount` /
`LastPlayedDate`, collapsed with `MAX` rather than `SUM` (summing would
inflate play counts).

The REST shape, for whenever a key exists ([[Backlog]] `P3-7`):
```
GET /Users                                        → user ids
GET /Items?userId=<id>&isPlayed=true&recursive=true&includeItemTypes=Movie,Series
   → played items + UserData.LastPlayedDate
```
If the REST path proves impractical, the documented fallback is a read-only
open of Jellyfin's own `jellyfin.db` (`BaseItems` + `UserData`, GUIDs
normalised by stripping dashes and lowercasing) — but that is a fallback, and
must be recorded as one under the "read the API, not the DB" rule in
[[Architecture]].

## Acceptance criteria

- **Given** a movie of 12.0 GB requested only by `alice`, **when** a reconcile
  runs, **then** `alice` is charged 12.0 GB and the title has exactly one active
  claim.
- **Given** the same movie also requested by `bob`, **when** a reconcile runs,
  **then** **each is charged the full 12.0 GB** (`D-3`), and the fleet
  distinct-title total counts the movie **once**.
- **Given** `bob` releases their claim, **when** the next reconcile runs,
  **then** `alice` is still charged 12.0 GB — **unchanged**. No other member's
  usage may move as a result of one member's action (`FR-ACCT-7`).
- **Given** a request for a movie Radarr has not downloaded (`hasFile = false`),
  **when** a reconcile runs, **then** it contributes 0 bytes and is listed as
  pending, not as usage.
- **Given** a request whose `tmdbId` matches nothing in Radarr, **when** a
  reconcile runs, **then** it is recorded unresolved with a reason and shown to
  the operator.
- **Given** Sonarr returns 503 mid-reconcile, **when** the run finishes, **then**
  movie usage is current, TV usage is unchanged and marked stale, and no claim
  was zeroed.
- **Given** the fleet, **when** the distinct-title total is computed, **then**
  it equals `SUM(size_bytes)` over titles with ≥1 active claim — and is **less
  than** the sum of the per-member column whenever any title is co-requested.
  Summing the per-member column MUST NOT be used as a fleet total (`FR-ACCT-3`).
- **Given** a reconcile snapshot, **when** attribution runs, **then** it
  reproduces the full-charge total per member exactly, and the fleet
  distinct-title total equals the sum of distinct titles' `size_bytes`. Any
  gap between the sum of the per-member column and the fleet total is exactly
  the co-requested titles — e.g. a single movie charged in full to two
  members accounts for the whole gap.

## Edge cases & failure modes

- **A title requested, deleted outside this app, then re-requested** — the
  library row reappears with a new `arr_id`. Claims key on `(arr host, arr_id)`,
  so this is correctly a new title with a new claim; the old one goes stale and
  its claims deactivate. Usage drops then rises. Correct, but worth a note in
  the UI's change log so it doesn't read as a bug.
- **Multi-season TV grabbed as one pack** — Sonarr reports one `sizeOnDisk` for
  the whole series regardless of how many separate season requests exist. The
  series is one title with one size; multiple season requests by the same member
  are **one** claim, not several. Two members requesting different seasons of
  the same show still split the whole series evenly — imperfect, and accepted:
  per-season byte attribution would need `episodeFile`-level accounting, which
  is [[Backlog]] `P4-1`. Any multi-season pack on disk (a season-pack grab
  covering several seasons of one series in one download) is a good example
  to test against.
- **Anime / multi-instance routing** — the anime movie profile routes to a
  different root folder but the same Radarr, so it falls out naturally under
  FR-ACCT-5. No special case needed.
- **A Seerr-internal service account or other non-member requester** —
  attributed to a `not_entitled` member row so the bytes are accounted for
  somewhere, but excluded from fleet totals and never enforced against.
- **Jellyfin item deleted but Radarr file present** — playback data goes null,
  size stays. Never let missing playback state zero a size.

## Open questions

- **Should partially-watched count as watched?** v1: any playback at all counts
  as "watched by someone" and blocks nothing except via
  `DELETE_RECENT_PLAY_DAYS`. Modelling "watched 2 of 10 episodes" properly needs
  per-episode progress and a definition of "done", flagged early on as
  needing thought before building. **Partially answered
  by `P4-1` Wave 2 (shipped 2026-08-25):** once a series is split into season
  `title` rows, each season gets its own "any episode in THIS season played"
  watched state (`wiki/Data-Model.md` §playback), so "watched season 1, not
  season 2" is now representable at the season level — see that doc's Wave 2
  note for the mechanism. Per-episode ("watched 2 of 10 episodes **within** a
  season") granularity, and the byte-attribution half of per-season tracking,
  remain deferred to later `P4-1` waves.
- **Should the operator's own usage count toward fleet totals?** Proposal:
  yes, shown and counted, but never enforced (`FR-ENF-6`). Operators request
  things too, and a meaningful share of any requester's library typically
  goes unwatched — hiding the operator's own number would make the dashboard
  flattering rather than useful.
