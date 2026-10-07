import { describe, expect, it } from 'vitest';
import {
  buildPipelineStatus,
  classifyPipeline,
  computeRecentGrowthBytesPerDay,
  decisionSeverity,
  deriveMemberState,
  derivePercentUsed,
  describeDecision,
  diffEntitlement,
  estimateRunwayDays,
  formatRunway,
  groupSkipsByReason,
  memberStateLabel,
  memberStateSeverity,
  paginationMeta,
  parseSteps,
  pickLatestPerPipeline,
  readAttributionStepExtras,
  resolveBooleanRuntimeSetting,
  type SkippedDecisionLike,
  type SyncRunLike,
} from '@/components/admin/logic';

/**
 * Hand-calculated tests for the pure admin-dashboard derivation logic
 * (AGENTS.md rule 9, the project's design: "Keep derivation logic in pure
 * functions so it's testable without a browser"). No DB, no I/O, no
 * `Date.now()` — every scenario below is worked out by hand.
 */

describe('deriveMemberState — priority order mirrors src/lib/enforcement/decide.ts', () => {
  const base = {
    isOperator: false,
    syncStatus: 'matched' as const,
    quota: { kind: 'limited' as const, bytes: 100 },
    usedBytes: 50,
    graceBytes: 0,
    enforcementEnabled: true,
  };

  it('operator wins over everything else, even an over-quota usage figure', () => {
    expect(deriveMemberState({ ...base, isOperator: true, usedBytes: 1_000 })).toBe('operator');
  });

  it('no_seerr_account -> no_acct, regardless of quota', () => {
    expect(deriveMemberState({ ...base, syncStatus: 'no_seerr_account', usedBytes: null })).toBe('no_acct');
  });

  it('ambiguous -> ambiguous', () => {
    expect(deriveMemberState({ ...base, syncStatus: 'ambiguous', usedBytes: null })).toBe('ambiguous');
  });

  it('unconfigured quota -> quota_unconfigured, never a bare 0 or unlimited', () => {
    expect(deriveMemberState({ ...base, quota: { kind: 'unconfigured' } })).toBe('quota_unconfigured');
  });

  it('unlimited quota -> exempt', () => {
    expect(deriveMemberState({ ...base, quota: { kind: 'unlimited' }, usedBytes: 999_999 })).toBe('exempt');
  });

  it('exactly at quota (usedBytes === quotaBytes) -> ok, matching ">" not ">=" (FR-ENF-2)', () => {
    expect(deriveMemberState({ ...base, quota: { kind: 'limited', bytes: 100 }, usedBytes: 100 })).toBe('ok');
  });

  it('one byte over quota, enforcement on -> over', () => {
    expect(deriveMemberState({ ...base, quota: { kind: 'limited', bytes: 100 }, usedBytes: 101 })).toBe('over');
  });

  it('one byte over quota, enforcement OFF -> would_be_over, never "over"', () => {
    expect(deriveMemberState({ ...base, quota: { kind: 'limited', bytes: 100 }, usedBytes: 101, enforcementEnabled: false })).toBe('would_be_over');
  });

  it('grace_bytes extends the threshold, same as decide.ts', () => {
    expect(deriveMemberState({ ...base, quota: { kind: 'limited', bytes: 100 }, usedBytes: 110, graceBytes: 10 })).toBe('ok');
    expect(deriveMemberState({ ...base, quota: { kind: 'limited', bytes: 100 }, usedBytes: 111, graceBytes: 10 })).toBe('over');
  });

  it('under quota -> ok', () => {
    expect(deriveMemberState(base)).toBe('ok');
  });
});

describe('memberStateLabel', () => {
  it('every state has a distinct, non-empty label (FR-UI-7: never colour-only)', () => {
    const states = ['operator', 'exempt', 'quota_unconfigured', 'no_acct', 'ambiguous', 'over', 'would_be_over', 'ok'] as const;
    const labels = states.map(memberStateLabel);
    expect(new Set(labels).size).toBe(states.length);
    expect(labels.every((l) => l.length > 0)).toBe(true);
    expect(memberStateLabel('over')).toBe('OVER');
    expect(memberStateLabel('would_be_over')).toBe('would be over');
  });
});

