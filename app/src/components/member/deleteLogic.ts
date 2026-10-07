/**
 * Pure derivation logic behind the three-step self-service deletion flow
 * (P2-6, `wiki/Feature-06-Self-Service-Deletion.md`). No I/O, no `Date.now()`,
 * no DB — every input is plain data (mostly `@/lib/deletion`'s own
 * `DeletionPlanItem`/`DeletionRequestItem` shapes), so every branch is
 * hand-calculable in `test/member-delete-logic.test.ts` without a browser
 * (AGENTS.md rule 9 — keep derivation logic out of JSX). The impure shells
 * that feed this are the three `src/app/delete{,/review,/confirm}/page.tsx`
 * Server Components, which call `@/lib/deletion`'s
 * `planDeletionItems`/`executeDeletionBatch` directly — this module never
 * talks to the DB or re-derives any authorization rule itself: it calls
 * `plan.ts` and `execute.ts`, never reimplementing a rule those own.
 */
import type { DeletionBatchSummary, DeletionItemOutcome, DeletionItemResult, DeletionMode, DeletionPlanItem, DeletionRequestItem, ScheduleBatchSummary, ScheduleItemOutcome, ScheduleItemResult } from '@/lib/deletion';
import type { EffectiveQuota } from '@/lib/members/quota';
import { deriveQuotaDisplay, formatGB, type QuotaDisplay } from './logic';
import { deriveWatchState, watchStateSentence } from '@/lib/playback/watchState';

// ---------------------------------------------------------------------------
// Step 1 — Select: per-row action label + the running "would free / would
// become" total (wiki's "you would free X GB, taking you from 340 GB to
// 190 GB (quota 200 GB)" copy).
// ---------------------------------------------------------------------------

/**
 * A Step 1 row: `planDeletionItems`'s own `DeletionPlanItem` (the
 * authoritative source for name/path/size/charge/outcome/blocked-reason —
 * never re-derived here) plus the two fields it doesn't carry
 * (`watchedByAnyone`/`lastPlayedAnyAt`, from `loadMemberDashboard`'s already
 * -tested `MemberTitleRow`) and `mediaType` (from the delete flow's own
 * small `loadMediaTypesForTitles` — see `src/app/delete/_data/mediaTypes.ts`).
 */
export interface DeleteSelectRow extends DeletionPlanItem {
  watchedByAnyone: boolean;
  lastPlayedAnyAt: number | null;
  mediaType: 'movie' | 'tv' | null;
  episodesPlayed?: number | null;
  episodesTotal?: number | null;
}

/** What Step 1's row checkbox (if any) should be named — ties the row's CURRENT plan outcome to the query param `parseSelectedItemsFromSearchParams` below reads back on submit, so a plain HTML form (no JS) can carry the right `requestedMode` forward without the client ever choosing it itself (FR-DEL-2: the member never picks delete vs release, the backend does). */
export function selectionFieldName(outcome: DeletionPlanItem['outcome']): 'd' | 'r' | null {
  if (outcome === 'delete') return 'd';
  if (outcome === 'release') return 'r';
  return null; // blocked / unauthorized / already_gone / invalid_mode — not selectable at all.
}

/** Short label for the action a row would get — never the same word for delete vs release (the wiki's "must never read as the same action" rule, restated for copy). */
export function actionLabel(outcome: DeletionPlanItem['outcome']): string {
  switch (outcome) {
    case 'delete':
      return 'Delete';
    case 'release':
      return 'Release claim';
    case 'already_gone':
      return 'Already gone';
    case 'blocked':
      return 'Blocked';
    case 'unauthorized':
      return 'Not yours';
    case 'invalid_mode':
      return 'Refused';
  }
}

/** Same ordering rule as `./logic.ts`'s `sortMemberTitles` (largest first, full stop — no watched/unwatched grouping, see that file's comment), applied to `DeleteSelectRow`'s slightly different shape (optional `chargedBytes`, since a `found: false` row carries none). Blocked/already-gone/unauthorized rows still sort after everything actionable — that grouping is about what a member can actually act on, not about size, so it stays — largest-first within that group too. */
export function sortSelectRows(rows: readonly DeleteSelectRow[]): DeleteSelectRow[] {
  return [...rows].sort((a, b) => {
    const aActionable = a.outcome === 'delete' || a.outcome === 'release';
    const bActionable = b.outcome === 'delete' || b.outcome === 'release';
    if (aActionable !== bActionable) return aActionable ? -1 : 1;
    return (b.chargedBytes ?? 0) - (a.chargedBytes ?? 0);
  });
}

