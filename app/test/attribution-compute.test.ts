import { describe, expect, it } from 'vitest';
import {
  buildTitlesById,
  computeAttribution,
  computeFleetDistinctTitleTotal,
  computeMemberTotals,
  computeNeverWatchedBytes,
  findInvariantViolations,
} from '@/lib/attribution/compute';
import type { AttributionRequestInput, AttributionTitleInput } from '@/lib/attribution/types';
import { MediaRequestStatus } from '@/lib/seerr/types';

/**
 * Hand-calculated tests for the pure attribution core (AGENTS.md rule 9,
 * `wiki/Feature-03-Usage-Accounting.md` `FR-ACCT-1`..`FR-ACCT-5`, `FR-ACCT-7`).
 *
 * ⚠ `wiki/Feature-03-Usage-Accounting.md`'s own "Acceptance criteria"
 * section is STALE — it still describes the even-split model `D-3` later
 * reversed ("each is charged 6.0 GB"). This suite asserts the CURRENT
 * model (`FR-ACCT-2`: full charge to every requester), not that stale doc
 * text — a spec gap the wiki should fix.
 */

function req(overrides: Partial<AttributionRequestInput> & Pick<AttributionRequestInput, 'seerrRequestId' | 'ssoUsername'>): AttributionRequestInput {
  return {
    mediaType: 'movie',
    tmdbId: 1,
    tvdbId: null,
    requestStatus: MediaRequestStatus.COMPLETED,
    createdAt: 1_000_000,
    ...overrides,
  };
}

function movieTitle(overrides: Partial<AttributionTitleInput> & Pick<AttributionTitleInput, 'id' | 'tmdbId'>): AttributionTitleInput {
  return {
    mediaType: 'movie',
    tvdbId: null,
    sizeBytes: 12_000_000_000,
    lastSyncedAt: 1_000_000,
    ...overrides,
  };
}

function seriesTitle(overrides: Partial<AttributionTitleInput> & Pick<AttributionTitleInput, 'id' | 'tvdbId'>): AttributionTitleInput {
  return {
    mediaType: 'tv',
    tmdbId: null,
    sizeBytes: 40_000_000_000,
    lastSyncedAt: 1_000_000,
    ...overrides,
  };
}

describe('computeAttribution — FR-ACCT-2/D-3: full charge, no shares', () => {
  it('a movie requested only by frank: frank is charged the full size, exactly one claim', () => {
    const titles = [movieTitle({ id: 'movie:1', tmdbId: 569094, sizeBytes: 12_000_000_000 })];
    const requests = [req({ seerrRequestId: 1, ssoUsername: 'frank', tmdbId: 569094 })];

    const { claims, unresolved } = computeAttribution(requests, titles);
    expect(unresolved).toEqual([]);
    expect(claims).toEqual([{ titleId: 'movie:1', ssoUsername: 'frank', seerrRequestId: 1, chargedBytes: 12_000_000_000 }]);
  });

  it('THE TRAP: the same movie also requested by dana — BOTH are charged the FULL 12.0 GB, not 6.0 GB each (D-3 was reversed; do not split)', () => {
    const titles = [movieTitle({ id: 'movie:1', tmdbId: 569094, sizeBytes: 12_000_000_000 })];
    const requests = [
      req({ seerrRequestId: 1, ssoUsername: 'frank', tmdbId: 569094, createdAt: 1_000_000 }),
      req({ seerrRequestId: 2, ssoUsername: 'dana', tmdbId: 569094, createdAt: 2_000_000 }),
    ];

    const { claims } = computeAttribution(requests, titles);
    const byUser = Object.fromEntries(claims.map((c) => [c.ssoUsername, c.chargedBytes]));
    expect(byUser).toEqual({ frank: 12_000_000_000, dana: 12_000_000_000 });
    // The two full charges do NOT sum to the title's size — that's the whole point of D-3's reversal.
    expect(byUser.frank + byUser.dana).toBe(24_000_000_000);
  });

  it('multi-season TV grabbed as one pack: two season-request clicks by the SAME member collapse into ONE claim, attributed to the earliest', () => {
    const titles = [seriesTitle({ id: 'series:3', tvdbId: 79335, sizeBytes: 176_321_392_504 })];
    const requests = [
      req({ seerrRequestId: 10, ssoUsername: 'erin', mediaType: 'tv', tmdbId: null, tvdbId: 79335, createdAt: 2_000_000 }),
      req({ seerrRequestId: 9, ssoUsername: 'erin', mediaType: 'tv', tmdbId: null, tvdbId: 79335, createdAt: 1_000_000 }),
    ];

    const { claims } = computeAttribution(requests, titles);
    expect(claims).toEqual([{ titleId: 'series:3', ssoUsername: 'erin', seerrRequestId: 9, chargedBytes: 176_321_392_504 }]);
  });

  it('FR-ACCT-5: an is4k and a non-4k request for the same physical title (same tmdbId, different seerrRequestId) collapse into one claim — never double-counted via the Seerr server slot', () => {
    const titles = [movieTitle({ id: 'movie:7', tmdbId: 42, sizeBytes: 5_000_000_000 })];
    const requests = [
      req({ seerrRequestId: 100, ssoUsername: 'jack', tmdbId: 42, createdAt: 1_000_000 }),
      req({ seerrRequestId: 101, ssoUsername: 'jack', tmdbId: 42, createdAt: 1_500_000 }), // e.g. the is4k slot's own request row
    ];
    const { claims } = computeAttribution(requests, titles);
    expect(claims).toHaveLength(1);
    expect(claims[0].chargedBytes).toBe(5_000_000_000);
  });
});