describe('memberStateSeverity', () => {
  it('over/would_be_over/ok map to critical/warning/good', () => {
    expect(memberStateSeverity('over')).toBe('critical');
    expect(memberStateSeverity('would_be_over')).toBe('warning');
    expect(memberStateSeverity('ok')).toBe('good');
  });

  it('the purely-informational states have no severity', () => {
    expect(memberStateSeverity('operator')).toBeUndefined();
    expect(memberStateSeverity('exempt')).toBeUndefined();
    expect(memberStateSeverity('quota_unconfigured')).toBeUndefined();
    expect(memberStateSeverity('no_acct')).toBeUndefined();
    expect(memberStateSeverity('ambiguous')).toBeUndefined();
  });
});

describe('decisionSeverity', () => {
  it('approve/hold/decline map to good/warning/critical', () => {
    expect(decisionSeverity('approve')).toBe('good');
    expect(decisionSeverity('hold')).toBe('warning');
    expect(decisionSeverity('decline')).toBe('critical');
  });

  it('skip has no severity — no action was taken', () => {
    expect(decisionSeverity('skip')).toBeUndefined();
  });
});

describe('derivePercentUsed', () => {
  it('null usage -> null, never 0', () => {
    expect(derivePercentUsed(null, { kind: 'limited', bytes: 100 })).toBeNull();
  });
  it('unlimited/unconfigured quota -> null (percentage genuinely does not apply)', () => {
    expect(derivePercentUsed(50, { kind: 'unlimited' })).toBeNull();
    expect(derivePercentUsed(50, { kind: 'unconfigured' })).toBeNull();
  });
  it('limited quota -> real percentage', () => {
    expect(derivePercentUsed(91, { kind: 'limited', bytes: 100 })).toBe(91);
    expect(derivePercentUsed(150, { kind: 'limited', bytes: 100 })).toBe(150); // over 100% renders as such, not clamped
  });
});

describe('computeRecentGrowthBytesPerDay', () => {
  const now = 1_000_000;
  it('sums size_bytes only for titles added within the trailing window', () => {
    const titles = [
      { sizeBytes: 30 * 86_400, addedAt: now - 10 * 86_400 }, // inside a 30d window
      { sizeBytes: 999, addedAt: now - 40 * 86_400 }, // outside
      { sizeBytes: 500, addedAt: null }, // never reported an added date
    ];
    expect(computeRecentGrowthBytesPerDay(titles, now, 30)).toBe(30 * 86_400 / 30);
  });
  it('zero window -> 0, never divides by zero', () => {
    expect(computeRecentGrowthBytesPerDay([{ sizeBytes: 100, addedAt: now }], now, 0)).toBe(0);
  });
  it('no titles in window -> 0', () => {
    expect(computeRecentGrowthBytesPerDay([], now, 30)).toBe(0);
  });
});

describe('estimateRunwayDays / formatRunway', () => {
  it('null free space -> null runway', () => {
    expect(estimateRunwayDays(null, 100)).toBeNull();
  });
  it('zero or negative growth -> null runway (not "infinite")', () => {
    expect(estimateRunwayDays(1_000, 0)).toBeNull();
    expect(estimateRunwayDays(1_000, -5)).toBeNull();
  });
  it('normal division', () => {
    expect(estimateRunwayDays(1_000, 10)).toBe(100);
  });
  it('formatRunway buckets days/months/years and reports "insufficient data" for null', () => {
    expect(formatRunway(null)).toBe('insufficient data');
    expect(formatRunway(5)).toBe('~5d runway');
    expect(formatRunway(60)).toBe('~2mo runway');
    expect(formatRunway(900)).toBe('~2.5yr runway');
  });
});

describe('classifyPipeline', () => {
  it('classify -> members', () => {
    expect(classifyPipeline(['identity', 'seerr_users', 'classify'])).toBe('members');
  });
  it('movies/series -> library_requests, even though it ALSO carries a requests key shared with attribution', () => {
    expect(classifyPipeline(['movies', 'series', 'requests'])).toBe('library_requests');
  });
  it('playback -> playback', () => {
    expect(classifyPipeline(['playback'])).toBe('playback');
  });
  it('attribution (with its own requests key) -> attribution, not library_requests', () => {
    expect(classifyPipeline(['requests', 'attribution'])).toBe('attribution');
  });
  it('pending_sweep -> pending_sweep', () => {
    expect(classifyPipeline(['pending_sweep'])).toBe('pending_sweep');
  });
  it('an unrecognised shape -> unknown, never a guess', () => {
    expect(classifyPipeline(['something_else'])).toBe('unknown');
  });
});

