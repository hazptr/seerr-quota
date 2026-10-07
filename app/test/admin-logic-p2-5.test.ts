import { describe, expect, it } from 'vitest';
import {
  countMembersCurrentlyOverQuota,
  EDITABLE_NUMERIC_SETTINGS,
  SETTING_METADATA,
  validateNonNegativeIntegerSetting,
  type AdminMemberRow,
} from '@/components/admin/logic';

/**
 * Hand-calculated tests for the P2-5 pure logic additions (`FR-ADM-6/7/8/11`,
 * the project's design: "Keep derivation logic in pure functions so it's
 * testable without a browser"). No DB, no I/O.
 */

function memberRow(overrides: Partial<AdminMemberRow>): AdminMemberRow {
  return {
    ssoUsername: 'x',
    displayName: null,
    isOperator: false,
    syncStatus: 'matched',
    quota: { kind: 'limited', bytes: 100 },
    quotaSource: 'default',
    usedBytes: 50,
    percentUsed: 50,
    neverWatchedBytes: 0,
    titleCount: 1,
    state: 'ok',
    ...overrides,
  };
}

describe('countMembersCurrentlyOverQuota', () => {
  it('counts over and would_be_over members, excludes everything else', () => {
    const members = [
      memberRow({ ssoUsername: 'dana', state: 'over' }),
      memberRow({ ssoUsername: 'erin', state: 'would_be_over' }),
      memberRow({ ssoUsername: 'frank', state: 'ok' }),
      memberRow({ ssoUsername: 'admin', state: 'operator' }),
      memberRow({ ssoUsername: 'carol', state: 'exempt' }),
      memberRow({ ssoUsername: 'ivy', state: 'no_acct' }),
      memberRow({ ssoUsername: 'hank', state: 'ambiguous' }),
      memberRow({ ssoUsername: 'family', state: 'quota_unconfigured' }),
    ];
    const result = countMembersCurrentlyOverQuota(members);
    expect(result.count).toBe(2);
    expect(result.usernames).toEqual(['dana', 'erin']);
  });

  it('empty member list -> zero, empty list', () => {
    expect(countMembersCurrentlyOverQuota([])).toEqual({ count: 0, usernames: [] });
  });

  it('usernames are sorted, not insertion order', () => {
    const members = [memberRow({ ssoUsername: 'hank', state: 'over' }), memberRow({ ssoUsername: 'frank', state: 'over' })];
    expect(countMembersCurrentlyOverQuota(members).usernames).toEqual(['frank', 'hank']);
  });
});

describe('validateNonNegativeIntegerSetting', () => {
  it('accepts zero and positive integers', () => {
    expect(validateNonNegativeIntegerSetting(0, 'x')).toEqual({ valid: true });
    expect(validateNonNegativeIntegerSetting(30, 'x')).toEqual({ valid: true });
  });

  it('rejects negative values', () => {
    const result = validateNonNegativeIntegerSetting(-1, 'hold_max_days');
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toMatch(/negative/);
  });

  it('rejects non-integers', () => {
    const result = validateNonNegativeIntegerSetting(1.5, 'hold_max_days');
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toMatch(/whole number/);
  });

  it('rejects non-finite values', () => {
    expect(validateNonNegativeIntegerSetting(Number.NaN, 'x').valid).toBe(false);
    expect(validateNonNegativeIntegerSetting(Number.POSITIVE_INFINITY, 'x').valid).toBe(false);
  });
});

describe('EDITABLE_NUMERIC_SETTINGS / SETTING_METADATA', () => {
  it('lists exactly the six settings this task names, each with metadata', () => {
    expect([...EDITABLE_NUMERIC_SETTINGS].sort()).toEqual(
      ['grace_bytes', 'delete_recent_play_days', 'stale_snapshot_max_age_s', 'delete_max_per_hour', 'hold_max_days', 'notify_cooldown_s'].sort(),
    );
    for (const key of EDITABLE_NUMERIC_SETTINGS) {
      expect(SETTING_METADATA[key].key).toBe(key);
      expect(SETTING_METADATA[key].label.length).toBeGreaterThan(0);
    }
  });

  it('grace_bytes is the only bytes_gb-unit setting', () => {
    expect(SETTING_METADATA.grace_bytes.unit).toBe('bytes_gb');
    for (const key of EDITABLE_NUMERIC_SETTINGS) {
      if (key !== 'grace_bytes') expect(SETTING_METADATA[key].unit).not.toBe('bytes_gb');
    }
  });
});
