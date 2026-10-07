/**
 * `FR-ACCT-8` — a requester is charged only for bytes that landed at or after
 * their request.
 *
 * Fixtures are two synthetic cases chosen because they pull in opposite
 * directions, and a fix that only handles one of them is worse than no fix:
 *
 *   - Example Show A: member requested SEASON 3 (no files on disk) and was
 *     charged all 64 GB of seasons 1-2, already on disk. Correct charge: 0.
 *   - Example Show B: member requested later seasons and genuinely caused
 *     153 GB, with 77 GB already present. Correct charge: 153 GB, NOT zero —
 *     a naive "did this title predate the request?" flag would wrongly wipe
 *     all 230 GB.
 */
import { describe, expect, it } from 'vitest';
import { buildTitlesById, chargeableBytes, computeAttribution, findInvariantViolations } from '@/lib/attribution/compute';
import type { AttributionRequestInput, AttributionTitleInput } from '@/lib/attribution/types';

const GB = 1_000_000_000;
const T2024 = Date.parse('2024-02-01T00:00:00Z') / 1000;
const T_REQUEST = Date.parse('2030-01-15T00:00:00Z') / 1000;

function title(over: Partial<AttributionTitleInput> = {}): AttributionTitleInput {
  return { id: 'series:9001', mediaType: 'tv', tmdbId: null, tvdbId: 900001, sizeBytes: 64 * GB, lastSyncedAt: T_REQUEST, ...over } as AttributionTitleInput;
}

function request(over: Partial<AttributionRequestInput> = {}): AttributionRequestInput {
  return { seerrRequestId: 9001, ssoUsername: 'dana', mediaType: 'tv', tmdbId: null, tvdbId: 900001, requestStatus: 2, createdAt: T_REQUEST, ...over } as AttributionRequestInput;
}

describe('chargeableBytes — FR-ACCT-8', () => {
  it('Example Show A: everything predates the request, so the charge is zero', () => {
    const t = title({ files: [{ addedAt: T2024, sizeBytes: 39 * GB }, { addedAt: T2024, sizeBytes: 25 * GB }] });
    expect(chargeableBytes(t, T_REQUEST)).toBe(0);
  });

  it('Example Show B: charges ONLY the seasons that landed after the request, not all of it and not none of it', () => {
    const t = title({
      id: 'series:9002',
      sizeBytes: 230 * GB,
      files: [
        { addedAt: T2024, sizeBytes: 77 * GB },          // already there
        { addedAt: T_REQUEST + 3600, sizeBytes: 153 * GB }, // they caused this
      ],
    });
    expect(chargeableBytes(t, T_REQUEST)).toBe(153 * GB);
  });

  it('the ordinary case is unchanged: request first, files land after -> charged in full', () => {
    const t = title({ files: [{ addedAt: T_REQUEST + 7200, sizeBytes: 64 * GB }] });
    expect(chargeableBytes(t, T_REQUEST)).toBe(64 * GB);
  });

  it('a file landing exactly at the request instant counts as caused by it', () => {
    expect(chargeableBytes(title({ files: [{ addedAt: T_REQUEST, sizeBytes: 10 * GB }] }), T_REQUEST)).toBe(10 * GB);
  });

  it('no file data -> full size, the pre-FR-ACCT-8 behaviour (never under-charges)', () => {
    expect(chargeableBytes(title(), T_REQUEST)).toBe(64 * GB);
  });

  it('an undated file counts as pre-existing, so an upstream gap can never invent a charge', () => {
    const t = title({ files: [{ addedAt: 0, sizeBytes: 64 * GB }] });
    expect(chargeableBytes(t, T_REQUEST)).toBe(0);
  });

  it('never charges more than the title occupies, even if the file list disagrees', () => {
    const t = title({ sizeBytes: 10 * GB, files: [{ addedAt: T_REQUEST + 1, sizeBytes: 999 * GB }] });
    expect(chargeableBytes(t, T_REQUEST)).toBe(10 * GB);
  });

  it('a missing title contributes nothing rather than throwing', () => {
    expect(chargeableBytes(undefined, T_REQUEST)).toBe(0);
  });
});

describe('computeAttribution — FR-ACCT-8 end to end', () => {
  it('produces a zero-byte claim for the season-3 request, keeping the claim (they still asked for it)', () => {
    const t = title({ files: [{ addedAt: T2024, sizeBytes: 64 * GB }] });
    const { claims } = computeAttribution([request()], [t]);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ titleId: 'series:9001', ssoUsername: 'dana', chargedBytes: 0 });
  });

  it('uses the EARLIEST request as the cutoff when someone requested the same series twice', () => {
    // Asked once early, then again later: they caused everything from the first request on.
    const t = title({ files: [{ addedAt: T2024 + 60, sizeBytes: 39 * GB }, { addedAt: T_REQUEST + 60, sizeBytes: 25 * GB }] });
    const { claims } = computeAttribution(
      [request({ seerrRequestId: 9002, createdAt: T2024 }), request({ seerrRequestId: 9003, createdAt: T_REQUEST })],
      [t],
    );
    expect(claims).toHaveLength(1);
    expect(claims[0].chargedBytes).toBe(64 * GB);
  });

  it('D-3 still holds: two members who both caused it are each charged in full, never divided', () => {
    const t = title({ files: [{ addedAt: T_REQUEST + 60, sizeBytes: 64 * GB }] });
    const { claims } = computeAttribution([request(), request({ seerrRequestId: 9004, ssoUsername: 'erin' })], [t]);
    expect(claims).toHaveLength(2);
    expect(claims.map((c) => c.chargedBytes)).toEqual([64 * GB, 64 * GB]);
  });
});

describe('findInvariantViolations — must not fight FR-ACCT-8', () => {
  it('a charge SMALLER than the title is legitimate and is not a violation', () => {
    // The regression this exists for: an equality check flagged every
    // FR-ACCT-8 charge, and the sync shell drops violating claims — which
    // deactivated the very claims the rule had just corrected.
    const t = title({ sizeBytes: 230 * GB });
    const claims = [{ titleId: t.id, ssoUsername: 'erin', seerrRequestId: 1, chargedBytes: 153 * GB }];
    expect(findInvariantViolations(claims, buildTitlesById([t]))).toEqual([]);
  });

  it('a zero charge on a title that entirely predates the request is not a violation', () => {
    const t = title({ sizeBytes: 64 * GB });
    const claims = [{ titleId: t.id, ssoUsername: 'dana', seerrRequestId: 9001, chargedBytes: 0 }];
    expect(findInvariantViolations(claims, buildTitlesById([t]))).toEqual([]);
  });

  it('still catches the failure that matters: charged MORE than the title occupies', () => {
    const t = title({ sizeBytes: 64 * GB });
    const claims = [{ titleId: t.id, ssoUsername: 'dana', seerrRequestId: 9001, chargedBytes: 65 * GB }];
    expect(findInvariantViolations(claims, buildTitlesById([t]))).toHaveLength(1);
  });
});