describe('pickLatestPerPipeline', () => {
  it('picks the most recent COMPLETED row per pipeline, ignores in-progress rows and unparsable JSON', () => {
    const rows: SyncRunLike[] = [
      { id: 1, startedAt: 10, finishedAt: 20, steps: JSON.stringify({ classify: { ok: true, count: 1, ms: 1 } }), ok: true },
      { id: 2, startedAt: 30, finishedAt: 40, steps: JSON.stringify({ classify: { ok: true, count: 2, ms: 1 } }), ok: true },
      { id: 3, startedAt: 50, finishedAt: null, steps: JSON.stringify({ classify: { ok: true, count: 3, ms: 1 } }), ok: null }, // still in progress
      { id: 4, startedAt: 60, finishedAt: 70, steps: 'not json', ok: false },
      { id: 5, startedAt: 80, finishedAt: 90, steps: JSON.stringify({ playback: { ok: false, count: 0, ms: 1 } }), ok: false },
    ];
    const latest = pickLatestPerPipeline(rows);
    expect(latest.get('members')?.id).toBe(2); // newer than row 1, row 3 excluded (in progress)
    expect(latest.get('playback')?.id).toBe(5);
    expect(latest.has('attribution')).toBe(false);
  });
});

describe('parseSteps', () => {
  it('parses a valid steps blob', () => {
    expect(parseSteps(JSON.stringify({ a: { ok: true, count: 1, ms: 2 } }))).toEqual({ a: { ok: true, count: 1, ms: 2 } });
  });
  it('malformed JSON degrades to {} rather than throwing', () => {
    expect(parseSteps('not json')).toEqual({});
  });
  it('a JSON array (not an object) degrades to {}', () => {
    expect(parseSteps('[1,2,3]')).toEqual({});
  });
});

describe('readAttributionStepExtras — FR-ADM-4/FR-ACCT-4 unresolved/unmatched reporting', () => {
  it('reports unavailable when the optional fields are absent (the current, unfixed state of src/lib/attribution/sync.ts)', () => {
    const extras = readAttributionStepExtras({ attribution: { ok: true, count: 5, ms: 10 } });
    expect(extras).toEqual({ available: false, unresolvedCount: null, unmatchedRequesterCount: null });
  });
  it('reports unavailable when there is no attribution step at all', () => {
    expect(readAttributionStepExtras({})).toEqual({ available: false, unresolvedCount: null, unmatchedRequesterCount: null });
  });
  it('reads the optional fields when present (forward-compatible with a future fix)', () => {
    const extras = readAttributionStepExtras({ attribution: { ok: true, count: 5, ms: 10, unresolvedCount: 3, unmatchedRequesterCount: 1 } as never });
    expect(extras).toEqual({ available: true, unresolvedCount: 3, unmatchedRequesterCount: 1 });
  });
});

describe('groupSkipsByReason — the five reasons stay distinct, never collapsed', () => {
  it('groups by reason, in decide.ts priority order, capping the sample', () => {
    const skipped: SkippedDecisionLike[] = [
      { seerrRequestId: 1, ssoUsername: 'a', reason: 'stale_snapshot', decidedAt: 10 },
      { seerrRequestId: 2, ssoUsername: 'b', reason: 'stale_snapshot', decidedAt: 20 },
      { seerrRequestId: 3, ssoUsername: 'c', reason: 'stale_snapshot', decidedAt: 30 },
      { seerrRequestId: 4, ssoUsername: 'd', reason: 'unknown_member', decidedAt: 5 },
    ];
    const groups = groupSkipsByReason(skipped);
    expect(groups.map((g) => g.reason)).toEqual(['unknown_member', 'stale_snapshot']); // unknown_member sorts first per SKIP_REASON_ORDER
    const staleGroup = groups.find((g) => g.reason === 'stale_snapshot')!;
    expect(staleGroup.count).toBe(3);
    expect(staleGroup.sample[0].seerrRequestId).toBe(3); // most-recent-first
  });

  it('an empty list yields an empty array, not a zero-count placeholder', () => {
    expect(groupSkipsByReason([])).toEqual([]);
  });
});

