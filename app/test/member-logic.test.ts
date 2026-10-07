import { describe, expect, it } from 'vitest';
import {
  computeFreshness,
  deriveQuotaDisplay,
  findLatestAttributionSnapshot,
  formatAge,
  formatGB,
  formatTimestamp,
  outcomeSeverity,
  quotaSeverity,
  resolveNumericRuntimeSetting,
  severityColorVar,
  sortMemberTitles,
  type MemberTitleRow,
} from '@/components/member/logic';

/**
 * Pure derivation logic behind the member view (P1-8). Every case here is
 * hand-calculated — no DB, no fixtures — per this task's instruction to
 * keep formatting/sorting/state-derivation testable as pure functions
 * rather than inline in JSX.
 */

describe('formatGB — FR-ACCT-9, decimal GB matching analysis/attribution.py\'s `size_bytes/1e9:.2f`', () => {
  it('formats bytes to two decimal places of GB, always labelled', () => {
    expect(formatGB(12_000_000_000)).toBe('12.00 GB');
    expect(formatGB(500_000_000)).toBe('0.50 GB');
    expect(formatGB(0)).toBe('0.00 GB');
  });

  it('formats a large multi-hundred-GB figure correctly (FR-ACCT-1..3 acceptance criteria)', () => {
    expect(formatGB(1_040_000_000_000)).toBe('1040.00 GB');
  });
});

describe('deriveQuotaDisplay — FR-POL-2a\'s three states, never conflated', () => {
  it('unconfigured: no number is invented, usage is still surfaced', () => {
    const display = deriveQuotaDisplay({ kind: 'unconfigured' }, 5_000_000_000);
    expect(display).toEqual({ kind: 'unconfigured', usedBytes: 5_000_000_000 });
  });

  it('unlimited: never blocked regardless of usage, usage still surfaced', () => {
    const display = deriveQuotaDisplay({ kind: 'unlimited' }, 999_000_000_000);
    expect(display).toEqual({ kind: 'unlimited', usedBytes: 999_000_000_000 });
  });

  it('limited, under quota: remaining is positive, overQuota is false', () => {
    const display = deriveQuotaDisplay({ kind: 'limited', bytes: 100_000_000_000 }, 40_000_000_000);
    if (display.kind !== 'limited') throw new Error('unreachable');
    expect(display.remainingBytes).toBe(60_000_000_000);
    expect(display.percentUsed).toBeCloseTo(40, 5);
    expect(display.overQuota).toBe(false);
  });

  it('limited, exactly at quota: not over (strictly greater-than triggers overQuota)', () => {
    const display = deriveQuotaDisplay({ kind: 'limited', bytes: 100_000_000_000 }, 100_000_000_000);
    if (display.kind !== 'limited') throw new Error('unreachable');
    expect(display.remainingBytes).toBe(0);
    expect(display.overQuota).toBe(false);
  });

  it('limited, over quota: negative remaining, overQuota true, percent can exceed 100', () => {
    const display = deriveQuotaDisplay({ kind: 'limited', bytes: 100_000_000_000 }, 150_000_000_000);
    if (display.kind !== 'limited') throw new Error('unreachable');
    expect(display.remainingBytes).toBe(-50_000_000_000);
    expect(display.percentUsed).toBeCloseTo(150, 5);
    expect(display.overQuota).toBe(true);
  });
});

describe('computeFreshness / formatAge — FR-ACCT-8 staleness', () => {
  it('fresh: age under the threshold is not stale', () => {
    const freshness = computeFreshness(1_000_000, 1_000_100, 3600);
    expect(freshness).toEqual({ ageSeconds: 100, stale: false });
  });

  it('exactly at the threshold is not yet stale (strictly greater-than)', () => {
    const freshness = computeFreshness(1_000_000, 1_003_600, 3600);
    expect(freshness.stale).toBe(false);
  });

  it('one second past the threshold is stale', () => {
    const freshness = computeFreshness(1_000_000, 1_003_601, 3600);
    expect(freshness.stale).toBe(true);
  });

  it('never reports a negative age (a future-dated snapshot clamps to zero)', () => {
    const freshness = computeFreshness(1_000_100, 1_000_000, 3600);
    expect(freshness.ageSeconds).toBe(0);
    expect(freshness.stale).toBe(false);
  });

  it('formatAge: minutes/hours/days buckets', () => {
    expect(formatAge(10)).toBe('just now');
    expect(formatAge(59)).toBe('just now');
    expect(formatAge(60)).toBe('1m ago');
    expect(formatAge(3599)).toBe('59m ago');
    expect(formatAge(3600)).toBe('1h ago');
    expect(formatAge(86399)).toBe('23h ago');
    expect(formatAge(86400)).toBe('1d ago');
  });
});

describe('formatTimestamp — deterministic for a given (epochSeconds, timeZone) pair', () => {
  it('renders the Unix epoch in UTC', () => {
    const rendered = formatTimestamp(0, 'UTC');
    expect(rendered).toContain('1970-01-01');
    expect(rendered).toContain('00:00');
  });

  it('is stable across repeated calls (pure — no hidden clock/env read)', () => {
    expect(formatTimestamp(1_756_000_000, 'UTC')).toBe(formatTimestamp(1_756_000_000, 'UTC'));
  });
});

