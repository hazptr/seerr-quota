/**
 * Public surface of the enforcement module (P2-6,
 * `wiki/Feature-05-Enforcement.md`). Callers elsewhere in the app —
 * `app/src/app/api/seerr/webhook/route.ts` today; a future admin
 * manual-override route and the not-yet-built P2-9 notifier — should import
 * from `@/lib/enforcement`, not reach into individual files here.
 */
export type { Decision, DecisionInput, EnforcementDecision, EnforcementReason, EnforcementSource, MemberSyncStatus } from './types';
export { decide } from './decide';

export type { EnforcementMember } from './member';
export { findMemberBySeerrUserId, loadQuotaBytes } from './member';

export { findLatestAttributionSnapshot, getEffectiveUsageBytes, getMemberUsageBytes } from './usage';

export type { RequestDecisionRow } from './requestDecisionStore';
export { getRequestDecision, upsertRequestDecision } from './requestDecisionStore';

export type { SeerrRequestSummary } from './seerrActions';
export { createEnforcementSeerrActions, EnforcementSeerrActions } from './seerrActions';

export type {
  ApprovedNotification,
  DeclinedNotification,
  EnforcementNotifier,
  EnforcementNotifierDeps,
  HoldNotification,
  NotifyResult,
} from './notify';
export { createEnforcementNotifier, noopNotifier } from './notify';

export type { ProcessDeps, ProcessOutcome } from './process';
export { processPendingRequest } from './process';

export type { PendingSweepDeps, PendingSweepResult } from './poller';
export { runPendingSweep } from './poller';