describe('computeAttribution — FR-ACCT-1: pending/declined/unavailable contribute zero', () => {
  const titleAvailable = movieTitle({ id: 'movie:1', tmdbId: 1, sizeBytes: 10_000_000_000 });
  const titleNotDownloaded = movieTitle({ id: 'movie:2', tmdbId: 2, sizeBytes: 0 });

  it('a PENDING request contributes zero bytes and produces no claim', () => {
    const { claims } = computeAttribution([req({ seerrRequestId: 1, ssoUsername: 'frank', tmdbId: 1, requestStatus: MediaRequestStatus.PENDING })], [titleAvailable]);
    expect(claims).toEqual([]);
  });

  it('a DECLINED request contributes zero bytes and produces no claim', () => {
    const { claims } = computeAttribution([req({ seerrRequestId: 1, ssoUsername: 'frank', tmdbId: 1, requestStatus: MediaRequestStatus.DECLINED })], [titleAvailable]);
    expect(claims).toEqual([]);
  });

  it('a FAILED request contributes zero bytes and produces no claim', () => {
    const { claims } = computeAttribution([req({ seerrRequestId: 1, ssoUsername: 'frank', tmdbId: 1, requestStatus: MediaRequestStatus.FAILED })], [titleAvailable]);
    expect(claims).toEqual([]);
  });

  it('an APPROVED request for a title Radarr has not downloaded yet (size_bytes: 0) contributes zero — "listed as pending, not as usage"', () => {
    const { claims } = computeAttribution([req({ seerrRequestId: 1, ssoUsername: 'frank', tmdbId: 2, requestStatus: MediaRequestStatus.APPROVED })], [titleNotDownloaded]);
    expect(claims).toEqual([]);
  });

  it('an APPROVED request for a title that DOES have bytes on disk IS charged (does not require COMPLETED)', () => {
    const { claims } = computeAttribution([req({ seerrRequestId: 1, ssoUsername: 'frank', tmdbId: 1, requestStatus: MediaRequestStatus.APPROVED })], [titleAvailable]);
    expect(claims).toEqual([{ titleId: 'movie:1', ssoUsername: 'frank', seerrRequestId: 1, chargedBytes: 10_000_000_000 }]);
  });

  it('the live "Obsession"/"Michael" case: a COMPLETED request against a title with real on-disk bytes IS charged — Seerr\'s own (unmodeled here) media status is never consulted, only actual size_bytes (D-2)', () => {
    // This type has no `mediaStatus` field at all by design (see compute.ts's
    // header comment) — there is nothing to even set to DELETED/UNKNOWN here,
    // which IS the point: title.sizeBytes is the only signal.
    const { claims } = computeAttribution([req({ seerrRequestId: 32, ssoUsername: 'dana', tmdbId: 1, requestStatus: MediaRequestStatus.COMPLETED })], [titleAvailable]);
    expect(claims).toEqual([{ titleId: 'movie:1', ssoUsername: 'dana', seerrRequestId: 32, chargedBytes: 10_000_000_000 }]);
  });
});