describe('diffEntitlement (FR-ADM-9)', () => {
  it('finds users entitled to jellyseerr but not to seerr-quota (the harmful direction)', () => {
    const diff = diffEntitlement(['frank', 'erin', 'dana'], ['frank', 'erin']);
    expect(diff.entitledToSeerrOnly).toEqual(['dana']);
    expect(diff.entitledToQuotaOnly).toEqual([]);
  });
  it('finds the reverse mismatch too', () => {
    const diff = diffEntitlement(['frank'], ['frank', 'ghost']);
    expect(diff.entitledToQuotaOnly).toEqual(['ghost']);
  });
  it('is case-insensitive', () => {
    const diff = diffEntitlement(['Frank'], ['frank']);
    expect(diff.entitledToSeerrOnly).toEqual([]);
    expect(diff.entitledToQuotaOnly).toEqual([]);
  });
  it('identical sets -> no mismatch', () => {
    expect(diffEntitlement(['a', 'b'], ['b', 'a'])).toEqual({ entitledToSeerrOnly: [], entitledToQuotaOnly: [] });
  });
});

describe('paginationMeta (FR-ADM-5 server-side pagination)', () => {
  it('clamps a requested page below 1 up to 1', () => {
    expect(paginationMeta(0, 20, 100).page).toBe(1);
    expect(paginationMeta(-5, 20, 100).page).toBe(1);
  });
  it('clamps a requested page beyond the last page down to the last page', () => {
    const meta = paginationMeta(999, 20, 45); // pageCount = 3
    expect(meta.pageCount).toBe(3);
    expect(meta.page).toBe(3);
    expect(meta.offset).toBe(40);
  });
  it('zero rows still yields pageCount 1 (never 0)', () => {
    expect(paginationMeta(1, 20, 0).pageCount).toBe(1);
  });
  it('computes offset correctly for a normal middle page', () => {
    expect(paginationMeta(2, 20, 100).offset).toBe(20);
  });
});

describe('buildPipelineStatus', () => {
  it('never-run pipeline reports neverRun:true, stale:true, no steps', () => {
    const status = buildPipelineStatus('playback', undefined, 1_000, 3_600);
    expect(status).toMatchObject({ kind: 'playback', neverRun: true, finishedAt: null, stale: true, overallOk: null, steps: [] });
  });
  it('a completed run reports its steps and staleness from finishedAt', () => {
    const row: SyncRunLike = { id: 1, startedAt: 100, finishedAt: 500, steps: JSON.stringify({ playback: { ok: true, count: 7, ms: 12 } }), ok: true };
    const status = buildPipelineStatus('playback', row, 1_000, 3_600);
    expect(status.neverRun).toBe(false);
    expect(status.stale).toBe(false); // 500s age, under the 3600s threshold
    expect(status.overallOk).toBe(true);
    expect(status.steps).toEqual([{ stepKey: 'playback', ok: true, count: 7, ms: 12, error: null }]);
  });
  it('a stale run (older than the threshold) reports stale:true', () => {
    const row: SyncRunLike = { id: 1, startedAt: 0, finishedAt: 0, steps: '{}', ok: true };
    const status = buildPipelineStatus('playback', row, 10_000, 3_600);
    expect(status.stale).toBe(true);
  });
});

describe('resolveBooleanRuntimeSetting', () => {
  it('no row -> fallback', () => {
    expect(resolveBooleanRuntimeSetting(undefined, true)).toBe(true);
    expect(resolveBooleanRuntimeSetting(undefined, false)).toBe(false);
  });
  it('reads a valid JSON boolean', () => {
    expect(resolveBooleanRuntimeSetting({ value: 'true' }, false)).toBe(true);
    expect(resolveBooleanRuntimeSetting({ value: 'false' }, true)).toBe(false);
  });
  it('malformed/non-boolean JSON -> fallback', () => {
    expect(resolveBooleanRuntimeSetting({ value: 'not json' }, true)).toBe(true);
    expect(resolveBooleanRuntimeSetting({ value: '42' }, true)).toBe(true);
  });
});

describe('describeDecision — this task item 5: shadow mode must read correctly', () => {
  it('the exact phrasing the brief specifies: shadow hold over quota', () => {
    expect(describeDecision('hold', 'over_quota', false)).toBe('would have held — over quota');
  });
  it('never a bare "would have held" — the reason is always appended', () => {
    expect(describeDecision('hold', 'over_quota', false)).not.toBe('would have held');
  });
  it('an ENFORCED hold reads as "held", not "would have held"', () => {
    expect(describeDecision('hold', 'over_quota', true)).toBe('held — over quota');
  });
  it('covers every decision verb', () => {
    expect(describeDecision('approve', 'under_quota', true)).toBe('approved — under quota');
    expect(describeDecision('decline', 'hold_expired', true)).toBe('declined — hold expired');
    expect(describeDecision('skip', 'stale_snapshot', true)).toBe('skipped — stale snapshot');
  });
});
