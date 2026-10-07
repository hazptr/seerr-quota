/**
 * Resolves each Seerr request's requester to a known local `member.sso_username`
 * — the "member" half of "resolved requests (member + title)" this task's
 * brief describes (title resolution is the pure core's job, `./compute.ts`).
 *
 * Pure (no I/O — `members` and `requests` are both plain data handed in by
 * `./sync.ts`, which is the one that actually reads the `member` table).
 *
 * **Key** (`wiki/Data-Model.md` §member, `wiki/Architecture.md` §D-9):
 * `member.seerr_user_id` is Seerr's own internal `user.id`, populated by the
 * account-sync module (`src/lib/members/sync.ts`) for EVERY known Seerr
 * account — including orphan/`not_entitled` rows like `akadmin`
 * (`wiki/Data-Model.md`: "Seerr's akadmin row -> unmatched, reported as
 * not_entitled" — still gets a member row, still gets `seerr_user_id` set).
 * So `SeerrRequest.requestedBy.id === member.seerr_user_id` is a reliable,
 * always-populated join — unlike `jellyfinUsername`, which can be null for a
 * non-Jellyfin-SSO account.
 *
 * A request whose requester has NO matching member row should never happen
 * in a healthy system (account sync creates one for every Seerr user, every
 * cycle) — but per this feature's "never silently drop" discipline, it is
 * still surfaced rather than swallowed: see `unmatched` below and
 * `./sync.ts`'s handling of it.
 */
import type { SeerrRequest } from '../seerr/types';
import type { AttributionRequestInput } from './types';

export interface MemberForAttributionResolve {
  ssoUsername: string;
  /** Seerr `user.id`; `null` = no Seerr account yet (`member.seerr_user_id`). */
  seerrUserId: number | null;
}

/** A request whose `requestedBy.id` matched no known `member.seerr_user_id` — should never happen (see this file's header comment), but surfaced rather than dropped. */
export interface UnmatchedSeerrRequester {
  seerrRequestId: number;
  seerrUserId: number;
}

export interface ResolveRequestMembersResult {
  resolved: AttributionRequestInput[];
  unmatched: UnmatchedSeerrRequester[];
}

/** ISO 8601 -> unix seconds; `null` (and any unparsable value) becomes `0` — `AttributionRequestInput.createdAt` only ever breaks a same-member/same-title tie (see `./types.ts`), never gates a charge, so an unparsable timestamp is safe to treat as "earliest." */
function parseIsoToUnixSeconds(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

export function resolveRequestMembers(requests: SeerrRequest[], members: MemberForAttributionResolve[]): ResolveRequestMembersResult {
  const ssoUsernameBySeerrUserId = new Map<number, string>();
  for (const m of members) {
    if (m.seerrUserId !== null) ssoUsernameBySeerrUserId.set(m.seerrUserId, m.ssoUsername);
  }

  const resolved: AttributionRequestInput[] = [];
  const unmatched: UnmatchedSeerrRequester[] = [];

  for (const req of requests) {
    const ssoUsername = ssoUsernameBySeerrUserId.get(req.requestedBy.id);
    if (ssoUsername === undefined) {
      unmatched.push({ seerrRequestId: req.id, seerrUserId: req.requestedBy.id });
      continue;
    }
    resolved.push({
      seerrRequestId: req.id,
      ssoUsername,
      mediaType: req.type,
      tmdbId: req.media.tmdbId,
      tvdbId: req.media.tvdbId,
      requestStatus: req.status,
      createdAt: parseIsoToUnixSeconds(req.createdAt),
      // P4-1 Wave 3: carried through unchanged — `./compute.ts` only ever
      // reads this for a request whose matched title is already split.
      seasons: req.seasons.map((s) => ({ seasonNumber: s.seasonNumber, status: s.status })),
    });
  }

  return { resolved, unmatched };
}
