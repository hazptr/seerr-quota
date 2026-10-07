/**
 * The pure attribution core (AGENTS.md rule 9: "pure core, impure shell" —
 * this is the one this rule calls out by name, `D-3`). No I/O, no
 * `Date.now()`, no DB — every input is plain data, so every scenario in
 * `test/attribution-compute.test.ts` is hand-calculated. The impure shell
 * that feeds this from the DB/Seerr/member table lives in `./sync.ts` /
 * `./resolveMembers.ts`.
 *
 * ## The charge rule (`FR-ACCT-1`, `FR-ACCT-2`, `D-3`)
 *
 * A request becomes an active claim only if BOTH:
 *   (a) its own Seerr `MediaRequestStatus` is `APPROVED` or `COMPLETED` —
 *       never `PENDING`, `DECLINED`, or `FAILED` (`FR-ACCT-1`: "pending,
 *       declined, or not yet available MUST contribute zero"), AND
 *   (b) the title it resolves to currently has `size_bytes > 0` — i.e.
 *       Radarr/Sonarr actually has a file on disk right now (`hasFile:false`
 *       / `sizeOnDisk:0` is "not yet available").
 *
 * Deliberately NOT gated on Seerr's own per-request `media.status` field
 * beyond that. `wiki/Feature-03-Usage-Accounting.md` and
 * `src/lib/seerr/types.ts` both document that field as unreliable — and a
 * real-world snapshot proves it concretely: two requests carried Seerr media
 * statuses of `DELETED`(7) and `UNKNOWN`(1) respectively, while Radarr's
 * CURRENT `hasFile` for both was `true` with real bytes on disk. `title.size_bytes`, freshly synced from
 * Radarr/Sonarr, is ground truth per `D-2` ("usage is measured from actual
 * bytes on disk, never estimated") — exactly what
 * `analysis/attribution.py`'s reference "full charge" model uses (it never
 * reads media/request status at all, only the arr library's actual
 * `hasFile`/`sizeOnDisk`). Trusting Seerr's cached status here instead would
 * silently zero those two members' real, on-disk usage — precisely the
 * "your usage dropped to 0" failure the project's design warns lets an
 * over-quota member through the enforcement gate.
 *
 * A resolved-but-not-yet-chargeable request (declined, pending, or the
 * title has no file yet) produces NO output at all here — not a claim, not
 * an "unresolved" entry. `wiki/Feature-03-Usage-Accounting.md`'s acceptance
 * criteria is explicit: it "contributes 0 bytes and is listed as pending,
 * not as usage." Listing pending requests is a request-listing/UI concern
 * (reads Seerr's request status directly), not this module's job.
 *
 * ## Charging (`FR-ACCT-2`/`D-3`)
 *
 * Every requester of an available title is charged its FULL `size_bytes` —
 * no shares, no division, no re-splits. A member with several chargeable
 * requests for the SAME title (e.g. two season-request clicks on one
 * series, `wiki/Feature-03-Usage-Accounting.md`'s "multi-season TV grabbed
 * as one pack" edge case) collapses to ONE claim, attributed to their
 * earliest chargeable request (`createdAt`) for a stable, deterministic
 * `seerrRequestId` regardless of input ordering.
 *
 * ## Unresolved requests (`FR-ACCT-4`)
 *
 * A request whose join key (tmdbId for movies, tvdbId for tv) is either
 * missing or matches no CURRENTLY-known `title` row is recorded in
 * `AttributionResult.unresolved`, never silently dropped, and never
 * contributes a claim.
 *
 * ## Physical keying (`FR-ACCT-5`)
 *
 * The join key is the physical `(arr host, arr_id)` pair via `title.id` —
 * satisfied structurally: a movie/series's tmdbId/tvdbId always resolves to
 * the SAME physical `title` row regardless of which Seerr server slot (4K
 * or not) the request came in on, because this deployment has exactly one
 * Radarr and one Sonarr (`src/lib/library/sync.ts` only ever writes
 * `arr_instance: 'radarr' | 'sonarr'`, never the `-4k` variants — see that
 * file's header comment). `indexTitlesByJoinKey` below additionally
 * resolves a same-tmdbId/tvdbId COLLISION between two `title` rows (the
 * "deleted outside this app, then re-requested" case) by preferring the
 * freshest-synced one.
 *
 * ## Season-aware routing (`P4-1` Wave 3)
 *
 * A tv request still joins to its WHOLE-SERIES `title` row exactly as
 * above. Only once that row's `splitIntoSeasons` is `true` (an operator's
 * explicit, one-way, per-series action — `./sync.ts`'s `splitSeriesClaims`,
 * never automatic) does `computeAttribution` route each of the request's
 * `seasons[]` to its own `series:{arrId}:s{n}` row instead of collapsing to
 * one whole-series claim — gated by that SEASON's own `status`, per
 * Sonarr's API ("no special sentinel for
 * 'all seasons' — a whole-series request simply enumerates every season
 * number individually", each with its own independently-tracked
 * `MediaRequestStatus`). Before any series is split — every series in
 * production as of this wave — `splitIntoSeasons` is always falsy, so this
 * is a strict no-op: byte-for-byte identical output to before Wave 3, the
 * hard non-regression requirement this wave's tests pin explicitly.
 */
