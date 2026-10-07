/**
 * Seerr `/api/v1/request` types + the VERIFIED status enums — grounded in
 * a real Seerr deployment, cross-checked against a real request history.
 * **The OpenAPI spec bundled inside Seerr's own image is stale for these two
 * enums** — ground truth is the compiled `/app/dist/constants/media.js`,
 * which is what these values come from. Do not "fix" these to match
 * `seerr-api.yml`; that file is the wrong one.
 *
 * Two concrete bugs the stale spec would cause if coded off it instead:
 * (a) the old spec doesn't define `MediaRequestStatus=5` at all, but a large
 * share of real requests ARE status 5 (`COMPLETED`) — a switch written off
 * the old doc silently mishandles the majority case; (b) the old spec
 * claims `MediaStatus 6=DELETED`, but real data shows actually-deleted media
 * rows are status **7**, and 6 is `BLOCKLISTED` — a `status === 6` "is
 * deleted" check would be testing the wrong thing entirely, breaking
 * `FR-ACCT-1` on exactly the deleted-then-relisted edge case
 * `wiki/Feature-03-Usage-Accounting.md` calls out.
 */

export const MediaRequestStatus = {
  PENDING: 1,
  APPROVED: 2,
  DECLINED: 3,
  FAILED: 4,
  COMPLETED: 5,
} as const;
export type MediaRequestStatusValue = (typeof MediaRequestStatus)[keyof typeof MediaRequestStatus];

const MEDIA_REQUEST_STATUS_VALUES: readonly number[] = Object.values(MediaRequestStatus);

export const MediaStatus = {
  UNKNOWN: 1,
  PENDING: 2,
  PROCESSING: 3,
  PARTIALLY_AVAILABLE: 4,
  AVAILABLE: 5,
  BLOCKLISTED: 6,
  DELETED: 7,
} as const;
export type MediaStatusValue = (typeof MediaStatus)[keyof typeof MediaStatus];

const MEDIA_STATUS_VALUES: readonly number[] = Object.values(MediaStatus);

export function isMediaRequestStatus(value: unknown): value is MediaRequestStatusValue {
  return typeof value === 'number' && MEDIA_REQUEST_STATUS_VALUES.includes(value);
}

export function isMediaStatus(value: unknown): value is MediaStatusValue {
  return typeof value === 'number' && MEDIA_STATUS_VALUES.includes(value);
}

export interface SeerrRequestedBy {
  id: number;
  email: string | null;
  jellyfinUsername: string | null;
  /**
   * The reliable join key for the Jellyfin playback join (`FR-ACCT-6`) — unlike
   * `jellyfinUsername`, it is stable across a Jellyfin username rename.
   */
  jellyfinUserId: string | null;
  displayName: string | null;
}

export interface SeerrRequestSeason {
  id: number;
  seasonNumber: number;
  /** A season's own approve/decline status — same `MediaRequestStatus` enum as the parent request. */
  status: MediaRequestStatusValue;
}

export interface SeerrRequestMedia {
  id: number;
  mediaType: 'movie' | 'tv';
  /** Join key to Radarr (`FR-ACCT-4`). `null` if Seerr hasn't resolved it. */
  tmdbId: number | null;
  /** Join key to Sonarr (`FR-ACCT-4`). `null` for movies and for unresolved TV media. */
  tvdbId: number | null;
  status: MediaStatusValue;
  status4k: MediaStatusValue | null;
  /**
   * Nullable, and observed `null` on EVERY row checked — including
   * `AVAILABLE` ones. Never branch on this being populated; join
   * playback via `tmdbId`/`tvdbId` -> `title`, never via this field. Kept
   * here for completeness/debugging only.
   */
  jellyfinMediaId: string | number | null;
}

export interface SeerrRequest {
  id: number;
  status: MediaRequestStatusValue;
  createdAt: string;
  updatedAt: string;
  type: 'movie' | 'tv';
  is4k: boolean;
  isAutoRequest: boolean;
  media: SeerrRequestMedia;
  seasons: SeerrRequestSeason[];
  requestedBy: SeerrRequestedBy;
}

export interface SeerrPageInfo {
  pages: number;
  pageSize: number;
  results: number;
  page: number;
}

export interface SeerrRequestPage {
  pageInfo: SeerrPageInfo;
  results: SeerrRequest[];
}