describe('computeAttribution — FR-ACCT-4: unresolved requests are surfaced, never dropped', () => {
  it('a movie request with no tmdbId at all: unresolved with reason missing_join_key', () => {
    const { claims, unresolved } = computeAttribution([req({ seerrRequestId: 1, ssoUsername: 'frank', tmdbId: null })], []);
    expect(claims).toEqual([]);
    expect(unresolved).toEqual([{ seerrRequestId: 1, ssoUsername: 'frank', mediaType: 'movie', tmdbId: null, tvdbId: null, reason: 'missing_join_key' }]);
  });

  it('a tv request whose tvdbId matches nothing in the library: unresolved with reason no_matching_title, zero bytes', () => {
    const titles = [seriesTitle({ id: 'series:1', tvdbId: 999, sizeBytes: 1_000_000 })];
    const { claims, unresolved } = computeAttribution(
      [req({ seerrRequestId: 16, ssoUsername: 'admin', mediaType: 'tv', tmdbId: null, tvdbId: 470270 })],
      titles,
    );
    expect(claims).toEqual([]);
    expect(unresolved).toEqual([{ seerrRequestId: 16, ssoUsername: 'admin', mediaType: 'tv', tmdbId: null, tvdbId: 470270, reason: 'no_matching_title' }]);
  });

  it('one resolved + one unresolved request in the same call: the resolved one still produces a claim (an unresolved sibling never poisons the batch)', () => {
    const titles = [movieTitle({ id: 'movie:1', tmdbId: 1, sizeBytes: 1_000_000 })];
    const { claims, unresolved } = computeAttribution(
      [req({ seerrRequestId: 1, ssoUsername: 'frank', tmdbId: 1 }), req({ seerrRequestId: 2, ssoUsername: 'erin', tmdbId: 999 })],
      titles,
    );
    expect(claims).toHaveLength(1);
    expect(unresolved).toHaveLength(1);
  });
});

describe('computeAttribution — title collision tie-break (the "deleted outside this app, then re-requested" edge case)', () => {
  it('two title rows share the same tmdbId (old arr_id, stale; new arr_id, fresh): the freshest wins and gets the claim', () => {
    const staleOld = movieTitle({ id: 'movie:OLD', tmdbId: 55, sizeBytes: 1_000_000, lastSyncedAt: 1_000_000 });
    const freshNew = movieTitle({ id: 'movie:NEW', tmdbId: 55, sizeBytes: 2_000_000, lastSyncedAt: 5_000_000 });
    const { claims } = computeAttribution([req({ seerrRequestId: 1, ssoUsername: 'frank', tmdbId: 55 })], [staleOld, freshNew]);
    expect(claims).toEqual([{ titleId: 'movie:NEW', ssoUsername: 'frank', seerrRequestId: 1, chargedBytes: 2_000_000 }]);
  });
});

