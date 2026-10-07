import { describe, expect, it } from 'vitest';
import { resolveEffectiveQuota } from '@/lib/members/quota';

describe('resolveEffectiveQuota — the inheritance table in wiki/Data-Model.md §quota_policy (FR-POL-2/FR-POL-2a)', () => {
  it('override=0 -> unlimited, regardless of the default', () => {
    expect(resolveEffectiveQuota(0, null)).toEqual({ kind: 'unlimited' });
    expect(resolveEffectiveQuota(0, 0)).toEqual({ kind: 'unlimited' });
    expect(resolveEffectiveQuota(0, 500_000_000_000)).toEqual({ kind: 'unlimited' });
  });

  it('override=N -> limited N, regardless of the default', () => {
    expect(resolveEffectiveQuota(500_000_000_000, null)).toEqual({ kind: 'limited', bytes: 500_000_000_000 });
    expect(resolveEffectiveQuota(1, null)).toEqual({ kind: 'limited', bytes: 1 });
    expect(resolveEffectiveQuota(500_000_000_000, 999_999_999_999)).toEqual({ kind: 'limited', bytes: 500_000_000_000 });
    expect(resolveEffectiveQuota(500_000_000_000, 0)).toEqual({ kind: 'limited', bytes: 500_000_000_000 });
  });

  it('override=null, default=0 -> unlimited (inherits the default\'s "unlimited" decision)', () => {
    expect(resolveEffectiveQuota(null, 0)).toEqual({ kind: 'unlimited' });
  });

  it('override=null, default=N -> limited N (inherits the default)', () => {
    expect(resolveEffectiveQuota(null, 300_000_000_000)).toEqual({ kind: 'limited', bytes: 300_000_000_000 });
  });

  it('override=null, default=unset -> unconfigured (an absence, never promoted to a limit)', () => {
    expect(resolveEffectiveQuota(null, null)).toEqual({ kind: 'unconfigured' });
  });

  it('the three RESULT states are never conflated across the domain — 0 and null are both falsy in JS but resolve differently', () => {
    // The exact bug this module exists to prevent: `quotaBytes || X` or `if (!quotaBytes)`
    // treats 0 and null identically. resolveEffectiveQuota must not.
    const unconfigured = resolveEffectiveQuota(null, null);
    const unlimitedViaOverride = resolveEffectiveQuota(0, null);
    const unlimitedViaDefault = resolveEffectiveQuota(null, 0);
    expect(unconfigured.kind).not.toBe(unlimitedViaOverride.kind);
    expect(unconfigured.kind).not.toBe(unlimitedViaDefault.kind);
    expect(unlimitedViaOverride).toEqual(unlimitedViaDefault);
  });

  it('a positive override always wins over the default — an override is never "inherited away"', () => {
    expect(resolveEffectiveQuota(1_150_000_000_000, 300_000_000_000)).toEqual({ kind: 'limited', bytes: 1_150_000_000_000 });
  });
});