export interface SelectionSummary {
  selectedCount: number;
  /** Reduction in THIS member's own usage (their `chargedBytes`) — the number the quota-projection math actually needs. Equal to real disk bytes freed for a sole-claimant delete (D-3: charged == full size), but NOT for a release (0 real bytes freed, only the member's own charge ends). */
  freedBytes: number;
  projected: QuotaDisplay;
}

/**
 * Step 1's running total. Only rows whose CURRENT plan outcome is `delete`
 * or `release` can ever be selected in the first place (see
 * `selectionFieldName`), so a selected id with any other outcome is ignored
 * defensively rather than trusted — the same "ask the backend, never assume"
 * discipline as everywhere else in this flow.
 */
export function computeSelectionSummary(rows: readonly DeletionPlanItem[], selectedIds: ReadonlySet<string>, usedBytes: number, quota: EffectiveQuota): SelectionSummary {
  let freedBytes = 0;
  let selectedCount = 0;
  for (const row of rows) {
    if (!row.found || !selectedIds.has(row.titleId)) continue;
    if (row.outcome !== 'delete' && row.outcome !== 'release') continue;
    selectedCount += 1;
    freedBytes += row.chargedBytes ?? 0;
  }
  const projectedUsedBytes = Math.max(0, usedBytes - freedBytes);
  return { selectedCount, freedBytes, projected: deriveQuotaDisplay(quota, projectedUsedBytes) };
}

// ---------------------------------------------------------------------------
// Carrying selection from Step 1 -> Step 2 -> Step 3 via plain query params
// (`?d=id1&d=id2&r=id3`) — works with a zero-JS `<form method="GET">` submit,
// and preserves exactly which action (`d`elete vs `r`elease) was SHOWN to the
// member at the point they checked the box, so a later re-plan can only ever
// downgrade/block that intent, never silently upgrade a shown "release" into
// an actual file delete (see this file's header + the wiki's "must never
// read as the same action" rule — this is the concrete mechanism).
// ---------------------------------------------------------------------------

type SearchParamsLike = Record<string, string | string[] | undefined>;