import { MediaRequestStatus } from '../seerr/types';
import type {
  AttributionClaim,
  AttributionMediaType,
  AttributionRequestInput,
  AttributionResult,
  AttributionTitleInput,
  ClaimInvariantViolation,
  UnresolvedRequest,
} from './types';

/** Request statuses that can EVER create a charge (`FR-ACCT-1`). `PENDING`/`DECLINED`/`FAILED` never do. */
const CHARGEABLE_REQUEST_STATUSES: ReadonlySet<number> = new Set([MediaRequestStatus.APPROVED, MediaRequestStatus.COMPLETED]);

function titleJoinKey(mediaType: AttributionMediaType, tmdbId: number | null, tvdbId: number | null): string | null {
  if (mediaType === 'movie') return tmdbId === null ? null : `movie:${tmdbId}`;
  return tvdbId === null ? null : `tv:${tvdbId}`;
}

/**
 * True for a P4-1 season title row (`series:{arrId}:s{n}`) as opposed to its
 * parent whole-series row (`series:{arrId}`) or a movie row (`movie:{arrId}`,
 * never matches — no `:s\d+` suffix is ever produced for a movie id).
 * Exported so `./sync.ts`'s impure shell (`splitSeriesClaims`) can reuse the
 * exact same predicate rather than a second, potentially-drifting copy — the
 * pure core is the natural single owner since `indexTitlesByJoinKey` below
 * needs it first. `src/lib/playback/sync.ts` keeps its OWN independent copy
 * (a different reconcile step's impure shell, a different reason — see that
 * file's header comment) rather than importing this one, matching this
 * codebase's established "small local copies across module-family
 * boundaries" convention.
 */
const SEASON_TITLE_ID_PATTERN = /:s\d+$/;
export function isSeasonTitleId(titleId: string): boolean {
  return SEASON_TITLE_ID_PATTERN.test(titleId);
}

/**
 * Indexes titles by their Seerr join key, preferring the freshest
 * (`lastSyncedAt`) title on a collision — see this file's header comment
 * ("Physical keying"). Season rows (`isSeasonTitleId`) are deliberately
 * EXCLUDED here (P4-1 Wave 3): `src/lib/library/sync.ts`'s
 * `upsertSeasonsForSplitSeries` copies the SAME `tvdbId` onto every season
 * row it creates, so once a series is split, its season rows would otherwise
 * collide with the whole-series row on this exact join key — corrupting the
 * "last-synced wins" tie-break with an arbitrary season/whole-series pick.
 * A season row is only ever reached deliberately, via its parent's
 * `splitIntoSeasons` flag + a derived id (`computeAttribution` below), never
 * via this index. Before any series is ever split (every series in
 * production as of this wave) there are zero season rows in `titles` at all,
 * so this filter is a no-op — part of why the non-regression requirement
 * holds trivially today.
 */
