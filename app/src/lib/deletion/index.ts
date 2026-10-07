/**
 * Public surface of the self-service deletion module (P2-4,
 * `wiki/Feature-06-Self-Service-Deletion.md`). Callers elsewhere in the app
 * (future API routes, once built — see `types.ts`'s header comment) should
 * import from `@/lib/deletion`, not reach into individual files here.
 */
export type { DeletionActor, DeletionMode, DeletionRequestItem } from './types';

export type { BuildGuardContextInput, DeletionGuard, DeletionGuardId, GuardContext, GuardEvaluation, InProgressSignal } from './guards';
export {
  buildGuardContext,
  DELETION_GUARDS,
  firedGuards,
  inProgressGuard,
  isPlaybackSnapshotStale,
  isPlaybackUnavailable,
  loadInProgressSignals,
  loadRecentPlayers,
  recentlyPlayedGuard,
  runDeletionGuards,
} from './guards';

export type { TitleActionDecision, TitleActionInput, TitleBlockedReason } from './authorize';
export { deriveTitleAction } from './authorize';

export { isOverDeleteRateLimit } from './rateLimit';

export type { FreshTitleClaimState } from './deletionStore';
export { countRecentFileDeletions, loadFreshTitleClaimStates, reserveFileDeletionSlot } from './deletionStore';

export type { DeletionPlanItem, DeletionPlanOutcome, PlanDeletionOptions } from './plan';
export { planDeletionItems } from './plan';

export type { DeletionBatchSummary, DeletionItemOutcome, DeletionItemResult, ExecuteDeletionBatchOptions, ExecuteDeletionDeps, ExecuteDeletionBatchResult } from './execute';
export { executeDeletionBatch } from './execute';

export type { ScheduleBatchSummary, ScheduleDeletionBatchOptions, ScheduleDeletionBatchResult, ScheduleItemOutcome, ScheduleItemResult } from './schedule';
export { scheduleDeletionBatch } from './schedule';

export type { CancelDeletionOptions, CancelOutcome, CancelResult } from './cancel';
export { cancelScheduledDeletion } from './cancel';

export type { ScheduledDeletionRow } from './deletionStore';
export {
  findScheduledDeletion,
  getPendingDeletionBytes,
  loadAllScheduledDeletions,
  loadDueScheduledDeletions,
  loadScheduledDeletionsForMember,
} from './deletionStore';

export type { RunDueDeletionsOptions, SweepResult } from './runner';
export { MAX_DELETIONS_PER_SWEEP, runDueDeletions, runSweepTick, startDeletionSweeper } from './runner';