describe('FR-ACCT-7: a member\'s usage only changes from their own actions or a real size change', () => {
  it('adding a SECOND member\'s claim on a title does not change the FIRST member\'s charge', () => {
    const titles = [movieTitle({ id: 'movie:1', tmdbId: 1, sizeBytes: 12_000_000_000 })];
    const before = computeAttribution([req({ seerrRequestId: 1, ssoUsername: 'frank', tmdbId: 1 })], titles);
    const frankBefore = before.claims.find((c) => c.ssoUsername === 'frank')?.chargedBytes;

    const after = computeAttribution(
      [req({ seerrRequestId: 1, ssoUsername: 'frank', tmdbId: 1 }), req({ seerrRequestId: 2, ssoUsername: 'erin', tmdbId: 1 })],
      titles,
    );
    const frankAfter = after.claims.find((c) => c.ssoUsername === 'frank')?.chargedBytes;

    expect(frankAfter).toBe(frankBefore);
    expect(frankAfter).toBe(12_000_000_000);
  });

  it('removing another member\'s (erin\'s) request entirely does not change frank\'s claim', () => {
    const titles = [movieTitle({ id: 'movie:1', tmdbId: 1, sizeBytes: 12_000_000_000 })];
    const withBoth = computeAttribution(
      [req({ seerrRequestId: 1, ssoUsername: 'frank', tmdbId: 1 }), req({ seerrRequestId: 2, ssoUsername: 'erin', tmdbId: 1 })],
      titles,
    );
    const withOnlyFrank = computeAttribution([req({ seerrRequestId: 1, ssoUsername: 'frank', tmdbId: 1 })], titles);

    const frankWithBoth = withBoth.claims.find((c) => c.ssoUsername === 'frank')?.chargedBytes;
    const frankAlone = withOnlyFrank.claims.find((c) => c.ssoUsername === 'frank')?.chargedBytes;
    expect(frankWithBoth).toBe(frankAlone);
  });

  it('a title\'s real size changing on disk DOES change every claimant\'s charge — the one legitimate cross-member-looking move, per D-3', () => {
    const smaller = [movieTitle({ id: 'movie:1', tmdbId: 1, sizeBytes: 10_000_000_000 })];
    const grown = [movieTitle({ id: 'movie:1', tmdbId: 1, sizeBytes: 11_000_000_000 })];
    const requests = [req({ seerrRequestId: 1, ssoUsername: 'frank', tmdbId: 1 }), req({ seerrRequestId: 2, ssoUsername: 'dana', tmdbId: 1 })];

    const before = computeAttribution(requests, smaller);
    const after = computeAttribution(requests, grown);
    for (const c of after.claims) expect(c.chargedBytes).toBe(11_000_000_000);
    for (const c of before.claims) expect(c.chargedBytes).toBe(10_000_000_000);
  });
});

describe('computeFleetDistinctTitleTotal — FR-ACCT-3', () => {
  it('a co-requested title is counted ONCE in the fleet total even though both claimants are charged its full size', () => {
    const titles = [movieTitle({ id: 'movie:1', tmdbId: 1, sizeBytes: 12_000_000_000 }), movieTitle({ id: 'movie:2', tmdbId: 2, sizeBytes: 5_000_000_000 })];
    const requests = [
      req({ seerrRequestId: 1, ssoUsername: 'frank', tmdbId: 1 }),
      req({ seerrRequestId: 2, ssoUsername: 'erin', tmdbId: 1 }),
      req({ seerrRequestId: 3, ssoUsername: 'dana', tmdbId: 2 }),
    ];
    const { claims } = computeAttribution(requests, titles);
    const titlesById = buildTitlesById(titles);

    const fleetTotal = computeFleetDistinctTitleTotal(claims, titlesById);
    // NOT frank(12) + erin(12) + dana(5) = 29 GB — that double-counts the co-requested title.
    expect(fleetTotal).toBe(17_000_000_000);

    const memberTotals = computeMemberTotals(claims);
    expect([...memberTotals.values()].reduce((a, b) => a + b, 0)).toBe(29_000_000_000);
    expect(fleetTotal).toBeLessThan([...memberTotals.values()].reduce((a, b) => a + b, 0));
  });
});

