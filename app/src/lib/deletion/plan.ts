/**
 * Read-only preview for the D-7 select/review screens (steps 1-2 of the
 * three-step flow). Writes NO audit rows — nothing has happened yet, and
 * FR-DEL-1/14's real security boundary is `execute.ts`'s fresh re-validation
 * at confirm time, not this preview. This function exists so a future UI
 * never has to re-implement `authorize.ts`'s decision logic to render "what
 * would happen" — it calls the exact same pure core `execute.ts` calls, over
 * the same kind of freshly-read state.
 *
 * Two defensive properties worth calling out, since this is still a
 * member-reachable read path over other people's data:
 *
 *   - An item the actor has no standing on (`found: false`) carries NO title
 *     metadata at all (no name/size/path) — this function must not become a
 *     way to probe which ids are real titles a member doesn't own.
 *   - Guard messages/detail are audience-filtered HERE (`FR-DEL-4a`), not
 *     left to a future route/UI to filter correctly: a member actor only
 *     ever gets `memberMessage`/`memberDetail`; an operator actor gets the
 *     operator variants (which may name who else has watched it).
 */
import { getConfig } from '@/lib/config';
import { getDb, type SeerrQuotaDb } from '@/lib/db';
import { buildGuardContext, DELETION_GUARDS, isPlaybackUnavailable, runDeletionGuards, type GuardEvaluation } from './guards';
import { deriveTitleAction, type TitleActionDecision } from './authorize';
import { loadFreshTitleClaimStates, type FreshTitleClaimState } from './deletionStore';
import type { DeletionActor, DeletionMode, DeletionRequestItem } from './types';

export type DeletionPlanOutcome = 'delete' | 'release' | 'blocked' | 'unauthorized' | 'already_gone' | 'invalid_mode';

export interface DeletionPlanItem {
  titleId: string;
  /** False for an unknown id, or a real title the subject has no active claim on — no fields below are populated in that case (see this file's header comment). */
  found: boolean;
  outcome: DeletionPlanOutcome;
  name?: string;
  year?: number | null;
  path?: string;
  sizeBytes?: number;
  chargedBytes?: number;
  /** Other members' active claims on this title, i.e. `activeClaimantCount - (has own claim ? 1 : 0)`. */
  otherActiveClaimants?: number;
  downgradedFromDelete?: boolean;
  blockedReason?: 'protected' | 'includes_uncharged_files' | 'sole_claimant_cannot_release' | 'no_claim_to_release' | 'guard';
  protectedReason?: string | null;
  /** Audience-appropriate guard messages (member OR operator, never both) — empty unless `blockedReason === 'guard'`. */
  guardMessages?: string[];
  guardDetail?: Record<string, unknown>[];
}

export interface PlanDeletionOptions {
  /** Operator-only: preview on behalf of a specific member's claims. Ignored for a non-operator actor. */
  onBehalfOf?: string;
  /** Operator-only: preview as if every currently-fired guard were overridden. Ignored for a non-operator actor. */
  overrideGuards?: boolean;
  nowSeconds?: number;
}

function resolveSubject(actor: DeletionActor, onBehalfOf: string | undefined): string {
  return actor.isOperator && onBehalfOf ? onBehalfOf : actor.username;
}

function evaluateGuards(
  db: SeerrQuotaDb,
  state: FreshTitleClaimState,
  nowSeconds: number,
  deleteRecentPlayDays: number,
  deleteInProgressDays: number,
  playbackUnavailable: boolean,
  subjectUsername: string,
): GuardEvaluation[] {
  const ctx = buildGuardContext(db, {
    titleId: state.titleId,
    mediaType: state.mediaType,
    watchedByAnyone: state.watchedByAnyone,
    lastPlayedAnyAt: state.lastPlayedAnyAt,
    nowSeconds,
    deleteRecentPlayDays,
    deleteInProgressDays,
    playbackUnavailable,
    subjectUsername,
  });
  return runDeletionGuards(DELETION_GUARDS, ctx);
}

