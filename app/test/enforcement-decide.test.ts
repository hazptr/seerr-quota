import { describe, expect, it } from 'vitest';
import { decide } from '@/lib/enforcement/decide';
import type { DecisionInput } from '@/lib/enforcement/types';

/**
 * Hand-calculated cases for the pure `decide()` core (`FR-ENF-1`, `D-4a`).
 * No DB, no fetch, no mocks — every scenario here is arithmetic a human can
 * check by hand, which is the entire point of keeping this function pure.
 *
 * `reason` is always the TRUE reason (never overwritten to signal that
 * enforcement was off — that fact lives in `enforced`, per `FR-ENF-5`), and
 * the four `FR-ENF-4` fail-open causes are distinct reason values, never
 * collapsed into a single `unknown_member`.
 */

const BASE: DecisionInput = {
  enforcementEnabled: true,
  memberRecognized: true,
  memberSyncStatus: 'matched',
  isOperator: false,
  quota: { kind: 'limited', bytes: 500_000_000_000 },
  usageBytes: 100_000_000_000,
  graceBytes: 0,
  snapshotAgeS: 60,
  staleSnapshotMaxAgeS: 3600,
  isAlreadyHeld: false,
  holdAgeS: null,
  holdMaxDays: 30,
};

function input(overrides: Partial<DecisionInput>): DecisionInput {
  return { ...BASE, ...overrides };
}

describe('decide — FR-ENF-10: unrecognised member', () => {
  it('skips with unknown_member (enforced:true) regardless of every other input, even a wildly over-quota usage', () => {
    expect(
      decide(input({ memberRecognized: false, memberSyncStatus: null, usageBytes: 999_000_000_000_000, isOperator: true })),
    ).toEqual({ decision: 'skip', reason: 'unknown_member', enforced: true });
  });
});

describe('decide — FR-ENF-6: operator exemption', () => {
  it('always approves the operator, even with a stale/absent snapshot (checked before the staleness gate)', () => {
    expect(decide(input({ isOperator: true, snapshotAgeS: null }))).toEqual({
      decision: 'approve',
      reason: 'operator_exempt',
      enforced: true,
    });
  });

  it('always approves the operator, even wildly over quota', () => {
    expect(decide(input({ isOperator: true, usageBytes: 10_000_000_000_000 }))).toEqual({
      decision: 'approve',
      reason: 'operator_exempt',
      enforced: true,
    });
  });
});

describe('decide — FR-ENF-4: fail-open skip conditions, each with its OWN distinct reason', () => {
  it('member_not_matched (not unknown_member) for a non-matched sync status: ambiguous', () => {
    expect(decide(input({ memberSyncStatus: 'ambiguous' }))).toEqual({ decision: 'skip', reason: 'member_not_matched', enforced: true });
  });

  it('member_not_matched for a non-matched sync status: no_seerr_account', () => {
    expect(decide(input({ memberSyncStatus: 'no_seerr_account' }))).toEqual({
      decision: 'skip',
      reason: 'member_not_matched',
      enforced: true,
    });
  });

  it('member_not_matched for a non-matched sync status: not_entitled', () => {
    expect(decide(input({ memberSyncStatus: 'not_entitled' }))).toEqual({
      decision: 'skip',
      reason: 'member_not_matched',
      enforced: true,
    });
  });

  it('usage_unavailable (not unknown_member) when usage cannot be computed (usageBytes === null)', () => {
    expect(decide(input({ usageBytes: null }))).toEqual({ decision: 'skip', reason: 'usage_unavailable', enforced: true });
  });

  it('stale_snapshot when no snapshot exists at all (snapshotAgeS === null)', () => {
    expect(decide(input({ snapshotAgeS: null }))).toEqual({ decision: 'skip', reason: 'stale_snapshot', enforced: true });
  });

  it('stale_snapshot when the snapshot is older than staleSnapshotMaxAgeS', () => {
    expect(decide(input({ snapshotAgeS: 3601, staleSnapshotMaxAgeS: 3600 }))).toEqual({
      decision: 'skip',
      reason: 'stale_snapshot',
      enforced: true,
    });
  });

  it('does NOT skip when the snapshot age exactly equals staleSnapshotMaxAgeS (boundary is inclusive-of-fresh)', () => {
    const result = decide(input({ snapshotAgeS: 3600, staleSnapshotMaxAgeS: 3600 }));
    expect(result.decision).not.toBe('skip');
  });

  it('quota_unconfigured (not unknown_member) when quota is unconfigured — FR-POL-2a: absence is NOT unlimited', () => {
    expect(decide(input({ quota: { kind: 'unconfigured' } }))).toEqual({
      decision: 'skip',
      reason: 'quota_unconfigured',
      enforced: true,
    });
  });

  it('the four fail-open reasons are pairwise distinct string values (regression guard against re-collapsing them)', () => {
    const reasons = new Set([
      decide(input({ memberSyncStatus: 'ambiguous' })).reason,
      decide(input({ usageBytes: null })).reason,
      decide(input({ snapshotAgeS: null })).reason,
      decide(input({ quota: { kind: 'unconfigured' } })).reason,
    ]);
    expect(reasons).toEqual(new Set(['member_not_matched', 'usage_unavailable', 'stale_snapshot', 'quota_unconfigured']));
  });
});

