/**
 * Shared types for the attribution engine (P1-6, `wiki/Feature-03-Usage-Accounting.md`).
 * See `./compute.ts` for the pure core these describe.
 */
import type { MediaRequestStatusValue } from '../seerr/types';

export type AttributionMediaType = 'movie' | 'tv';

/**
 * One Seerr request whose REQUESTER has already been resolved to a known
 * local `member.sso_username` — the "member" half of the project's design
 * ("resolved requests (member + title)"). Title resolution (tmdbId/tvdbId
 * -> a `title` row) is deliberately NOT done before this point: it's core,
 * hand-calculable business logic (FR-ACCT-4's "unresolved" reporting lives
 * there), so it belongs in the pure core (`./compute.ts`), not the impure
 * shell that builds this input (`./resolveMembers.ts`, `./sync.ts`).
 */
export interface AttributionRequestInput {
  seerrRequestId: number;
  ssoUsername: string;
  mediaType: AttributionMediaType;
  /** Join key for movies (`FR-ACCT-4`). `null` if Seerr hasn't resolved it. */
  tmdbId: number | null;
  /** Join key for tv (`FR-ACCT-4`). `null` for movies and unresolved tv media. */
  tvdbId: number | null;
  /** Seerr's own per-request `MediaRequestStatus` (`PENDING`/`APPROVED`/`DECLINED`/`FAILED`/`COMPLETED`) — gates `FR-ACCT-1`. */
  requestStatus: MediaRequestStatusValue;
  /**
   * Unix seconds. Used ONLY to pick a stable representative request when the
   * same member has multiple chargeable requests for the same title (e.g.
   * two season-request clicks on one series — `wiki/Feature-03-Usage-Accounting.md`'s
   * "multi-season TV grabbed as one pack" edge case, which collapses to ONE
   * claim). Never affects `charged_bytes`.
   */
  createdAt: number;
  /**
   * P4-1 Wave 3. Seerr's own `request.seasons[]`, carried through unchanged
   * (`{seasonNumber, status}` only — `id` isn't needed here). Per
   * Sonarr's API, there is no special
   * "whole series" sentinel: a whole-series request simply lists every
   * season number, each with its OWN independently-tracked
   * `MediaRequestStatus`. Only ever consulted by `computeAttribution` when
   * the matched title's `splitIntoSeasons` is `true` — optional (defaults to
   * `[]` when omitted) so every pre-Wave-3 test fixture keeps compiling and
   * behaving identically without being touched.
   */
  seasons?: { seasonNumber: number; status: MediaRequestStatusValue }[];
}

/** The minimal projection of a `title` row (`src/lib/db/schema.ts`) attribution needs. */
export interface AttributionTitleInput {
  id: string;
  mediaType: AttributionMediaType;
  tmdbId: number | null;
  tvdbId: number | null;
  /** `sizeOnDisk` (movie) / `statistics.sizeOnDisk` (series) — the ONLY source of truth for a claim's `chargedBytes` (`D-2`). Zero means "not yet available." */
  sizeBytes: number;
  /**
   * `FR-ACCT-8` — per-file acquisition times, present ONLY for titles where
   * some bytes might predate a requester's request (the impure shell decides;
   * see `./sync.ts`). When present, a claim is charged the sum of the files
   * that landed at or after the requester's EARLIEST request for this title,
   * instead of the whole `sizeBytes`.
   *
   * Absent means "no reason to think any of this predates the request", and
   * the charge falls back to the full `sizeBytes` — the pre-`FR-ACCT-8`
   * behaviour, which is also the safe direction (it never under-charges).
   */
  files?: { addedAt: number; sizeBytes: number }[];
  /** Unix seconds the title was added upstream; `null` if unknown. The `FR-ACCT-8` pre-filter (`./sync.ts`) uses it to decide whether per-file dates are worth fetching at all. */
  addedAt?: number | null;
  /** Which arr owns it, and its id there — only used by that same pre-filter. */
  arrInstance?: string;
  arrId?: number;
  /**
   * Unix seconds. Used only to break a tie when more than one `title` row
   * shares the same tmdbId/tvdbId — the "deleted outside this app, then
   * re-requested" edge case (`wiki/Feature-03-Usage-Accounting.md`): the OLD
   * row is never deleted (kept for FK integrity per `wiki/Data-Model.md`
   * §title) but must lose the tie to the freshly-synced replacement.
   */
  lastSyncedAt: number;
  /**
   * P4-1 Wave 3 (`title.split_into_seasons`, additive, Wave 1). `true` only
   * on a WHOLE-SERIES row that an operator has explicitly split
   * (`./sync.ts`'s `splitSeriesClaims`) — routes a matching tv request's
   * `seasons[]` to their own `series:{arrId}:s{n}` rows instead of one
   * whole-series claim (see `computeAttribution`). Never meaningful on a
   * season row itself or on a movie. Optional — defaults to `false` — so
   * every pre-Wave-3 test fixture and a real-world snapshot (every
   * series unsplit) keep compiling and behaving byte-for-byte identically
   * without being touched.
   */
  splitIntoSeasons?: boolean;
}

/**
 * One computed active claim (`FR-ACCT-2`/`D-3`). `chargedBytes` is ALWAYS
 * the matched title's full `sizeBytes` — never divided, never estimated.
 */
export interface AttributionClaim {
  titleId: string;
  ssoUsername: string;
  /** The representative request that earned this claim — this member's earliest chargeable request for this title. */
  seerrRequestId: number;
  chargedBytes: number;
}

export type UnresolvedReason =
  | 'missing_join_key' // the request has no tmdbId (movie) / tvdbId (tv) to join on
  | 'no_matching_title'; // the join key doesn't match any currently-known `title` row

/**
 * `FR-ACCT-4`: a request whose media cannot be resolved to a library item.
 * Contributes zero bytes, and — the whole point of this type existing — is
 * never silently dropped: it is always present in `AttributionResult.unresolved`.
 */
export interface UnresolvedRequest {
  seerrRequestId: number;
  ssoUsername: string;
  mediaType: AttributionMediaType;
  tmdbId: number | null;
  tvdbId: number | null;
  reason: UnresolvedReason;
}

export interface AttributionResult {
  claims: AttributionClaim[];
  unresolved: UnresolvedRequest[];
}

/** A claim whose `chargedBytes` disagrees with its title's CURRENT `sizeBytes` — should never happen by construction; see `./compute.ts`'s `findInvariantViolations`. */
export interface ClaimInvariantViolation {
  titleId: string;
  ssoUsername: string;
  chargedBytes: number;
  expectedBytes: number;
}