function toPlanItem(item: DeletionRequestItem, state: FreshTitleClaimState, decision: TitleActionDecision, isOperator: boolean): DeletionPlanItem {
  const base = {
    titleId: item.titleId,
    found: true as const,
    name: state.name,
    year: state.year,
    path: state.path,
    sizeBytes: state.sizeBytes,
    chargedBytes: state.chargedBytes,
    otherActiveClaimants: Math.max(0, state.activeClaimantCount - (state.hasActiveClaim ? 1 : 0)),
  };

  switch (decision.kind) {
    case 'execute':
      return {
        ...base,
        outcome: decision.mode === 'delete_files' ? 'delete' : 'release',
        downgradedFromDelete: decision.downgradedFromDelete,
      };
    case 'already_gone':
      return { ...base, outcome: 'already_gone' };
    case 'unauthorized':
      // A found title the subject just doesn't claim — same "never leak
      // titles the actor doesn't own" rule as an unknown id (FR-DEL-14).
      return { titleId: item.titleId, found: false, outcome: 'unauthorized' };
    case 'invalid_mode':
      // FR-DEL-15 — a malformed/unrecognised requestedMode never gets a
      // decision about claim state at all, so this must not leak whether
      // the subject holds a claim either; same "found: false" shape as
      // unauthorized.
      return { titleId: item.titleId, found: false, outcome: 'invalid_mode' };
    case 'blocked': {
      const guards = decision.reason === 'guard' ? decision.guards : [];
      return {
        ...base,
        outcome: 'blocked',
        blockedReason: decision.reason,
        protectedReason: decision.reason === 'protected' ? decision.protectedReason : undefined,
        guardMessages: isOperator ? guards.map((g) => g.operatorMessage ?? '') : guards.map((g) => g.memberMessage ?? ''),
        guardDetail: isOperator ? guards.map((g) => g.operatorDetail ?? {}) : guards.map((g) => g.memberDetail ?? {}),
      };
    }
  }
}

export function planDeletionItems(actor: DeletionActor, items: DeletionRequestItem[], opts: PlanDeletionOptions = {}): DeletionPlanItem[] {
  const db = getDb();
  const config = getConfig();
  const nowSeconds = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const onBehalfOf = actor.isOperator ? opts.onBehalfOf : undefined;
  const overrideGuards = actor.isOperator ? !!opts.overrideGuards : false;
  const subject = resolveSubject(actor, onBehalfOf);

  const uniqueIds = [...new Set(items.map((i) => i.titleId))];
  const states = loadFreshTitleClaimStates(db, subject, uniqueIds);

  // FR-DEL-21: one batch-level check (not one per title) — see
  // `guards.ts`'s `isPlaybackUnavailable` doc comment.
  const playbackUnavailable = isPlaybackUnavailable(db, nowSeconds, config.runtime.staleSnapshotMaxAgeS);

  return items.map((item) => {
    const state = states.get(item.titleId)!;
    if (!state.exists) {
      return { titleId: item.titleId, found: false, outcome: 'unauthorized' };
    }

    const guardEvaluations = evaluateGuards(db, state, nowSeconds, config.runtime.deleteRecentPlayDays, config.runtime.deleteInProgressDays, playbackUnavailable, subject);
    const decision = deriveTitleAction({
      requestedMode: item.requestedMode,
      isOperator: actor.isOperator,
      hasActiveClaim: state.hasActiveClaim,
      activeClaimantCount: state.activeClaimantCount,
      protectedTitle: state.protectedTitle,
      protectedReason: state.protectedReason,
      sizeBytes: state.sizeBytes,
      chargedBytes: state.chargedBytes,
      guardEvaluations,
      operatorOverrideGuards: overrideGuards,
    });

    return toPlanItem(item, state, decision, actor.isOperator);
  });
}

// Re-exported for callers that want the raw mode type without a second import.
export type { DeletionMode };
