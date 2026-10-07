import { describe, expect, it } from 'vitest';
import {
  CONFIRM_TYPED_TEXT,
  RECOVERY_FINE_PRINT,
  RECOVERY_GAP_NOTE,
  actionLabel,
  buildExecuteRequestItems,
  computeConfirmRequirement,
  computeSelectionSummary,
  confirmAcknowledgementLabel,
  describeExecuteItemDetail,
  describeUnavailableReason,
  executeOutcomeLabel,
  isBatchFullySuccessful,
  isConfirmReady,
  parseSelectedItemsFromSearchParams,
  selectionFieldName,
  seriesWholeShowWarning,
  sortSelectRows,
  splitReviewItems,
  watchedWarning,
  type DeleteSelectRow,
} from '@/components/member/deleteLogic';
import type { DeletionBatchSummary, DeletionItemResult, DeletionPlanItem } from '@/lib/deletion';

/**
 * Pure derivation logic behind the three-step self-service deletion flow
 * (P2-6). Every case here is hand-calculated — no DB, no fixtures, no
 * browser — keeping derivation logic in pure functions so it's testable
 * without a browser. This file never calls
 * `planDeletionItems`/`executeDeletionBatch` themselves (those are already
 * exhaustively covered by `test/deletion-plan.test.ts` /
 * `test/deletion-execute.test.ts`) — it only proves what THIS layer does
 * with their output shapes.
 */

function planItem(overrides: Partial<DeletionPlanItem> = {}): DeletionPlanItem {
  return { titleId: 'movie:1', found: true, outcome: 'delete', name: 'Thor', year: 2011, path: '/data/media/movies/thor', sizeBytes: 5000, chargedBytes: 5000, otherActiveClaimants: 0, ...overrides };
}

function selectRow(overrides: Partial<DeleteSelectRow> = {}): DeleteSelectRow {
  return { ...planItem(), watchedByAnyone: false, lastPlayedAnyAt: null, mediaType: 'movie', ...overrides };
}

// ---------------------------------------------------------------------------
// FR-DEL-5 / "must never read as the same action" — the vocabulary itself.
// ---------------------------------------------------------------------------