describe('decide — FR-ENF-2: the quota boundary (> not >=)', () => {
  it('approves when usage is exactly at the limit', () => {
    expect(decide(input({ usageBytes: 500_000_000_000, quota: { kind: 'limited', bytes: 500_000_000_000 }, graceBytes: 0 }))).toEqual({
      decision: 'approve',
      reason: 'under_quota',
      enforced: true,
    });
  });

  it('holds when usage exceeds the limit by even one byte', () => {
    expect(
      decide(input({ usageBytes: 500_000_000_001, quota: { kind: 'limited', bytes: 500_000_000_000 }, graceBytes: 0 })),
    ).toEqual({ decision: 'hold', reason: 'over_quota', enforced: true });
  });

  it('grace_bytes extends the boundary: usage === limit + grace approves', () => {
    expect(
      decide(input({ usageBytes: 510_000_000_000, quota: { kind: 'limited', bytes: 500_000_000_000 }, graceBytes: 10_000_000_000 })),
    ).toEqual({ decision: 'approve', reason: 'under_quota', enforced: true });
  });

  it('grace_bytes extends the boundary: usage === limit + grace + 1 holds', () => {
    expect(
      decide(input({ usageBytes: 510_000_000_001, quota: { kind: 'limited', bytes: 500_000_000_000 }, graceBytes: 10_000_000_000 })),
    ).toEqual({ decision: 'hold', reason: 'over_quota', enforced: true });
  });
});

describe('decide — unlimited quota (FR-POL-2a)', () => {
  it('always approves regardless of usage magnitude', () => {
    expect(decide(input({ quota: { kind: 'unlimited' }, usageBytes: 999_000_000_000_000 }))).toEqual({
      decision: 'approve',
      reason: 'under_quota',
      enforced: true,
    });
  });
});

describe('decide — D-4a / FR-ENF-12: hold age-out is the only automated decline', () => {
  const HOLD_MAX_DAYS = 30;
  const SECONDS_PER_DAY = 86_400;
  const OVER_QUOTA = { usageBytes: 600_000_000_000, quota: { kind: 'limited' as const, bytes: 500_000_000_000 }, graceBytes: 0 };

  it('a brand-new over-quota request holds, never declines directly (isAlreadyHeld=false)', () => {
    expect(decide(input({ ...OVER_QUOTA, isAlreadyHeld: false, holdAgeS: null, holdMaxDays: HOLD_MAX_DAYS }))).toEqual({
      decision: 'hold',
      reason: 'over_quota',
      enforced: true,
    });
  });

  it('an already-held, still-over-quota request stays held while under HOLD_MAX_DAYS', () => {
    expect(
      decide(input({ ...OVER_QUOTA, isAlreadyHeld: true, holdAgeS: HOLD_MAX_DAYS * SECONDS_PER_DAY - 1, holdMaxDays: HOLD_MAX_DAYS })),
    ).toEqual({ decision: 'hold', reason: 'over_quota', enforced: true });
  });

  it('an already-held, still-over-quota request declines once holdAgeS reaches HOLD_MAX_DAYS', () => {
    expect(
      decide(input({ ...OVER_QUOTA, isAlreadyHeld: true, holdAgeS: HOLD_MAX_DAYS * SECONDS_PER_DAY, holdMaxDays: HOLD_MAX_DAYS })),
    ).toEqual({ decision: 'decline', reason: 'hold_expired', enforced: true });
  });

  it('HOLD_MAX_DAYS = 0 means never age out, no matter how long held', () => {
    expect(decide(input({ ...OVER_QUOTA, isAlreadyHeld: true, holdAgeS: 10_000 * SECONDS_PER_DAY, holdMaxDays: 0 }))).toEqual({
      decision: 'hold',
      reason: 'over_quota',
      enforced: true,
    });
  });

  it('SELF-HEAL beats age-out: a request held past HOLD_MAX_DAYS but no longer over quota approves, not declines', () => {
    expect(
      decide(
        input({
          usageBytes: 100_000_000_000, // freed space — now well under the 500 GB limit
          quota: { kind: 'limited', bytes: 500_000_000_000 },
          graceBytes: 0,
          isAlreadyHeld: true,
          holdAgeS: HOLD_MAX_DAYS * SECONDS_PER_DAY + 1,
          holdMaxDays: HOLD_MAX_DAYS,
        }),
      ),
    ).toEqual({ decision: 'approve', reason: 'under_quota', enforced: true });
  });
});