describe('sortMemberTitles — largest chargedBytes first, full stop (no watched/unwatched grouping)', () => {
  function row(overrides: Partial<MemberTitleRow> & { titleId: string }): MemberTitleRow {
    return {
      name: overrides.titleId,
      year: 2020,
      chargedBytes: 0,
      watchedByAnyone: false,
      lastPlayedAnyAt: null,
      otherActiveClaimants: 0,
      ...overrides,
    };
  }

  it('sorts purely by chargedBytes descending, ignoring watched state', () => {
    const rows = [
      row({ titleId: 'small-unwatched', watchedByAnyone: false, chargedBytes: 1_000_000_000 }),
      row({ titleId: 'huge-watched', watchedByAnyone: true, chargedBytes: 900_000_000_000 }),
      row({ titleId: 'medium-unwatched', watchedByAnyone: false, chargedBytes: 10_000_000_000 }),
    ];
    const sorted = sortMemberTitles(rows);
    expect(sorted.map((r) => r.titleId)).toEqual(['huge-watched', 'medium-unwatched', 'small-unwatched']);
  });

  it('does not mutate the input array', () => {
    const rows = [row({ titleId: 'a', chargedBytes: 1 }), row({ titleId: 'b', chargedBytes: 2 })];
    const original = [...rows];
    sortMemberTitles(rows);
    expect(rows).toEqual(original);
  });
});

describe('findLatestAttributionSnapshot — FR-ACCT-8 snapshot selection', () => {
  it('undefined when no sync_run rows exist at all (P1-8 item 6: pre-reconcile empty state)', () => {
    expect(findLatestAttributionSnapshot([])).toBeUndefined();
  });

  it('undefined when sync_run rows exist but none carry an "attribution" step (e.g. only members/playback ran)', () => {
    const rows = [
      { id: 1, finishedAt: 100, steps: JSON.stringify({ identity: { ok: true }, seerr_users: { ok: true }, classify: { ok: true } }) },
      { id: 2, finishedAt: 200, steps: JSON.stringify({ playback: { ok: true } }) },
    ];
    expect(findLatestAttributionSnapshot(rows)).toBeUndefined();
  });

  it('ignores an in-progress run (finishedAt null) even if its steps mention attribution', () => {
    const rows = [{ id: 1, finishedAt: null, steps: JSON.stringify({ requests: { ok: true }, attribution: { ok: true } }) }];
    expect(findLatestAttributionSnapshot(rows)).toBeUndefined();
  });

  it('picks the MOST RECENT completed attribution run when several exist', () => {
    const rows = [
      { id: 1, finishedAt: 100, steps: JSON.stringify({ requests: {}, attribution: {} }) },
      { id: 2, finishedAt: 300, steps: JSON.stringify({ requests: {}, attribution: {} }) },
      { id: 3, finishedAt: 200, steps: JSON.stringify({ requests: {}, attribution: {} }) },
    ];
    expect(findLatestAttributionSnapshot(rows)).toEqual({ syncRunId: 2, finishedAt: 300 });
  });

  it('tolerates malformed steps JSON on one row without throwing, skipping only that row', () => {
    const rows = [
      { id: 1, finishedAt: 100, steps: 'not json' },
      { id: 2, finishedAt: 200, steps: JSON.stringify({ attribution: {} }) },
    ];
    expect(findLatestAttributionSnapshot(rows)).toEqual({ syncRunId: 2, finishedAt: 200 });
  });
});

describe('resolveNumericRuntimeSetting — app_setting DB override with a config fallback', () => {
  it('falls back when no row exists', () => {
    expect(resolveNumericRuntimeSetting(undefined, 3600)).toBe(3600);
  });

  it('uses the DB row\'s JSON-decoded numeric value when present', () => {
    expect(resolveNumericRuntimeSetting({ value: JSON.stringify(1800) }, 3600)).toBe(1800);
  });

  it('falls back on malformed JSON rather than throwing', () => {
    expect(resolveNumericRuntimeSetting({ value: 'not json' }, 3600)).toBe(3600);
  });

  it('falls back on a non-numeric decoded value', () => {
    expect(resolveNumericRuntimeSetting({ value: JSON.stringify('a string') }, 3600)).toBe(3600);
  });
});

describe('quotaSeverity — the 80%/100% thresholds', () => {
  it('good below 80%', () => {
    expect(quotaSeverity(0)).toBe('good');
    expect(quotaSeverity(79.9)).toBe('good');
  });

  it('warning from 80% up to (not including) 100%', () => {
    expect(quotaSeverity(80)).toBe('warning');
    expect(quotaSeverity(99.9)).toBe('warning');
  });

  it('critical at and above 100%', () => {
    expect(quotaSeverity(100)).toBe('critical');
    expect(quotaSeverity(140)).toBe('critical');
  });
});

describe('outcomeSeverity', () => {
  it('maps ok/denied/error to good/warning/critical', () => {
    expect(outcomeSeverity('ok')).toBe('good');
    expect(outcomeSeverity('denied')).toBe('warning');
    expect(outcomeSeverity('error')).toBe('critical');
  });
});

describe('severityColorVar', () => {
  it('maps each severity to its CSS custom property', () => {
    expect(severityColorVar('good')).toBe('var(--sq-good)');
    expect(severityColorVar('warning')).toBe('var(--sq-warning)');
    expect(severityColorVar('critical')).toBe('var(--sq-critical)');
  });
});
