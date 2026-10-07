/**
 * Step 3 of the `D-7` flow, as it now behaves: confirming a deletion
 * **schedules** it rather than performing it (`FR-DEL-22`). This module is
 * what the member-facing confirm route calls; nothing here can destroy a
 * file. The destructive path still lives in exactly one place —
 * `./execute.ts` — and is reached only later, by the sweeper
 * (`./runner.ts`), once `scheduled_for` has passed.
 *
 * ## Why this is a separate module rather than a flag on `executeDeletionBatch`
 *
 * `execute.ts`'s header documents it as "the actual destructive path;
 * everything else in this directory supports it", and its every branch is
 * written to be read under that assumption. Threading a `dryRun`-style flag
 * through it would put "this call deletes" and "this call definitely does
 * not" one boolean apart in the same function — the single most dangerous
 * shape this module could take, for exactly the reason `types.ts` gives
 * about `isDeletionMode`. They stay separate functions so that "did this
 * code path issue a `DELETE`?" remains answerable by looking at which
 * function you are in.
 *
 * ## What is NOT duplicated
 *
 * The decision itself. This module re-reads fresh state
 * (`loadFreshTitleClaimStates`), re-evaluates the guards, and calls the same
 * pure `deriveTitleAction` core that `plan.ts` and `execute.ts` call —
 * AGENTS.md rule 9's "the same decision function so they cannot disagree",
 * the same way `plan.ts` already does it. Scheduling a deletion is therefore
 * subject to every rule that governed deleting one: the IDOR guard
 * (`FR-DEL-1`/`FR-DEL-14`), protection, the watch guards, sole-claimant
 * authority (`FR-DEL-2`), and the fail-closed mode check (`FR-DEL-15`).
 * The guards are then re-evaluated a SECOND time at execution
 * (`FR-DEL-26`), because a title nobody was watching yesterday may be one
 * somebody started tonight.
 *
 * ## What still happens immediately
 *
 * `release_claim` (`FR-DEL-23`). Releasing a claim removes nothing from
 * disk, changes only this app's own accounting, and is re-claimable by the
 * next reconcile — there is nothing to undo and so nothing to schedule.
 * Those items are handed straight to `executeDeletionBatch`, which is safe
 * precisely because `deriveTitleAction` has already refused to turn a
 * release into a delete.
 */
import type { ActorRole, Source } from '@/lib/audit';
import { newCorrelationId, writeAuditRow } from '@/lib/audit';
import { getConfig } from '@/lib/config';
import { getDb, type SeerrQuotaDb } from '@/lib/db';
import { deriveTitleAction } from './authorize';
import { insertDeletionRow, loadFreshTitleClaimStates, reserveFileDeletionSlot } from './deletionStore';
import { executeDeletionBatch, type ExecuteDeletionDeps } from './execute';
import { buildGuardContext, DELETION_GUARDS, isPlaybackUnavailable, runDeletionGuards } from './guards';
import type { DeletionActor, DeletionMode, DeletionRequestItem } from './types';

export type ScheduleItemOutcome =
  /** A file deletion is now pending; `scheduledFor` says when it runs. */
  | 'scheduled'
  /** A claim release, done and dusted — nothing was pending, nothing was destroyed. */
  | 'released'
  | 'blocked'
  | 'unauthorized'
  | 'invalid_mode'
  | 'already_gone'
  | 'rate_limited'
  | 'failed';

export interface ScheduleItemResult {
  titleId: string;
  requestedMode: DeletionMode;
  outcome: ScheduleItemOutcome;
  /** Unix seconds the sweeper may execute this — set only for `scheduled`. */
  scheduledFor?: number;
  /** The `deletion` row id, so the UI can offer a Cancel button without a re-query. */
  deletionId?: number;
  /** Their charge at schedule time — the bytes credited back immediately (`FR-DEL-27`). */
  bytesClaimed?: number;
  downgradedFromDelete?: boolean;
  blockedReason?: string;
  guardMessages?: string[];
  error?: string;
}