describe('decide — FR-ENF-5: enforcement_enabled=false sets enforced:false but NEVER changes the reason', () => {
  it('an under-quota approve stays under_quota, with enforced:false', () => {
    expect(decide(input({ enforcementEnabled: false, usageBytes: 100_000_000_000 }))).toEqual({
      decision: 'approve',
      reason: 'under_quota',
      enforced: false,
    });
  });

  it('an over-quota hold stays over_quota, with enforced:false — "would have held (over quota)", not just "would have held"', () => {
    expect(decide(input({ enforcementEnabled: false, usageBytes: 600_000_000_000 }))).toEqual({
      decision: 'hold',
      reason: 'over_quota',
      enforced: false,
    });
  });

  it('operator_exempt is unchanged while disabled — only enforced flips', () => {
    expect(decide(input({ enforcementEnabled: false, isOperator: true }))).toEqual({
      decision: 'approve',
      reason: 'operator_exempt',
      enforced: false,
    });
  });

  it('hold_expired is unchanged while disabled — only enforced flips', () => {
    expect(
      decide(
        input({
          enforcementEnabled: false,
          usageBytes: 600_000_000_000,
          isAlreadyHeld: true,
          holdAgeS: 31 * 86_400,
          holdMaxDays: 30,
        }),
      ),
    ).toEqual({ decision: 'decline', reason: 'hold_expired', enforced: false });
  });

  it('skip reasons carry enforced:false too, but the reason itself is still the true one — stale_snapshot', () => {
    expect(decide(input({ enforcementEnabled: false, snapshotAgeS: null }))).toEqual({
      decision: 'skip',
      reason: 'stale_snapshot',
      enforced: false,
    });
  });

  it('skip reasons carry enforced:false too — unknown_member', () => {
    expect(decide(input({ enforcementEnabled: false, memberRecognized: false, memberSyncStatus: null }))).toEqual({
      decision: 'skip',
      reason: 'unknown_member',
      enforced: false,
    });
  });
});

describe('decide — enforced mirrors enforcementEnabled exactly, on every decision type', () => {
  it('enforced:true when enforcementEnabled:true, across approve/hold/skip', () => {
    expect(decide(input({ enforcementEnabled: true, usageBytes: 100_000_000_000 })).enforced).toBe(true);
    expect(decide(input({ enforcementEnabled: true, usageBytes: 600_000_000_000 })).enforced).toBe(true);
    expect(decide(input({ enforcementEnabled: true, snapshotAgeS: null })).enforced).toBe(true);
  });

  it('enforced:false when enforcementEnabled:false, across approve/hold/skip', () => {
    expect(decide(input({ enforcementEnabled: false, usageBytes: 100_000_000_000 })).enforced).toBe(false);
    expect(decide(input({ enforcementEnabled: false, usageBytes: 600_000_000_000 })).enforced).toBe(false);
    expect(decide(input({ enforcementEnabled: false, snapshotAgeS: null })).enforced).toBe(false);
  });
});