describe('actionLabel / selectionFieldName — delete and release must never read as the same action', () => {
  it('uses different words for delete vs release', () => {
    expect(actionLabel('delete')).toBe('Delete');
    expect(actionLabel('release')).toBe('Release claim');
    expect(actionLabel('delete')).not.toBe(actionLabel('release'));
  });

  it('gives delete and release different form field names, and gives nothing to anything unselectable', () => {
    expect(selectionFieldName('delete')).toBe('d');
    expect(selectionFieldName('release')).toBe('r');
    expect(selectionFieldName('blocked')).toBeNull();
    expect(selectionFieldName('unauthorized')).toBeNull();
    expect(selectionFieldName('already_gone')).toBeNull();
    expect(selectionFieldName('invalid_mode')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sortSelectRows
// ---------------------------------------------------------------------------

describe('sortSelectRows', () => {
  it('actionable rows first, largest-first within each group, ignoring watched state', () => {
    const rows = [
      selectRow({ titleId: 'small-unwatched', chargedBytes: 1000, watchedByAnyone: false }),
      selectRow({ titleId: 'blocked', outcome: 'blocked', blockedReason: 'protected', chargedBytes: 9_000_000 }),
      selectRow({ titleId: 'large-watched', chargedBytes: 9000, watchedByAnyone: true }),
      selectRow({ titleId: 'large-unwatched', chargedBytes: 5000, watchedByAnyone: false }),
    ];
    const sorted = sortSelectRows(rows).map((r) => r.titleId);
    expect(sorted).toEqual(['large-watched', 'large-unwatched', 'small-unwatched', 'blocked']);
  });
});

// ---------------------------------------------------------------------------
// computeSelectionSummary — the wiki's "you would free X GB, taking you from
// 340 GB to 190 GB (quota 200 GB)" running total.
// ---------------------------------------------------------------------------

describe('computeSelectionSummary', () => {
  it('sums chargedBytes of selected actionable rows only, and projects the resulting usage', () => {
    const rows = [planItem({ titleId: 'a', outcome: 'delete', chargedBytes: 12_000_000_000 }), planItem({ titleId: 'b', outcome: 'release', chargedBytes: 3_000_000_000 })];
    const summary = computeSelectionSummary(rows, new Set(['a', 'b']), 50_000_000_000, { kind: 'limited', bytes: 40_000_000_000 });
    expect(summary.selectedCount).toBe(2);
    expect(summary.freedBytes).toBe(15_000_000_000);
    expect(summary.projected).toMatchObject({ kind: 'limited', usedBytes: 35_000_000_000, overQuota: false });
  });

  it('ignores an id that is selected but whose CURRENT outcome is not delete/release (defensive — never trusts a stale selection)', () => {
    const rows = [planItem({ titleId: 'a', outcome: 'blocked', blockedReason: 'protected', chargedBytes: 12_000_000_000 })];
    const summary = computeSelectionSummary(rows, new Set(['a']), 50_000_000_000, { kind: 'unlimited' });
    expect(summary.selectedCount).toBe(0);
    expect(summary.freedBytes).toBe(0);
  });

  it('ignores an id not found at all (found: false)', () => {
    const rows: DeletionPlanItem[] = [{ titleId: 'ghost', found: false, outcome: 'unauthorized' }];
    const summary = computeSelectionSummary(rows, new Set(['ghost']), 1000, { kind: 'unconfigured' });
    expect(summary.selectedCount).toBe(0);
  });

  it('never projects usage below zero', () => {
    const rows = [planItem({ titleId: 'a', outcome: 'delete', chargedBytes: 999_999 })];
    const summary = computeSelectionSummary(rows, new Set(['a']), 100, { kind: 'unlimited' });
    expect(summary.projected).toMatchObject({ usedBytes: 0 });
  });
});

// ---------------------------------------------------------------------------
// parseSelectedItemsFromSearchParams — the zero-JS carry-forward mechanism.
// ---------------------------------------------------------------------------

describe('parseSelectedItemsFromSearchParams', () => {
  it('maps d -> delete_files and r -> release_claim, preserving order (d before r)', () => {
    expect(parseSelectedItemsFromSearchParams({ d: ['movie:1', 'movie:2'], r: 'series:1' })).toEqual([
      { titleId: 'movie:1', requestedMode: 'delete_files' },
      { titleId: 'movie:2', requestedMode: 'delete_files' },
      { titleId: 'series:1', requestedMode: 'release_claim' },
    ]);
  });

  it('a single value (not an array) still works — how a form with exactly one checked box serializes', () => {
    expect(parseSelectedItemsFromSearchParams({ d: 'movie:1' })).toEqual([{ titleId: 'movie:1', requestedMode: 'delete_files' }]);
  });

  it('empty/missing params -> empty array, never throws', () => {
    expect(parseSelectedItemsFromSearchParams({})).toEqual([]);
  });

  it('drops duplicates and empty strings, first occurrence wins', () => {
    expect(parseSelectedItemsFromSearchParams({ d: ['movie:1', '', 'movie:1'], r: ['movie:1'] })).toEqual([{ titleId: 'movie:1', requestedMode: 'delete_files' }]);
  });
});

// ---------------------------------------------------------------------------
// splitReviewItems — the two-section (+ can't-proceed) separation.
// ---------------------------------------------------------------------------

describe('splitReviewItems', () => {
  it('separates delete / release / everything else into three distinct groups', () => {
    const items = [
      planItem({ titleId: 'd1', outcome: 'delete' }),
      planItem({ titleId: 'r1', outcome: 'release' }),
      planItem({ titleId: 'b1', outcome: 'blocked', blockedReason: 'protected' }),
      { titleId: 'u1', found: false, outcome: 'unauthorized' } as DeletionPlanItem,
      planItem({ titleId: 'g1', outcome: 'already_gone' }),
    ];
    const sections = splitReviewItems(items);
    expect(sections.toDelete.map((i) => i.titleId)).toEqual(['d1']);
    expect(sections.toRelease.map((i) => i.titleId)).toEqual(['r1']);
    expect(sections.cannotProceed.map((i) => i.titleId)).toEqual(['b1', 'u1', 'g1']);
  });

  it('preserves extra merged fields (e.g. mediaType) through the split — generic over T', () => {
    interface Row extends DeletionPlanItem {
      mediaType: 'movie' | 'tv';
    }
    const rows: Row[] = [{ ...planItem({ titleId: 'tv1', outcome: 'delete' }), mediaType: 'tv' }];
    const sections = splitReviewItems(rows);
    expect(sections.toDelete[0].mediaType).toBe('tv');
  });
});

// ---------------------------------------------------------------------------
// describeUnavailableReason — FR-DEL-4a: never names who.
// ---------------------------------------------------------------------------

describe('describeUnavailableReason', () => {
  it('protected: surfaces the operator reason verbatim', () => {
    expect(describeUnavailableReason(planItem({ outcome: 'blocked', blockedReason: 'protected', protectedReason: 'family favourite' }))).toContain('family favourite');
  });

  it('protected with no reason text still says something', () => {
    expect(describeUnavailableReason(planItem({ outcome: 'blocked', blockedReason: 'protected', protectedReason: null }))).toBe('Protected by the operator.');
  });

  it('guard: joins member-safe guardMessages, never leaks anything else', () => {
    const text = describeUnavailableReason(planItem({ outcome: 'blocked', blockedReason: 'guard', guardMessages: ['Played by someone within the last 14 days.'] }));
    expect(text).toBe('Played by someone within the last 14 days.');
    expect(text.toLowerCase()).not.toMatch(/\bfrank\b|\bdana\b|\berin\b/); // no username ever appears
  });

  it('sole_claimant_cannot_release and no_claim_to_release get distinct, specific copy', () => {
    expect(describeUnavailableReason(planItem({ outcome: 'blocked', blockedReason: 'sole_claimant_cannot_release' }))).toMatch(/only claimant/i);
    expect(describeUnavailableReason(planItem({ outcome: 'blocked', blockedReason: 'no_claim_to_release' }))).toMatch(/no claim/i);
  });

  it('unauthorized / invalid_mode / already_gone each get their own copy', () => {
    expect(describeUnavailableReason(planItem({ outcome: 'unauthorized' }))).toMatch(/don't have an active claim/i);
    expect(describeUnavailableReason(planItem({ outcome: 'invalid_mode' }))).toMatch(/could not be understood/i);
    expect(describeUnavailableReason(planItem({ outcome: 'already_gone' }))).toMatch(/already gone/i);
  });

  it('an actionable outcome (delete/release) has no "unavailable" reason', () => {
    expect(describeUnavailableReason(planItem({ outcome: 'delete' }))).toBe('');
    expect(describeUnavailableReason(planItem({ outcome: 'release' }))).toBe('');
  });
});

describe('watchedWarning / seriesWholeShowWarning', () => {
  it('warns only when watchedByAnyone is true', () => {
    expect(watchedWarning({ watchedByAnyone: true })).not.toBeNull();
    expect(watchedWarning({ watchedByAnyone: false })).toBeNull();
    expect(watchedWarning({})).toBeNull();
  });

  it('warns about whole-series removal only for tv, never for movie or unknown', () => {
    expect(seriesWholeShowWarning('tv')).toMatch(/entire series/i);
    expect(seriesWholeShowWarning('movie')).toBeNull();
    expect(seriesWholeShowWarning(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Step 3 — confirm gating and copy.
// ---------------------------------------------------------------------------

describe('computeConfirmRequirement / confirmAcknowledgementLabel', () => {
  it('counts and sums ONLY delete items, never release (release frees no disk bytes)', () => {
    const req = computeConfirmRequirement([
      { mode: 'delete', sizeBytes: 5_000_000_000 },
      { mode: 'delete', sizeBytes: 2_000_000_000 },
      { mode: 'release', sizeBytes: 999_000_000_000 },
    ]);
    expect(req).toEqual({ deleteCount: 2, deleteBytes: 7_000_000_000 });
  });

  it('acknowledgement copy states the exact N and X GB, singular/plural correct', () => {
    expect(confirmAcknowledgementLabel({ deleteCount: 1, deleteBytes: 1_000_000_000 })).toBe('I understand this schedules the permanent removal of 1 file totalling 1.00 GB, and that it will run unless I cancel it first.');
    expect(confirmAcknowledgementLabel({ deleteCount: 3, deleteBytes: 6_000_000_000 })).toBe('I understand this schedules the permanent removal of 3 files totalling 6.00 GB, and that it will run unless I cancel it first.');
  });

  it('a release-only batch states 0 files, 0.00 GB — never conflates release with a file removal', () => {
    const req = computeConfirmRequirement([{ mode: 'release', sizeBytes: 5_000_000_000 }]);
    expect(confirmAcknowledgementLabel(req)).toBe('I understand this schedules the permanent removal of 0 files totalling 0.00 GB, and that it will run unless I cancel it first.');
  });
});

describe('isConfirmReady — FR-DEL-5 step 3: all three, not fewer', () => {
  it('requires the exact typed word, case-sensitive', () => {
    expect(isConfirmReady(CONFIRM_TYPED_TEXT, true, 1)).toBe(true);
    expect(isConfirmReady('Delete', true, 1)).toBe(false);
    expect(isConfirmReady('DELETE', true, 1)).toBe(false);
    expect(isConfirmReady(' delete', true, 1)).toBe(false);
  });

  it('requires the checkbox', () => {
    expect(isConfirmReady('delete', false, 1)).toBe(false);
  });

  it('requires at least one actionable item — an empty batch is never confirmable', () => {
    expect(isConfirmReady('delete', true, 0)).toBe(false);
  });

  it('only true when all three hold', () => {
    expect(isConfirmReady('delete', true, 3)).toBe(true);
  });
});

describe('buildExecuteRequestItems', () => {
  it('passes titleId/requestedMode through unmodified — no re-derivation client-side', () => {
    expect(
      buildExecuteRequestItems([
        { titleId: 'a', requestedMode: 'delete_files' },
        { titleId: 'b', requestedMode: 'release_claim' },
      ]),
    ).toEqual([
      { titleId: 'a', requestedMode: 'delete_files' },
      { titleId: 'b', requestedMode: 'release_claim' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// FR-DEL-8 — the result report must never call a partial batch a success.
// ---------------------------------------------------------------------------

function summary(overrides: Partial<DeletionBatchSummary> = {}): DeletionBatchSummary {
  return { total: 0, deleted: 0, released: 0, failed: 0, blocked: 0, unauthorized: 0, invalidMode: 0, alreadyGone: 0, rateLimited: 0, cancelled: 0, ...overrides };
}

describe('isBatchFullySuccessful — FR-DEL-8', () => {
  it('all deleted/released/already_gone -> success', () => {
    expect(isBatchFullySuccessful(summary({ total: 3, deleted: 1, released: 1, alreadyGone: 1 }))).toBe(true);
  });

  it('any failure, block, unauthorized, invalid mode, or rate limit -> NOT success, even with just one bad item among many good ones', () => {
    expect(isBatchFullySuccessful(summary({ total: 6, deleted: 5, failed: 1 }))).toBe(false);
    expect(isBatchFullySuccessful(summary({ total: 2, deleted: 1, blocked: 1 }))).toBe(false);
    expect(isBatchFullySuccessful(summary({ total: 2, deleted: 1, unauthorized: 1 }))).toBe(false);
    expect(isBatchFullySuccessful(summary({ total: 2, deleted: 1, invalidMode: 1 }))).toBe(false);
    expect(isBatchFullySuccessful(summary({ total: 2, deleted: 1, rateLimited: 1 }))).toBe(false);
  });
});

describe('executeOutcomeLabel / describeExecuteItemDetail', () => {
  it('every outcome has a distinct label, and deleted/released are never worded the same', () => {
    expect(executeOutcomeLabel('deleted')).toBe('Deleted');
    expect(executeOutcomeLabel('released')).toBe('Released');
    expect(executeOutcomeLabel('deleted')).not.toBe(executeOutcomeLabel('released'));
  });

  function result(overrides: Partial<DeletionItemResult> = {}): DeletionItemResult {
    return { titleId: 'movie:1', requestedMode: 'delete_files', outcome: 'deleted', ...overrides };
  }

  it('a partial (files deleted, seerr cleanup failed) surfaces its warning verbatim, not a generic success', () => {
    expect(describeExecuteItemDetail(result({ outcome: 'deleted', partial: true, warning: 'Files were deleted, but the Seerr request could not be removed — needs operator attention.' }))).toBe(
      'Files were deleted, but the Seerr request could not be removed — needs operator attention.',
    );
  });

  it('a downgraded release explains why, distinctly from a plain release', () => {
    expect(describeExecuteItemDetail(result({ outcome: 'released', downgradedFromDelete: true }))).toMatch(/no longer the sole claimant/i);
    expect(describeExecuteItemDetail(result({ outcome: 'released', downgradedFromDelete: false }))).toBeNull();
  });

  it('blocked guard messages surface, never a bare "blocked" with no reason when the backend gave one', () => {
    expect(describeExecuteItemDetail(result({ outcome: 'blocked', guardMessages: ['Played by someone within the last 14 days.'] }))).toBe('Played by someone within the last 14 days.');
  });

  it('rate_limited explains the limit', () => {
    expect(describeExecuteItemDetail(result({ outcome: 'rate_limited' }))).toMatch(/hourly deletion limit/i);
  });
});

// ---------------------------------------------------------------------------
// The documented filesystem-snapshot recovery window — must match wiki/Architecture.md + Feature-06
// verbatim, not a paraphrase (use the measured numbers, not an approximation).
// ---------------------------------------------------------------------------

describe('RECOVERY_FINE_PRINT / RECOVERY_GAP_NOTE — the measured numbers, verbatim', () => {
  it('states no in-app undo, and points at the operator', () => {
    expect(RECOVERY_FINE_PRINT).toMatch(/no in-app undo/i);
    expect(RECOVERY_FINE_PRINT).toMatch(/message the operator/i);
  });

  it('gives the tiered recovery window from the measured P0-2 numbers (hourly / daily / up to a year), not just "within an hour"', () => {
    expect(RECOVERY_FINE_PRINT).toMatch(/within about an hour/i);
    expect(RECOVERY_FINE_PRINT).toMatch(/hourly for the last day/i);
    expect(RECOVERY_FINE_PRINT).toMatch(/daily for the last month/i);
    expect(RECOVERY_FINE_PRINT).toMatch(/up to a year/i);
  });

  it('states the one real unrecoverable gap: same-window import-then-delete', () => {
    expect(RECOVERY_GAP_NOTE).toMatch(/15-minute window/);
    expect(RECOVERY_GAP_NOTE).toMatch(/cannot be recovered/i);
  });
});