describe('findInvariantViolations — FR-ACCT-3 safety net', () => {
  it('a normally-computed claim set never violates the invariant', () => {
    const titles = [movieTitle({ id: 'movie:1', tmdbId: 1, sizeBytes: 12_000_000_000 })];
    const { claims } = computeAttribution([req({ seerrRequestId: 1, ssoUsername: 'frank', tmdbId: 1 })], titles);
    expect(findInvariantViolations(claims, buildTitlesById(titles))).toEqual([]);
  });

  it('an OVER-charge (chargedBytes > title.sizeBytes) IS detected', () => {
    const titles = [movieTitle({ id: 'movie:1', tmdbId: 1, sizeBytes: 12_000_000_000 })];
    const corruptClaim = { titleId: 'movie:1', ssoUsername: 'frank', seerrRequestId: 1, chargedBytes: 13_000_000_000 };
    const violations = findInvariantViolations([corruptClaim], buildTitlesById(titles));
    expect(violations).toEqual([{ titleId: 'movie:1', ssoUsername: 'frank', chargedBytes: 13_000_000_000, expectedBytes: 12_000_000_000 }]);
  });

  it('an UNDER-charge is no longer a violation — FR-ACCT-8 makes it legitimate', () => {
    // Was asserted as a violation before FR-ACCT-8. The shell DROPS violating
    // claims, so keeping the equality test would deactivate every claim
    // FR-ACCT-8 correctly reduced.
    const titles = [movieTitle({ id: 'movie:1', tmdbId: 1, sizeBytes: 12_000_000_000 })];
    const partial = { titleId: 'movie:1', ssoUsername: 'frank', seerrRequestId: 1, chargedBytes: 999 };
    expect(findInvariantViolations([partial], buildTitlesById(titles))).toEqual([]);
  });
});

describe('computeNeverWatchedBytes — playback is shown alongside, never affects the charge', () => {
  it('the same claim set produces the SAME chargedBytes regardless of what watch state is fed in', () => {
    const titles = [movieTitle({ id: 'movie:1', tmdbId: 1, sizeBytes: 12_000_000_000 })];
    const { claims } = computeAttribution([req({ seerrRequestId: 1, ssoUsername: 'frank', tmdbId: 1 })], titles);
    const withWatched = computeNeverWatchedBytes(claims, new Map([['movie:1', true]]));
    const withUnwatched = computeNeverWatchedBytes(claims, new Map([['movie:1', false]]));
    // chargedBytes on the underlying claim itself is untouched by either call.
    expect(claims[0].chargedBytes).toBe(12_000_000_000);
    expect(withWatched.distinctTitleBytes).toBe(0);
    expect(withUnwatched.distinctTitleBytes).toBe(12_000_000_000);
  });

  it('a title with NO playback data at all (unknown/stale) is never counted as unwatched — never a false positive', () => {
    const titles = [movieTitle({ id: 'movie:1', tmdbId: 1, sizeBytes: 12_000_000_000 })];
    const { claims } = computeAttribution([req({ seerrRequestId: 1, ssoUsername: 'frank', tmdbId: 1 })], titles);
    const result = computeNeverWatchedBytes(claims, new Map());
    expect(result.distinctTitleBytes).toBe(0);
    expect(result.perMember.size).toBe(0);
  });

  it('a co-requested unwatched title is counted once in distinctTitleBytes but for BOTH members in perMember', () => {
    const titles = [movieTitle({ id: 'movie:1', tmdbId: 1, sizeBytes: 10_000_000_000 })];
    const requests = [req({ seerrRequestId: 1, ssoUsername: 'frank', tmdbId: 1 }), req({ seerrRequestId: 2, ssoUsername: 'erin', tmdbId: 1 })];
    const { claims } = computeAttribution(requests, titles);
    const result = computeNeverWatchedBytes(claims, new Map([['movie:1', false]]));
    expect(result.distinctTitleBytes).toBe(10_000_000_000);
    expect(result.perMember.get('frank')).toBe(10_000_000_000);
    expect(result.perMember.get('erin')).toBe(10_000_000_000);
  });
});