function indexTitlesByJoinKey(titles: AttributionTitleInput[]): Map<string, AttributionTitleInput> {
  const idx = new Map<string, AttributionTitleInput>();
  for (const t of titles) {
    if (isSeasonTitleId(t.id)) continue;
    const key = titleJoinKey(t.mediaType, t.tmdbId, t.tvdbId);
    if (key === null) continue;
    const existing = idx.get(key);
    if (!existing || t.lastSyncedAt > existing.lastSyncedAt) idx.set(key, t);
  }
  return idx;
}

/** `title.id -> title`, for looking up a title already resolved by a claim (e.g. for `chargedBytes`, or the fleet total / invariant check below). */
export function buildTitlesById(titles: AttributionTitleInput[]): Map<string, AttributionTitleInput> {
  const idx = new Map<string, AttributionTitleInput>();
  for (const t of titles) idx.set(t.id, t);
  return idx;
}

/**
 * `FR-ACCT-8` — the bytes a requester is answerable for.
 *
 * `D-3` charges every requester the FULL size of what they asked for, and that
 * stays true: nothing here divides a title between co-claimants. What this
 * adds is that "what they asked for" cannot include bytes that were already
 * sitting on the disk before they asked.
 *
 * The case that forced it: a member requested season 3 of a
 * series whose seasons 1-2 had already been on disk, and was charged the full
 * size of those two seasons — for a season that has not downloaded a single
 * file. Attribution is at series granularity (the `P4-1` gap), so one season
 * request adopts the whole show.
 *
 * `requestedAt` is the accumulator's EARLIEST request for this (title, member)
 * pair, which is the right cutoff: someone who asked for season 1 in 2024 and
 * season 3 in 2026 caused everything from 2024 onward.
 *
 * With no `files` data, this returns the full `sizeBytes` — identical to the
 * pre-`FR-ACCT-8` behaviour, and the direction that never under-charges.
 *
 * Known limitation, deliberately not solved here: a quality UPGRADE rewrites a
 * file's `dateAdded`, so an upgrade applied after someone's request makes
 * those bytes look caused-by-them. Distinguishing an upgrade from a first
 * acquisition needs per-episode history this app doesn't keep. It errs toward
 * charging, which is the safe side for quota integrity.
 */
export function chargeableBytes(title: AttributionTitleInput | undefined, requestedAt: number): number {
  if (!title) return 0;
  if (!title.files) return title.sizeBytes;
  let total = 0;
  for (const f of title.files) {
    if (f.addedAt >= requestedAt) total += f.sizeBytes;
  }
  // Never charge more than the title actually occupies — a defensive clamp
  // against a file list that disagrees with `sizeBytes` (mid-import, or a
  // stale read between the two calls).
  return Math.min(total, title.sizeBytes);
}

interface ClaimAccumulator {
  titleId: string;
  ssoUsername: string;
  seerrRequestId: number;
  createdAt: number;
}

