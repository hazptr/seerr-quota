import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTitlesById, computeAttribution, computeFleetDistinctTitleTotal, computeMemberTotals } from '@/lib/attribution/compute';
import type { AttributionRequestInput, AttributionTitleInput } from '@/lib/attribution/types';
import { MediaRequestStatus } from '@/lib/seerr/types';

/**
 * The correctness bar the project's design calls out explicitly: reproduce the
 * "full charge" per-member totals `analysis/attribution.py` prints (its
 * side-by-side comparison column, NOT its even-split arithmetic — see that
 * file's own superseded-header warning and `wiki/Architecture.md` §D-3).
 *
 * `test/fixtures/attribution-sample.json` is a WHOLLY SYNTHETIC, hand-built
 * fixture — no real Seerr request ids, titles, usernames, or dates. Its 12
 * titles are exactly the ones referenced by the 23 fabricated requests below
 * (one request, #11, matches nothing in the title list at all, exercising
 * `FR-ACCT-4` for real).
 *
 * This fixture carries no per-request `MediaRequestStatus` field — every
 * request's `requestStatus` is fixed to `COMPLETED` here, matching exactly
 * what `analysis/attribution.py`'s reference model uses to decide "counts":
 * ONLY the arr library's actual on-disk size, nothing else.
 *
 * Expected values below are independently hand-derived from the fixture's
 * own `sizeBytes` column (summing each member's claimed titles by hand, and
 * the fleet total as the sum of DISTINCT claimed titles) — not pasted from
 * running the app's own code.
 */

interface Fixture {
  titles: { id: string; mediaType: 'movie' | 'tv'; tmdbId: number | null; tvdbId: number | null; sizeBytes: number }[];
  requests: { seerrRequestId: number; username: string; mediaType: 'movie' | 'tv'; tmdbId: number | null; tvdbId: number | null; createdAt: string }[];
}

function loadFixture(): Fixture {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'attribution-sample.json'), 'utf8');
  return JSON.parse(raw) as Fixture;
}

function toAttributionInputs(fixture: Fixture): { titles: AttributionTitleInput[]; requests: AttributionRequestInput[] } {
  const titles: AttributionTitleInput[] = fixture.titles.map((t) => ({ ...t, lastSyncedAt: 1_893_456_000 }));
  const requests: AttributionRequestInput[] = fixture.requests.map((r) => ({
    seerrRequestId: r.seerrRequestId,
    ssoUsername: r.username,
    mediaType: r.mediaType,
    tmdbId: r.tmdbId,
    tvdbId: r.tvdbId,
    requestStatus: MediaRequestStatus.COMPLETED,
    createdAt: Math.floor(Date.parse(r.createdAt) / 1000),
  }));
  return { titles, requests };
}

// Byte totals independently hand-derived from the synthetic fixture's own
// `sizeBytes` values — see the per-member breakdown in this file's header
// comment style below each assertion.
//   carol = movie:901 (5_000_000_000) + movie:902 (8_000_000_000) + series:802 (20_000_000_000) = 33_000_000_000
//   dana  = movie:903 (3_500_000_000) + movie:904 (12_000_000_000) + series:803 (15_000_000_000) = 30_500_000_000
//   erin  = series:801 (50_000_000_000) + movie:905 (2_000_000_000) = 52_000_000_000
//   frank = series:801 (50_000_000_000) + movie:906 (6_250_000_000) + series:804 (9_000_000_000) = 65_250_000_000
//   gus   = series:805 (30_000_000_000) + movie:907 (1_250_000_000) = 31_250_000_000
const EXPECTED_MEMBER_TOTALS: Record<string, number> = {
  carol: 33_000_000_000,
  dana: 30_500_000_000,
  erin: 52_000_000_000,
  frank: 65_250_000_000,
  gus: 31_250_000_000,
};
// Sum of the 12 DISTINCT claimed titles' sizeBytes (series:801, the
// co-requested title, counted ONCE): 5+8+3.5+12+2+6.25+1.25 (movies, in GB)
// + 50+20+15+9+30 (shows, in GB) = 38 + 124 = 162 GB = 162_000_000_000 bytes.
const EXPECTED_FLEET_DISTINCT_TOTAL = 162_000_000_000;

describe('attribution vs. the reference full-charge model (synthetic fixture)', () => {
  const fixture = loadFixture();
  const { titles, requests } = toAttributionInputs(fixture);
  const { claims, unresolved } = computeAttribution(requests, titles);
  const memberTotals = computeMemberTotals(claims);
  const fleetTotal = computeFleetDistinctTitleTotal(claims, buildTitlesById(titles));

  it('reproduces every member\'s full-charge total exactly', () => {
    for (const [user, expected] of Object.entries(EXPECTED_MEMBER_TOTALS)) {
      expect(memberTotals.get(user), `${user}'s total`).toBe(expected);
    }
  });

  it('frank is the largest (~65.25 GB) and dana the smallest (~30.5 GB) of the five', () => {
    const sorted = [...memberTotals.entries()].sort((a, b) => b[1] - a[1]);
    expect(sorted[0][0]).toBe('frank');
    expect(sorted[sorted.length - 1][0]).toBe('dana');
  });

  it('reproduces the fleet distinct-title total exactly (~162 GB) — NOT the sum of per-member totals', () => {
    expect(fleetTotal).toBe(EXPECTED_FLEET_DISTINCT_TOTAL);
    const summedPerMember = [...memberTotals.values()].reduce((a, b) => a + b, 0);
    expect(fleetTotal).toBeLessThan(summedPerMember); // the co-requested title (Example Show A) is why
  });

  it('frank and erin each carry the one co-requested title (Example Show A, 50 GB) in FULL — the whole reason the two models differ', () => {
    const showA = titles.find((t) => t.tvdbId === 900101);
    expect(showA).toBeDefined();
    const showAClaims = claims.filter((c) => c.titleId === showA!.id);
    expect(showAClaims.map((c) => c.ssoUsername).sort()).toEqual(['erin', 'frank']);
    for (const c of showAClaims) expect(c.chargedBytes).toBe(showA!.sizeBytes);
  });

  it('the one request absent from the title list entirely (tvdbId 900999, req 11, dana) is reported unresolved, not silently dropped', () => {
    expect(unresolved.some((u) => u.seerrRequestId === 11 && u.tvdbId === 900999 && u.reason === 'no_matching_title')).toBe(true);
  });
});