export interface ScheduleBatchSummary {
  total: number;
  scheduled: number;
  released: number;
  blocked: number;
  unauthorized: number;
  invalidMode: number;
  alreadyGone: number;
  rateLimited: number;
  failed: number;
}

export interface ScheduleDeletionBatchResult {
  correlationId: string;
  items: ScheduleItemResult[];
  summary: ScheduleBatchSummary;
  /** Echoed back so the UI can say "you can undo this until X" without re-reading config. */
  gracePeriodSeconds: number;
}

export interface ScheduleDeletionBatchOptions {
  onBehalfOf?: string;
  overrideGuards?: boolean;
  source?: Source;
  nowSeconds?: number;
}

const RATE_LIMIT_WINDOW_SECONDS = 3600;

function emptySummary(): ScheduleBatchSummary {
  return { total: 0, scheduled: 0, released: 0, blocked: 0, unauthorized: 0, invalidMode: 0, alreadyGone: 0, rateLimited: 0, failed: 0 };
}

function summarize(results: ScheduleItemResult[]): ScheduleBatchSummary {
  const summary = emptySummary();
  summary.total = results.length;
  for (const r of results) {
    switch (r.outcome) {
      case 'scheduled': summary.scheduled++; break;
      case 'released': summary.released++; break;
      case 'blocked': summary.blocked++; break;
      case 'unauthorized': summary.unauthorized++; break;
      case 'invalid_mode': summary.invalidMode++; break;
      case 'already_gone': summary.alreadyGone++; break;
      case 'rate_limited': summary.rateLimited++; break;
      case 'failed': summary.failed++; break;
    }
  }
  return summary;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function scheduleDeletionBatch(
  actor: DeletionActor,
  items: DeletionRequestItem[],
  deps: ExecuteDeletionDeps = {},
  opts: ScheduleDeletionBatchOptions = {},
): Promise<ScheduleDeletionBatchResult> {
  const db: SeerrQuotaDb = deps.db ?? getDb();
  const config = getConfig();
  const nowSeconds = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const source: Source = opts.source ?? 'ui';
  const actorRole: ActorRole = actor.isOperator ? 'operator' : 'member';

  // Same defense in depth as `execute.ts`: these are operator-only levers and
  // are never honoured for a member actor, whatever a caller passed.
  const onBehalfOf = actor.isOperator ? opts.onBehalfOf : undefined;
  const overrideGuards = actor.isOperator ? !!opts.overrideGuards : false;
  const subject = onBehalfOf ?? actor.username;

  const correlationId = newCorrelationId();
  const gracePeriodSeconds = Math.floor(config.scheduling.deleteGracePeriodMs / 1000);

  // FR-DEL-8: de-dupe by titleId, first occurrence wins — a duplicate id must
  // not reserve two rate-limit slots or create two pending rows for one title.
  const seen = new Set<string>();
  const deduped: DeletionRequestItem[] = [];
  for (const item of items) {
    if (seen.has(item.titleId)) continue;
    seen.add(item.titleId);
    deduped.push(item);
  }

  const states = loadFreshTitleClaimStates(db, subject, deduped.map((i) => i.titleId));
  const playbackUnavailable = isPlaybackUnavailable(db, nowSeconds, config.runtime.staleSnapshotMaxAgeS);

  const results: ScheduleItemResult[] = [];
  /** Items that must be handed to the immediate path instead (`FR-DEL-23`). */
  const immediate: DeletionRequestItem[] = [];

  for (const item of deduped) {
    // FR-DEL-18, same contract as `execute.ts`'s loop: no exception from any
    // per-item work may abort the batch and silently drop later items.
    try {
      const state = states.get(item.titleId)!;

      if (!state.exists) {
        writeAuditRow(db, {
          actor: actor.username, actorRole, onBehalfOf,
          action: 'access.denied', targetType: 'title', targetId: item.titleId,
          outcome: 'denied', source, correlationId,
          detail: { requestedMode: item.requestedMode, reason: 'unknown_title', subject, stage: 'schedule' },
        });
        results.push({ titleId: item.titleId, requestedMode: item.requestedMode, outcome: 'unauthorized' });
        continue;
      }

      const guardEvaluations = runDeletionGuards(
        DELETION_GUARDS,
        buildGuardContext(db, {
          titleId: item.titleId,
          mediaType: state.mediaType,
          watchedByAnyone: state.watchedByAnyone,
          lastPlayedAnyAt: state.lastPlayedAnyAt,
          nowSeconds,
          deleteRecentPlayDays: config.runtime.deleteRecentPlayDays,
          deleteInProgressDays: config.runtime.deleteInProgressDays,
          playbackUnavailable,
          subjectUsername: subject,
        }),
      );

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

      if (decision.kind === 'invalid_mode' || decision.kind === 'unauthorized') {
        const reason = decision.kind === 'invalid_mode' ? 'invalid_mode' : 'not_claimant';
        writeAuditRow(db, {
          actor: actor.username, actorRole, onBehalfOf,
          action: 'access.denied', targetType: 'title', targetId: item.titleId,
          outcome: 'denied', source, correlationId,
          detail: { requestedMode: item.requestedMode, reason, subject, stage: 'schedule' },
        });
        results.push({ titleId: item.titleId, requestedMode: item.requestedMode, outcome: decision.kind === 'invalid_mode' ? 'invalid_mode' : 'unauthorized' });
        continue;
      }

      if (decision.kind === 'blocked') {
        const isDeleteFlavored = decision.reason === 'protected' || decision.reason === 'includes_uncharged_files' || decision.reason === 'guard';
        const mode: DeletionMode = isDeleteFlavored ? 'delete_files' : 'release_claim';
        const guards = decision.reason === 'guard' ? decision.guards : [];

        insertDeletionRow(db, { ssoUsername: subject, titleId: item.titleId, mode, state: 'blocked', bytesClaimed: state.chargedBytes, requestedAt: nowSeconds });
        writeAuditRow(db, {
          actor: actor.username, actorRole, onBehalfOf,
          action: 'delete.blocked', targetType: 'title', targetId: item.titleId,
          outcome: 'denied', source, correlationId,
          detail: {
            requestedMode: item.requestedMode,
            reason: decision.reason,
            stage: 'schedule',
            protectedReason: decision.reason === 'protected' ? decision.protectedReason : undefined,
            guards: guards.map((g) => ({ guardId: g.guardId, operatorMessage: g.operatorMessage, operatorDetail: g.operatorDetail })),
          },
        });
        results.push({
          titleId: item.titleId,
          requestedMode: item.requestedMode,
          outcome: 'blocked',
          blockedReason: decision.reason,
          guardMessages: actor.isOperator ? guards.map((g) => g.operatorMessage ?? '') : guards.map((g) => g.memberMessage ?? ''),
        });
        continue;
      }

      // Nothing on disk to schedule the removal of — there is no undo window
      // worth offering for a no-op, so this keeps `execute.ts`'s existing
      // "record it and move on" behaviour by delegating below.
      if (decision.kind === 'already_gone') {
        immediate.push(item);
        continue;
      }

      // FR-DEL-23 — a release destroys nothing and needs no grace period.
      if (decision.mode === 'release_claim') {
        immediate.push(item);
        continue;
      }

      // decision.mode === 'delete_files' — the whole point of this module.
      // The rate limit is charged HERE, at the human's click, not at the
      // sweeper's execution: FR-DEL-12 bounds how fast a member may commit to
      // destroying things. `reserveFileDeletionSlot` counts `scheduled` rows
      // toward that budget and inserts this one inside the same transaction.
      const scheduledFor = nowSeconds + gracePeriodSeconds;
      const deletionId = reserveFileDeletionSlot(
        db,
        { ssoUsername: subject, titleId: item.titleId, bytesClaimed: state.chargedBytes, requestedAt: nowSeconds, state: 'scheduled', scheduledFor },
        nowSeconds - RATE_LIMIT_WINDOW_SECONDS,
        config.runtime.deleteMaxPerHour,
      );

      if (deletionId === null) {
        writeAuditRow(db, {
          actor: actor.username, actorRole, onBehalfOf,
          action: 'access.denied', targetType: 'title', targetId: item.titleId,
          outcome: 'denied', source, correlationId,
          detail: { reason: 'rate_limited', deleteMaxPerHour: config.runtime.deleteMaxPerHour, subject, stage: 'schedule' },
        });
        results.push({ titleId: item.titleId, requestedMode: item.requestedMode, outcome: 'rate_limited' });
        continue;
      }

      // FR-DEL-7 keeps its `delete.requested` intent row — the member DID
      // request a deletion here; `delete.scheduled` then records that the
      // system deferred it rather than performing it.
      writeAuditRow(db, {
        actor: actor.username, actorRole, onBehalfOf,
        action: 'delete.requested', targetType: 'title', targetId: item.titleId,
        outcome: 'ok', source, correlationId,
        detail: { requestedMode: item.requestedMode, path: state.path, sizeBytes: state.sizeBytes, deferred: true },
      });
      writeAuditRow(db, {
        actor: actor.username, actorRole, onBehalfOf,
        action: 'delete.scheduled', targetType: 'title', targetId: item.titleId,
        outcome: 'ok', source, correlationId,
        after: { deletionId, scheduledFor, gracePeriodSeconds },
        detail: { path: state.path, sizeBytes: state.sizeBytes, bytesClaimed: state.chargedBytes, subject },
      });

      results.push({
        titleId: item.titleId,
        requestedMode: item.requestedMode,
        outcome: 'scheduled',
        scheduledFor,
        deletionId,
        bytesClaimed: state.chargedBytes,
      });
    } catch (err) {
      try {
        writeAuditRow(db, {
          actor: actor.username, actorRole, onBehalfOf,
          action: 'delete.failed', targetType: 'title', targetId: item.titleId,
          outcome: 'error', source, correlationId,
          detail: { requestedMode: item.requestedMode, stage: 'schedule_item_processing', error: errorMessage(err) },
        });
      } catch {
        // The audit write failed too — `writeAuditRow` already recorded that
        // via `recordAuditWriteFailure` (FR-AUD-7). Same reasoning as
        // `execute.ts`'s outer catch: this must not abort the rest of the batch.
      }
      results.push({ titleId: item.titleId, requestedMode: item.requestedMode, outcome: 'failed', error: errorMessage(err) });
    }
  }

  // The immediate tail: releases and already-gone items. Re-derived AGAIN
  // from fresh state by `executeDeletionBatch` — this module deliberately
  // does not pass its own decision through, so there is no path by which a
  // mis-classified item here could reach the destructive branch on this
  // module's say-so rather than on `deriveTitleAction`'s.
  if (immediate.length > 0) {
    const immediateResult = await executeDeletionBatch(actor, immediate, deps, {
      onBehalfOf: opts.onBehalfOf,
      overrideGuards: opts.overrideGuards,
      source,
      nowSeconds,
    });
    for (const r of immediateResult.items) {
      results.push({
        titleId: r.titleId,
        requestedMode: r.requestedMode,
        outcome:
          r.outcome === 'released' ? 'released'
          : r.outcome === 'already_gone' ? 'already_gone'
          : r.outcome === 'blocked' ? 'blocked'
          : r.outcome === 'unauthorized' ? 'unauthorized'
          : r.outcome === 'invalid_mode' ? 'invalid_mode'
          : r.outcome === 'rate_limited' ? 'rate_limited'
          // `deleted` is unreachable here by construction — only releases and
          // already-gone items are routed to the immediate path, and
          // `deriveTitleAction` re-confirms that classification there. If it
          // ever DID occur it would mean the two derivations disagreed, which
          // is a bug worth surfacing rather than reporting as a clean success.
          : 'failed',
        downgradedFromDelete: r.downgradedFromDelete,
        blockedReason: r.blockedReason,
        guardMessages: r.guardMessages,
        error: r.error,
      });
    }
  }

  return { correlationId, items: results, summary: summarize(results), gracePeriodSeconds };
}