/** The pure attribution core. See this file's header comment for the full rule set. */
export function computeAttribution(requests: AttributionRequestInput[], titles: AttributionTitleInput[]): AttributionResult {
  const titlesByKey = indexTitlesByJoinKey(titles);
  const titlesById = buildTitlesById(titles);
  const unresolved: UnresolvedRequest[] = [];
  // Keyed `${titleId}::${ssoUsername}` — the (title, member) pair `claim` is keyed on (wiki/Data-Model.md §claim: "One row per (title, member) pair").
  const accByPair = new Map<string, ClaimAccumulator>();

  for (const req of requests) {
    const key = titleJoinKey(req.mediaType, req.tmdbId, req.tvdbId);
    if (key === null) {
      unresolved.push({
        seerrRequestId: req.seerrRequestId,
        ssoUsername: req.ssoUsername,
        mediaType: req.mediaType,
        tmdbId: req.tmdbId,
        tvdbId: req.tvdbId,
        reason: 'missing_join_key',
      });
      continue;
    }

    const matchedTitle = titlesByKey.get(key);
    if (!matchedTitle) {
      unresolved.push({
        seerrRequestId: req.seerrRequestId,
        ssoUsername: req.ssoUsername,
        mediaType: req.mediaType,
        tmdbId: req.tmdbId,
        tvdbId: req.tvdbId,
        reason: 'no_matching_title',
      });
      continue;
    }

    // P4-1 Wave 3: once an operator has explicitly split this series
    // (Architecture decision, confirmed against Sonarr's API
    // §Q4), the whole-series row is frozen from new attribution — route
    // each of this request's seasons to its own `series:{arrId}:s{n}` row
    // instead, gated by THAT SEASON's own `status` (never the request's
    // top-level `requestStatus`, and never the whole-series row's aggregate
    // `sizeBytes` — Seerr tracks per-season approve/decline/complete
    // independently within one request). Unsplit series — every series in production as of this
    // wave — always has `matchedTitle.splitIntoSeasons` falsy, so this
    // branch never runs: byte-for-byte identical output to before this
    // wave, the hard non-regression requirement.
    if (req.mediaType === 'tv' && matchedTitle.splitIntoSeasons) {
      for (const season of req.seasons ?? []) {
        if (!CHARGEABLE_REQUEST_STATUSES.has(season.status)) continue; // FR-ACCT-1, one level down.
        const seasonTitleId = `${matchedTitle.id}:s${season.seasonNumber}`;
        const seasonTitle = titlesById.get(seasonTitleId);
        // No row for this season number yet (not synced, or genuinely no
        // files on disk — Wave 1 only ever upserts a season row that has
        // at least one episode file) — same "contributes 0, not
        // unresolved" treatment FR-ACCT-1 already gives an unavailable
        // whole-series title: the PARENT series resolved fine, this one
        // season just isn't chargeable yet.
        if (!seasonTitle || seasonTitle.sizeBytes <= 0) continue;

        const seasonPairKey = `${seasonTitleId}::${req.ssoUsername}`;
        const existingSeason = accByPair.get(seasonPairKey);
        if (!existingSeason || req.createdAt < existingSeason.createdAt) {
          accByPair.set(seasonPairKey, {
            titleId: seasonTitleId,
            ssoUsername: req.ssoUsername,
            seerrRequestId: req.seerrRequestId,
            createdAt: req.createdAt,
          });
        }
      }
      continue; // never ALSO produce a whole-series claim for a split series.
    }

    // Resolved, but not (yet) chargeable — FR-ACCT-1. See this file's header
    // comment: deliberately produces no output row at all here.
    if (!CHARGEABLE_REQUEST_STATUSES.has(req.requestStatus) || matchedTitle.sizeBytes <= 0) continue;

    const pairKey = `${matchedTitle.id}::${req.ssoUsername}`;
    const existing = accByPair.get(pairKey);
    if (!existing || req.createdAt < existing.createdAt) {
      accByPair.set(pairKey, {
        titleId: matchedTitle.id,
        ssoUsername: req.ssoUsername,
        seerrRequestId: req.seerrRequestId,
        createdAt: req.createdAt,
      });
    }
  }

  const claims: AttributionClaim[] = [...accByPair.values()].map((acc) => ({
    titleId: acc.titleId,
    ssoUsername: acc.ssoUsername,
    seerrRequestId: acc.seerrRequestId,
    // FR-ACCT-2/D-3: never DIVIDED between claimants. FR-ACCT-8: but limited
    // to the bytes this requester actually caused to exist.
    chargedBytes: chargeableBytes(titlesById.get(acc.titleId), acc.createdAt),
  }));

  return { claims, unresolved };
}

/**
 * `FR-ACCT-3`: fleet totals MUST be computed over DISTINCT titles, never by
 * summing per-member usage (which overlaps under full charging — `D-3`).
 * This is the first-class function that exists so no caller is tempted to
 * `SUM(claim.charged_bytes)` across members. Matches the invariant text
 * verbatim: `fleet_total == SUM(size_bytes)` over titles with >=1 active claim.
 */
