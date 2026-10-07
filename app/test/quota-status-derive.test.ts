import { describe, expect, it } from 'vitest';
import { deriveQuotaStatus } from '@/lib/quotaStatus/derive';
import type { EffectiveQuota } from '@/lib/members/quota';

const URL = 'https://quota.example.com';

const UNCONFIGURED: EffectiveQuota = { kind: 'unconfigured' };
const UNLIMITED: EffectiveQuota = { kind: 'unlimited' };
const limited = (bytes: number): EffectiveQuota => ({ kind: 'limited', bytes });

describe('deriveQuotaStatus — unconfigured (FR-POL-2a: an absence, never 0 and never unlimited)', () => {
  it('state=unconfigured, quotaBytes=null, shortfallBytes=null, regardless of usage', () => {
    const result = deriveQuotaStatus(UNCONFIGURED, 500_000_000_000, 0, URL);
    expect(result).toEqual({
      state: 'unconfigured',
      usageBytes: 500_000_000_000,
      quotaBytes: null,
      shortfallBytes: null,
      heldRequests: 0,
      url: URL,
    });
  });

  it('is outranked by held_only — a held request wins over unconfigured (wiki/Feature-10 Precedence block: held_only outranks unconfigured)', () => {
    const result = deriveQuotaStatus(UNCONFIGURED, 0, 3, URL);
    expect(result.state).toBe('held_only');
    expect(result.heldRequests).toBe(3);
    expect(result.quotaBytes).toBeNull(); // still unconfigured underneath — no quota figures to state
    expect(result.shortfallBytes).toBeNull();
  });

  it('with zero held requests, unconfigured wins (nothing else to report)', () => {
    const result = deriveQuotaStatus(UNCONFIGURED, 500_000_000_000, 0, URL);
    expect(result.state).toBe('unconfigured');
  });

  it('never conflated with the real quotaBytes=0 (unlimited) case', () => {
    const unconfigured = deriveQuotaStatus(UNCONFIGURED, 0, 0, URL);
    const unlimited = deriveQuotaStatus(UNLIMITED, 0, 0, URL);
    expect(unconfigured.state).toBe('unconfigured');
    expect(unconfigured.quotaBytes).toBeNull();
    expect(unlimited.state).toBe('ok');
    expect(unlimited.quotaBytes).toBe(0);
  });
});

describe('deriveQuotaStatus — unlimited (quotaBytes=0, a real operator decision)', () => {
  it('can never be over_quota, no matter how large usage is', () => {
    const result = deriveQuotaStatus(UNLIMITED, 999_000_000_000_000, 0, URL);
    expect(result.state).toBe('ok');
    expect(result.quotaBytes).toBe(0);
    expect(result.shortfallBytes).toBeNull();
  });

  it('held_only when unlimited but a hold is still outstanding (e.g. operator raised the quota to unlimited after the hold)', () => {
    const result = deriveQuotaStatus(UNLIMITED, 100, 1, URL);
    expect(result.state).toBe('held_only');
    expect(result.shortfallBytes).toBeNull(); // no limited quota to measure a shortfall against
  });

  it('ok when unlimited and zero held requests', () => {
    const result = deriveQuotaStatus(UNLIMITED, 100, 0, URL);
    expect(result.state).toBe('ok');
  });
});

describe('deriveQuotaStatus — limited: the boundary is strictly usage > quota, never >=', () => {
  it('usage exactly equal to quota is NOT over_quota', () => {
    const result = deriveQuotaStatus(limited(900_000_000_000), 900_000_000_000, 0, URL);
    expect(result.state).toBe('ok');
    expect(result.shortfallBytes).toBe(0);
  });

  it('usage one byte over quota IS over_quota, with the exact shortfall', () => {
    const result = deriveQuotaStatus(limited(900_000_000_000), 900_000_000_001, 0, URL);
    expect(result.state).toBe('over_quota');
    expect(result.shortfallBytes).toBe(1);
  });

  it('the worked example from wiki/Feature-10-In-Seerr-Banner.md', () => {
    const result = deriveQuotaStatus(limited(900_000_000_000), 1_040_000_000_000, 3, URL);
    expect(result).toEqual({
      state: 'over_quota',
      usageBytes: 1_040_000_000_000,
      quotaBytes: 900_000_000_000,
      shortfallBytes: 140_000_000_000,
      heldRequests: 3,
      url: URL,
    });
  });

  it('under quota with zero held requests -> ok', () => {
    const result = deriveQuotaStatus(limited(900_000_000_000), 100_000_000_000, 0, URL);
    expect(result.state).toBe('ok');
    expect(result.shortfallBytes).toBe(0);
  });

  it('under quota but with >=1 held request -> held_only, shortfall 0 (nothing to free right now)', () => {
    const result = deriveQuotaStatus(limited(900_000_000_000), 100_000_000_000, 1, URL);
    expect(result.state).toBe('held_only');
    expect(result.shortfallBytes).toBe(0);
  });

  it('over_quota takes precedence over held_only when both are true simultaneously', () => {
    const result = deriveQuotaStatus(limited(900_000_000_000), 1_000_000_000_000, 5, URL);
    expect(result.state).toBe('over_quota');
    expect(result.heldRequests).toBe(5); // still carried through in the payload
  });

  it('usage of 0 against a limited quota is a real ok measurement, not a missing one', () => {
    const result = deriveQuotaStatus(limited(900_000_000_000), 0, 0, URL);
    expect(result.state).toBe('ok');
    expect(result.usageBytes).toBe(0);
    expect(result.shortfallBytes).toBe(0);
  });
});

describe('deriveQuotaStatus — url is always passed through verbatim (FR-BAN-6)', () => {
  it('carries the given url unchanged for every state', () => {
    expect(deriveQuotaStatus(UNCONFIGURED, 0, 0, URL).url).toBe(URL);
    expect(deriveQuotaStatus(UNLIMITED, 0, 0, URL).url).toBe(URL);
    expect(deriveQuotaStatus(limited(1), 2, 0, URL).url).toBe(URL);
  });
});