function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function parseSelectedItemsFromSearchParams(searchParams: SearchParamsLike): DeletionRequestItem[] {
  const items: DeletionRequestItem[] = [];
  const seen = new Set<string>();
  for (const titleId of toArray(searchParams.d)) {
    if (!titleId || seen.has(titleId)) continue;
    seen.add(titleId);
    items.push({ titleId, requestedMode: 'delete_files' });
  }
  for (const titleId of toArray(searchParams.r)) {
    if (!titleId || seen.has(titleId)) continue;
    seen.add(titleId);
    items.push({ titleId, requestedMode: 'release_claim' });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Step 2 — Review: two clearly separated "will happen" sections plus a third
// for anything that can't proceed at all, so the two real outcomes are never
// visually conflated (wiki FR-DEL-6 / "Delete and Release must never read as
// the same action").
// ---------------------------------------------------------------------------

export interface ReviewSections<T extends DeletionPlanItem = DeletionPlanItem> {
  toDelete: T[];
  toRelease: T[];
  cannotProceed: T[];
}

/** Generic over `T` (rather than fixed to the bare `DeletionPlanItem`) so a caller can merge extra display-only fields (e.g. `mediaType`, for `seriesWholeShowWarning`) onto each item BEFORE splitting and keep them through to the section arrays, without this function needing to know about them. */
export function splitReviewItems<T extends DeletionPlanItem>(items: readonly T[]): ReviewSections<T> {
  const toDelete: T[] = [];
  const toRelease: T[] = [];
  const cannotProceed: T[] = [];
  for (const item of items) {
    if (item.outcome === 'delete') toDelete.push(item);
    else if (item.outcome === 'release') toRelease.push(item);
    else cannotProceed.push(item);
  }
  return { toDelete, toRelease, cannotProceed };
}

/**
 * Human, never-names-anyone reason text for a row that can't proceed
 * (`cannotProceed` above) or for the per-title guard warning shown on an
 * item that CAN proceed but was watched by someone else. `item.guardMessages`
 * is already audience-filtered to the member-safe variant by `plan.ts`/
 * `execute.ts` themselves (`FR-DEL-4a`) — this function only joins/labels
 * what the backend already decided was safe to show, never adds anything.
 */
export function describeUnavailableReason(item: DeletionPlanItem): string {
  switch (item.outcome) {
    case 'unauthorized':
      return "You don't have an active claim on this title.";
    case 'invalid_mode':
      return 'This request could not be understood and was refused.';
    case 'already_gone':
      return 'Already gone from disk — nothing left to remove.';
    case 'blocked':
      switch (item.blockedReason) {
        case 'protected':
          return item.protectedReason ? `Protected by the operator: ${item.protectedReason}` : 'Protected by the operator.';
        case 'includes_uncharged_files':
          return "This includes files that were here before your request, so it isn't yours to delete — ask the operator.";
        case 'sole_claimant_cannot_release':
          return "You're the only claimant on this title — releasing would leave these bytes unowned, so deletion is the only option.";
        case 'no_claim_to_release':
          return 'There is no claim on this title to release.';
        case 'guard':
          return (item.guardMessages ?? []).filter(Boolean).join(' ') || 'Someone else is watching this title.';
        default:
          return 'Blocked.';
      }
    default:
      return '';
  }
}

/** The per-title "someone else has played this" warning for a row that IS proceeding (delete or release) — `FR-DEL-6`'s "prominent per-title warning where anyone else has ever played it," distinct from the `blocked`-reason text above (a title can be watched by someone outside the recent-play guard window and still proceed, with only a warning). */
export function watchedWarning(row: {
  watchedByAnyone?: boolean;
  otherActiveClaimants?: number;
  mediaType?: 'movie' | 'tv' | null;
  episodesPlayed?: number | null;
  episodesTotal?: number | null;
}): string | null {
  // Says how MUCH, not just whether. On the screen where somebody is about to
  // delete a 20-title batch, "someone has watched this" reads identically for
  // a finished movie and a 89-episode series sampled once — and those deserve
  // opposite decisions.
  return watchStateSentence(
    deriveWatchState({
      watchedByAnyone: !!row.watchedByAnyone,
      mediaType: row.mediaType,
      episodesPlayed: row.episodesPlayed,
      episodesTotal: row.episodesTotal,
    }),
  );
}

/** `FR-DEL-6`/wiki "Interactions" — a whole-series TV delete removes every season, never just one; per-season deletion isn't supported (`P4-1`). Shown on any TV row proceeding as a delete or release so nobody mistakes "delete this show" for "drop the season I'm not watching." */
export function seriesWholeShowWarning(mediaType: 'movie' | 'tv' | undefined): string | null {
  return mediaType === 'tv' ? 'This removes the entire series — every season, not just one. Per-season deletion is not supported.' : null;
}

// ---------------------------------------------------------------------------
// Step 3 — Confirm: the three required elements (FR-DEL-5's typed field +
// checkbox + the one destructive button), and the exact N/X the checkbox
// copy must state.
// ---------------------------------------------------------------------------

export const CONFIRM_TYPED_TEXT = 'delete';

export interface ConfirmRequirement {
  /** How many titles will actually have FILES removed (never counts a release). */
  deleteCount: number;
  /** Total bytes of those files. */
  deleteBytes: number;
}

/** Takes the confirm screen's own item shape (`mode`, not a full `DeletionPlanItem.outcome`) — the confirm screen only ever holds items already filtered down to `delete`/`release`, so this accepts exactly that, not the wider plan-item type. */
export function computeConfirmRequirement(items: readonly { mode: 'delete' | 'release'; sizeBytes: number }[]): ConfirmRequirement {
  let deleteCount = 0;
  let deleteBytes = 0;
  for (const item of items) {
    if (item.mode !== 'delete') continue;
    deleteCount += 1;
    deleteBytes += item.sizeBytes;
  }
  return { deleteCount, deleteBytes };
}

export function confirmAcknowledgementLabel(req: ConfirmRequirement): string {
  return `I understand this schedules the permanent removal of ${req.deleteCount} file${req.deleteCount === 1 ? '' : 's'} totalling ${formatGB(req.deleteBytes)}, and that it will run unless I cancel it first.`;
}

/** `FR-DEL-5` step 3, requirement 1+2: exact (case-sensitive) `delete` typed, AND the checkbox ticked, AND at least one item is actually actionable. All three, not fewer. */
export function isConfirmReady(typedText: string, acknowledged: boolean, actionableItemCount: number): boolean {
  return actionableItemCount > 0 && typedText === CONFIRM_TYPED_TEXT && acknowledged;
}

/** What Step 3's client form POSTs to `/api/deletion/execute` — the mode is whatever the item's review-time outcome already was (`d`elete/`r`elease from the URL, re-confirmed by the confirm screen's own fresh plan call), never re-derived client-side. */
export function buildExecuteRequestItems(items: readonly { titleId: string; requestedMode: DeletionMode }[]): DeletionRequestItem[] {
  return items.map((i) => ({ titleId: i.titleId, requestedMode: i.requestedMode }));
}

// ---------------------------------------------------------------------------
// The execute-time result report (`FR-DEL-8`: "Batch deletions MUST report
// per-title outcomes. A partial failure MUST NOT be reported as success.").
// ---------------------------------------------------------------------------

/** Short, unambiguous per-outcome label — deliberately never reuses "Delete"/"Release claim" wording from `actionLabel` above for a DIFFERENT outcome, so a result report can never be misread as the request that was made. */
export function executeOutcomeLabel(outcome: DeletionItemOutcome): string {
  switch (outcome) {
    case 'deleted':
      return 'Deleted';
    case 'released':
      return 'Released';
    case 'already_gone':
      return 'Already gone';
    case 'blocked':
      return 'Blocked';
    case 'unauthorized':
      return 'Not yours';
    case 'invalid_mode':
      return 'Refused';
    case 'failed':
      return 'Failed';
    case 'rate_limited':
      return 'Rate limited';
    case 'cancelled':
      // Sweeper-mode only (`FR-DEL-25`) — a member never sees this from their
      // own confirm POST, but the union is shared so the switch stays total.
      return 'Cancelled';
  }
}

/** Extra detail line for one result item — the warning/error/downgrade/blocked-reason text a result report shows under the outcome badge. Never invents anything not already on `DeletionItemResult` (`execute.ts`'s own audience-appropriate `guardMessages`, `warning`, `error`). */
export function describeExecuteItemDetail(item: DeletionItemResult): string | null {
  if (item.warning) return item.warning;
  if (item.error) return item.error;
  if (item.outcome === 'blocked') {
    const guard = (item.guardMessages ?? []).filter(Boolean).join(' ');
    if (guard) return guard;
    if (item.blockedReason === 'protected') return 'Protected by the operator.';
    if (item.blockedReason === 'includes_uncharged_files') return "Includes files from before your request — ask the operator.";
    if (item.blockedReason === 'sole_claimant_cannot_release') return "You're the only claimant — can't release without deleting.";
    if (item.blockedReason === 'no_claim_to_release') return 'No claim on this title to release.';
    return null;
  }
  if (item.outcome === 'released' && item.downgradedFromDelete) {
    return 'Downgraded from delete: you were no longer the sole claimant by the time this ran.';
  }
  if (item.outcome === 'rate_limited') return 'You have hit the hourly deletion limit — try again later.';
  if (item.outcome === 'unauthorized') return "You don't have an active claim on this title.";
  if (item.outcome === 'invalid_mode') return 'This request could not be understood and was refused.';
  return null;
}

/**
 * Whether a batch's summary can honestly be called a full success — every
 * item either did what was asked or was a benign no-op (`already_gone`).
 * Anything else (a failure, a block, an IDOR-style unauthorized, an
 * unrecognised mode, a rate limit) makes this `false`, per `FR-DEL-8`: "A
 * partial failure MUST NOT be reported as success."
 *
 * `cancelled` is deliberately absent: it exists only in sweeper mode
 * (`FR-DEL-25`), never in a member's own confirm response, and a scheduled
 * deletion someone chose to call off is not a failure of the run that found
 * it already gone.
 */
export function isBatchFullySuccessful(summary: DeletionBatchSummary): boolean {
  return summary.failed === 0 && summary.blocked === 0 && summary.unauthorized === 0 && summary.invalidMode === 0 && summary.rateLimited === 0;
}

// ---------------------------------------------------------------------------
// The documented filesystem-snapshot recovery window (see wiki/Architecture.md)
// — used verbatim per that doc's "User-facing copy" section and
// Feature-06's "exact copy to use." Kept as one exported constant so the
// confirm screen's fine print and any test asserting on the exact wording
// (a spec-conformance test, not just a smoke check) read from one place.
// ---------------------------------------------------------------------------

export const RECOVERY_FINE_PRINT =
  'Deletions are not immediate. What you confirm here is scheduled, and until it runs you can cancel it yourself from your usage page. Once it has run there is no in-app undo: deleted files are recovered from automatic ZFS snapshots, not from this app. If you act fast (within about an hour), recovery is close to certain. Snapshots also exist further back — hourly for the last day, daily for the last month, and less often for up to a year — so it’s still worth asking even if it’s been a while. Message the operator as soon as you notice a mistake; the sooner you ask, the more certain the recovery.';

export const RECOVERY_GAP_NOTE =
  'One real gap: a file imported and then deleted within the same ~15-minute window, before the next automatic snapshot runs, has no snapshot coverage at all and cannot be recovered.';


// ---------------------------------------------------------------------------
// The scheduled-deletion surface (`FR-DEL-22` … `FR-DEL-28`).
// ---------------------------------------------------------------------------

/**
 * A plain-language grace window. Deliberately coarse — "about 24 hours" is
 * what a member needs to know; the exact second is on the row itself as a
 * timestamp.
 */
export function formatGraceWindow(seconds: number): string {
  if (seconds <= 0) return 'immediately';
  if (seconds < 3600) return `about ${Math.max(1, Math.round(seconds / 60))} minutes`;
  const hours = seconds / 3600;
  if (hours < 48) return `about ${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'}`;
  return `about ${Math.round(hours / 24)} days`;
}

/** How long is left before a pending deletion runs, as a member-facing phrase. */
export function formatTimeRemaining(scheduledForEpochSeconds: number, nowEpochSeconds: number): string {
  const remaining = scheduledForEpochSeconds - nowEpochSeconds;
  if (remaining <= 0) return 'due now — runs at the next sweep';
  if (remaining < 3600) return `${Math.max(1, Math.round(remaining / 60))} min left`;
  if (remaining < 86_400) return `${Math.round(remaining / 3600)} h left`;
  return `${Math.round(remaining / 86_400)} d left`;
}

/** Per-outcome label for the CONFIRM response, which now reports scheduling rather than deletion. */
export function scheduleOutcomeLabel(outcome: ScheduleItemOutcome): string {
  switch (outcome) {
    case 'scheduled':
      return 'Scheduled';
    case 'released':
      return 'Released';
    case 'already_gone':
      return 'Already gone';
    case 'blocked':
      return 'Blocked';
    case 'unauthorized':
      return 'Not yours';
    case 'invalid_mode':
      return 'Refused';
    case 'rate_limited':
      return 'Rate limited';
    case 'failed':
      return 'Failed';
  }
}

/**
 * `FR-DEL-8` for the schedule response: anything that is not "we did what you
 * asked" makes the batch a partial success, and must not be reported as a
 * clean one. `scheduled`, `released` and `already_gone` are the three good
 * outcomes.
 */
export function isScheduleBatchFullySuccessful(summary: ScheduleBatchSummary): boolean {
  return summary.failed === 0 && summary.blocked === 0 && summary.unauthorized === 0 && summary.invalidMode === 0 && summary.rateLimited === 0;
}

/** Extra detail under a schedule-result row — same "never invent anything" rule as `describeExecuteItemDetail`. */
export function describeScheduleItemDetail(item: ScheduleItemResult): string | null {
  if (item.error) return item.error;
  if (item.outcome === 'blocked') {
    const guard = (item.guardMessages ?? []).filter(Boolean).join(' ');
    if (guard) return guard;
    if (item.blockedReason === 'protected') return 'Protected by the operator.';
    if (item.blockedReason === 'includes_uncharged_files') return "Includes files from before your request — ask the operator.";
    if (item.blockedReason === 'sole_claimant_cannot_release') return "You're the only claimant — can't release without deleting.";
    if (item.blockedReason === 'no_claim_to_release') return 'No claim on this title to release.';
    return null;
  }
  if (item.outcome === 'released' && item.downgradedFromDelete) {
    return 'Someone else has since requested this too, so your claim was released instead of the files being deleted.';
  }
  if (item.outcome === 'rate_limited') return 'You have scheduled a lot of deletions in the last hour — try this one again later.';
  return null;
}

/** The member-facing explanation of a refused cancel (`FR-DEL-28`). */
export function describeCancelRefusal(overageBytes: number): string {
  return `Cancelling this would put you back over your quota by ${formatGB(overageBytes)}. You have already used the space this deletion freed up. Delete something else first, or ask the operator to undo it for you.`;
}