export function computeFleetDistinctTitleTotal(
  claims: Pick<AttributionClaim, 'titleId'>[],
  titlesById: ReadonlyMap<string, AttributionTitleInput>,
): number {
  const seen = new Set<string>();
  let total = 0;
  for (const c of claims) {
    if (seen.has(c.titleId)) continue;
    seen.add(c.titleId);
    total += titlesById.get(c.titleId)?.sizeBytes ?? 0;
  }
  return total;
}

/** Per-member usage — `SUM(charged_bytes)` for that member's active claims (`wiki/Data-Model.md` §claim). Overlaps across members by design (`D-3`) — see `computeFleetDistinctTitleTotal` for the number that must NOT come from summing this map's values. */
export function computeMemberTotals(claims: AttributionClaim[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const c of claims) {
    totals.set(c.ssoUsername, (totals.get(c.ssoUsername) ?? 0) + c.chargedBytes);
  }
  return totals;
}

/**
 * `FR-ACCT-3`'s other invariant, as amended by `FR-ACCT-8`.
 *
 * It used to assert `charged_bytes == title.size_bytes` for every active
 * claim, which was correct while every claimant was charged the whole title.
 * `FR-ACCT-8` makes a charge legitimately SMALLER than the title when some of
 * its bytes predate the request, so equality is now the wrong test — and a
 * damaging one: the shell drops violating claims before persisting, so an
 * equality check silently DEACTIVATED exactly the claims `FR-ACCT-8` had just
 * corrected. (Observed before this was fixed: two different members' claims
 * on two different shows were both dropped even though each one had already
 * been correctly reduced by `FR-ACCT-8`.)
 *
 * The invariant that still holds, and the one worth guarding, is that a claim
 * may never be charged MORE than the title occupies. Over-charging is the
 * failure that inflates someone's usage and could get their requests wrongly
 * held; under-charging cannot.
 */
export function findInvariantViolations(
  claims: AttributionClaim[],
  titlesById: ReadonlyMap<string, AttributionTitleInput>,
): ClaimInvariantViolation[] {
  const violations: ClaimInvariantViolation[] = [];
  for (const c of claims) {
    const expected = titlesById.get(c.titleId)?.sizeBytes ?? 0;
    // `>` not `!==` — see this function's doc comment (FR-ACCT-8).
    if (c.chargedBytes > expected) {
      violations.push({ titleId: c.titleId, ssoUsername: c.ssoUsername, chargedBytes: c.chargedBytes, expectedBytes: expected });
    }
  }
  return violations;
}

/**
 * Playback-derived "never watched by anyone" reporting — parity with
 * `analysis/attribution.py`'s `unwatched_GB` column, and the member-facing
 * "which of my titles has nobody watched" user story
 * (`wiki/Feature-03-Usage-Accounting.md`). `watchedByTitleId` mirrors the
 * model diagram's explicit note that playback state is "shown alongside,
 * never affects the charge" — it is read here ONLY to bucket already-computed
 * `chargedBytes`, never to gate or alter them (see
 * `test/attribution-compute.test.ts`'s dedicated test pinning this).
 * A title absent from `watchedByTitleId` (unknown/stale playback data) is
 * treated as "not confirmed unwatched," never as a false positive — the same
 * "never let missing playback state zero/flip a value" discipline
 * `src/lib/playback/sync.ts` documents.
 */
export function computeNeverWatchedBytes(
  claims: AttributionClaim[],
  watchedByTitleId: ReadonlyMap<string, boolean>,
): { distinctTitleBytes: number; perMember: Map<string, number> } {
  const perMember = new Map<string, number>();
  const seenTitles = new Set<string>();
  let distinctTitleBytes = 0;

  for (const c of claims) {
    if (watchedByTitleId.get(c.titleId) !== false) continue; // not confirmed never-watched
    perMember.set(c.ssoUsername, (perMember.get(c.ssoUsername) ?? 0) + c.chargedBytes);
    if (!seenTitles.has(c.titleId)) {
      seenTitles.add(c.titleId);
      distinctTitleBytes += c.chargedBytes;
    }
  }

  return { distinctTitleBytes, perMember };
}
