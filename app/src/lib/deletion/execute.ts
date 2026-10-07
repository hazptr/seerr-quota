/**
 * The step-3 confirm handler — `FR-DEL-5`'s last of three distinct actions,
 * and the only function in this whole app that can call a real
 * Radarr/Sonarr `DELETE`. Everything else in this directory exists to make
 * this function's behaviour defensible.
 *
 * ## The IDOR guard, concretely (`FR-DEL-1`/`FR-DEL-14`)
 *
 * This function NEVER trusts anything about a title's claim/protection/
 * guard state from its caller — only `titleId` and `requestedMode` are
 * taken as input per item. Every other fact is re-read fresh from the
 * database via `loadFreshTitleClaimStates` at the START of this call
 * (`deletionStore.ts`), and re-run through the SAME pure `deriveTitleAction`
 * `plan.ts` uses. A title a "plan" call showed minutes ago as deletable can
 * be re-evaluated here as blocked/released/already-gone/unauthorized —
 * whatever is true RIGHT NOW wins, every time, for every title in the batch.
 *
 * ## `FR-DEL-15` — fail closed on an unrecognised mode
 *
 * `deriveTitleAction` (`authorize.ts`) validates `requestedMode` against the
 * known `DeletionMode` literals as its very FIRST check, before anything
 * else, and returns `{ kind: 'invalid_mode' }` for anything else. This
 * function maps that to `access.denied`, exactly like `unauthorized` — no
 * `*arr` call, no `deletion` row, refused outright. This module never
 * trusts the caller to have validated `requestedMode` already.
 *
 * ## Partial-batch semantics (`FR-DEL-8`, `FR-DEL-18`)
 *
 * The loop below NEVER lets an exception from ANY per-item work — guard
 * evaluation, a DB read/write, a rate-limit reservation, the remote calls —
 * escape back to the caller and abort the batch. Every item's ENTIRE
 * processing (not just its remote call) runs inside that item's own
 * `try`/`catch`; a failure anywhere is caught, turned into that item's own
 * `DeletionItemResult` plus a best-effort audit row, and the loop moves on.
 * Six titles where the fourth's arr call 500s produces five
 * `deleted`/`released` outcomes, one `failed`, and audit rows for all six —
 * proven directly in `test/deletion-execute.test.ts`.
 *
 * ## `FR-DEL-17` — the rate limit is reserved atomically
 *
 * A `delete_files` attempt counts its subject's recent deletions AND
 * inserts its own `'executing'` `deletion` row inside ONE
 * `db.transaction()` (`deletionStore.ts`'s `reserveFileDeletionSlot`) — a
 * synchronous unit of work with no `await` inside it, so two concurrent
 * `executeDeletionBatch` calls can never both read the same stale count
 * before either has written. See that function's doc comment for the
 * concurrency argument in full.
 *
 * ## Audit trail shape (`FR-DEL-7`, `FR-DEL-16`, `FR-AUD-5`)
 *
 * One `correlationId` is minted ONCE per `executeDeletionBatch` call and
 * used for EVERY audit row this call writes, across every item — matching
 * `wiki/Feature-08-Audit-Log.md`'s own acceptance criterion literally
 * ("three titles ... share ONE correlation_id"), not just within one title's
 * own requested/executed pair. Per item, depending on outcome:
 *
 *   - invalid mode (FR-DEL-15)                            → `access.denied` alone
 *   - unauthorized (not a claimant / unknown id)           → `access.denied` alone
 *   - rate-limited                                         → `delete.requested` + `access.denied`
 *   - blocked (protected / guard)                          → `delete.requested` + `delete.blocked`
 *   - blocked (sole_claimant_cannot_release / no_claim)     → `delete.blocked` alone
 *   - already gone                                          → `delete.requested` + `delete.executed`
 *   - deleted                                               → `delete.requested` + `delete.executed`
 *                                                              (arr call)
 *                                                              (+ `delete.requested` + `delete.executed`/
 *                                                              `delete.failed` for the Seerr cleanup too,
 *                                                              FR-DEL-16 — iff the title has a
 *                                                              seerrRequestId at all)
 *   - deleted, arr call itself failed                      → `delete.requested` + `delete.failed`
 *   - released, not downgraded                              → `claim.released` alone
 *   - released, downgraded from a delete request            → `delete.requested` + `claim.released`
 *     (the delete.requested row is what makes the downgrade honestly
 *     traceable: "they asked to delete, here's what actually happened and
 *     why")
 *   - an exception escaped all of the above (FR-DEL-18)     → `delete.failed` alone (best-effort)
 */
import type { ActorRole, Source } from '@/lib/audit';
import { newCorrelationId, runRemoteEffect, summarizeError, writeAuditRow } from '@/lib/audit';
import { getConfig } from '@/lib/config';
import { getDb, type SeerrQuotaDb } from '@/lib/db';
import { UpstreamError } from '@/lib/http/client';
import { createRadarrDeleteClient, createSonarrDeleteClient, radarrDeleteCallUrl, sonarrDeleteCallUrl, type RadarrDeleteClient, type SonarrDeleteClient } from './arrActions';
import { deriveTitleAction } from './authorize';
import {
  claimScheduledDeletionForExecution,
  insertDeletionRow,
  loadFreshTitleClaimStates,
  markDeletionCancelled,
  markDeletionDone,
  markDeletionFailed,
  markDeletionPartialFailure,
  releaseClaimWithAudit,
  reserveFileDeletionSlot,
  type FreshTitleClaimState,
} from './deletionStore';
import { buildGuardContext, DELETION_GUARDS, isPlaybackUnavailable, runDeletionGuards } from './guards';
import { createSeerrCleanupClient, seerrDeleteRequestCallUrl, type SeerrCleanupClient } from './seerrCleanup';
import type { DeletionActor, DeletionMode, DeletionRequestItem } from './types';

export type DeletionItemOutcome =
  | 'deleted'
  | 'released'
  | 'blocked'
  | 'unauthorized'
  | 'invalid_mode'
  | 'already_gone'
  | 'failed'
  | 'rate_limited'
  /** Only reachable in sweeper mode: the scheduled row left `scheduled` between this run's read and its atomic claim — somebody cancelled it (`FR-DEL-25`). */
  | 'cancelled';

export interface DeletionItemResult {
  titleId: string;
  requestedMode: DeletionMode;
  outcome: DeletionItemOutcome;
  finalMode?: DeletionMode;
  downgradedFromDelete?: boolean;
  bytesFreed?: number;
  /** FR-DEL-9: arr delete succeeded but the Seerr cleanup afterward failed — never swallowed, always surfaced here AND as its own audit row. */
  partial?: boolean;
  warning?: string;
  error?: string;
  blockedReason?: string;
  guardMessages?: string[];
}

export interface DeletionBatchSummary {
  total: number;
  deleted: number;
  released: number;
  failed: number;
  blocked: number;
  unauthorized: number;
  invalidMode: number;
  alreadyGone: number;
  rateLimited: number;
  /** Sweeper mode only — scheduled rows that were cancelled out from under this run. */
  cancelled: number;
}

export interface ExecuteDeletionBatchResult {
  correlationId: string;
  items: DeletionItemResult[];
  summary: DeletionBatchSummary;
}

export interface ExecuteDeletionBatchOptions {
  /** Operator-only: act on a specific member's claims (`on_behalf_of`). Ignored for a non-operator actor — see this file's body for why that's enforced here, not just assumed of the caller. */
  onBehalfOf?: string;
  /** Operator-only: explicit override of every currently-fired "watching" guard for this whole batch (`FR-DEL-4`'s "explicit extra confirmation"). Ignored for a non-operator actor. */
  overrideGuards?: boolean;
  source?: Source;
  /**
   * Test-only escape hatch for the "now" this batch reasons about — it
   * anchors BOTH the rate-limit window and every `requestedAt`/`executedAt`
   * this call stamps. NEVER wire this to a client-supplied timestamp in a
   * future route handler: a caller who controls "now" could evade
   * `FR-DEL-12`'s rate limit entirely by lying about when their own recent
   * deletions happened.
   */
  nowSeconds?: number;
  /**
   * **Sweeper mode** (`./runner.ts`, `FR-DEL-25`). Maps `titleId` → the id of
   * the already-existing `scheduled` `deletion` row this execution fulfils.
   * When a title is present here, this function reuses that row instead of
   * inserting a new one and does NOT re-charge the rate limit — the slot was
   * reserved at schedule time, when the member actually clicked (`FR-DEL-12`).
   *
   * It changes nothing about authorization. Every decision is still re-derived
   * from state read fresh at THIS moment (`FR-DEL-1`/`FR-DEL-14`), which is
   * the entire point of deferring: a title that has become protected, or that
   * somebody started watching during the grace period, is refused now even
   * though it was permitted when it was scheduled. Such a row is cancelled
   * rather than blocked (`FR-DEL-26`) — there is no pending action left to
   * block once this run declines to perform it.
   */
  fulfillingScheduledIds?: ReadonlyMap<string, number>;
}

export interface ExecuteDeletionDeps {
  db?: SeerrQuotaDb;
  radarr?: RadarrDeleteClient;
  sonarr?: SonarrDeleteClient;
  seerr?: SeerrCleanupClient;
}

const RATE_LIMIT_WINDOW_SECONDS = 3600;

function resolveDeps(deps: ExecuteDeletionDeps): { db: SeerrQuotaDb; radarr: RadarrDeleteClient; sonarr: SonarrDeleteClient; seerr: SeerrCleanupClient } {
  const config = getConfig();
  return {
    db: deps.db ?? getDb(),
    radarr:
      deps.radarr ??
      createRadarrDeleteClient(config.upstreams.radarrUrl, config.secrets.radarrApiKey, config.scheduling.upstreamTimeoutMs, config.scheduling.upstreamRetries),
    sonarr:
      deps.sonarr ??
      createSonarrDeleteClient(config.upstreams.sonarrUrl, config.secrets.sonarrApiKey, config.scheduling.upstreamTimeoutMs, config.scheduling.upstreamRetries),
    seerr:
      deps.seerr ??
      createSeerrCleanupClient(config.upstreams.seerrUrl, config.secrets.seerrApiKey, config.scheduling.upstreamTimeoutMs, config.scheduling.upstreamRetries),
  };
}

function arrCallUrlFor(radarrBaseUrl: string, sonarrBaseUrl: string, state: FreshTitleClaimState): string {
  return state.arrInstance.startsWith('radarr') ? radarrDeleteCallUrl(radarrBaseUrl, state.arrId) : sonarrDeleteCallUrl(sonarrBaseUrl, state.arrId);
}

async function callArrDelete(clients: { radarr: RadarrDeleteClient; sonarr: SonarrDeleteClient }, state: FreshTitleClaimState): Promise<{ status: number }> {
  if (state.arrInstance.startsWith('radarr')) {
    return clients.radarr.deleteMovie(state.arrId);
  }
  return clients.sonarr.deleteSeries(state.arrId);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function summarize(results: DeletionItemResult[]): DeletionBatchSummary {
  const summary: DeletionBatchSummary = {
    total: results.length,
    deleted: 0,
    released: 0,
    failed: 0,
    blocked: 0,
    unauthorized: 0,
    invalidMode: 0,
    alreadyGone: 0,
    rateLimited: 0,
    cancelled: 0,
  };
  for (const r of results) {
    switch (r.outcome) {
      case 'deleted':
        summary.deleted++;
        break;
      case 'released':
        summary.released++;
        break;
      case 'failed':
        summary.failed++;
        break;
      case 'blocked':
        summary.blocked++;
        break;
      case 'unauthorized':
        summary.unauthorized++;
        break;
      case 'invalid_mode':
        summary.invalidMode++;
        break;
      case 'already_gone':
        summary.alreadyGone++;
        break;
      case 'rate_limited':
        summary.rateLimited++;
        break;
      case 'cancelled':
        summary.cancelled++;
        break;
    }
  }
  return summary;
}

export async function executeDeletionBatch(
  actor: DeletionActor,
  items: DeletionRequestItem[],
  deps: ExecuteDeletionDeps = {},
  opts: ExecuteDeletionBatchOptions = {},
): Promise<ExecuteDeletionBatchResult> {
  const { db, radarr, sonarr, seerr } = resolveDeps(deps);
  const config = getConfig();
  const nowSeconds = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const source: Source = opts.source ?? 'ui';
  const actorRole: ActorRole = actor.isOperator ? 'operator' : 'member';

  // Defense in depth: `onBehalfOf`/`overrideGuards` are only ever honored
  // for a genuine operator — never trusted for a member actor even if a
  // caller bug (a future route handler) passed one through.
  const onBehalfOf = actor.isOperator ? opts.onBehalfOf : undefined;
  const overrideGuards = actor.isOperator ? !!opts.overrideGuards : false;
  const subject = onBehalfOf ?? actor.username;

  const batchCorrelationId = newCorrelationId();
  const fulfilling = opts.fulfillingScheduledIds;

  // De-dupe by titleId, first occurrence wins — FR-DEL-8: each title's
  // outcome is independent, so a duplicate id must not double-attempt the
  // arr call or double-charge the rate limit.
  const seenIds = new Set<string>();
  const dedupedItems: DeletionRequestItem[] = [];
  for (const item of items) {
    if (seenIds.has(item.titleId)) continue;
    seenIds.add(item.titleId);
    dedupedItems.push(item);
  }

  const states = loadFreshTitleClaimStates(
    db,
    subject,
    dedupedItems.map((i) => i.titleId),
  );

  // FR-DEL-21: one batch-level check (not one per title) — see
  // `guards.ts`'s `isPlaybackUnavailable` doc comment.
  const playbackUnavailable = isPlaybackUnavailable(db, nowSeconds, config.runtime.staleSnapshotMaxAgeS);

  const results: DeletionItemResult[] = [];

  for (const item of dedupedItems) {
    // FR-DEL-18: EVERYTHING for this item — guard evaluation, DB reads/
    // writes, the rate-limit reservation, the remote calls — lives inside
    // this one try. No exception from any of it may escape and abort the
    // rest of the batch; a later item must never be silently dropped
    // because an earlier one hit a DB error or a guard invariant violation.
    try {
      const state = states.get(item.titleId)!;

      if (!state.exists) {
        writeAuditRow(db, {
          actor: actor.username,
          actorRole,
          onBehalfOf,
          action: 'access.denied',
          targetType: 'title',
          targetId: item.titleId,
          outcome: 'denied',
          source,
          correlationId: batchCorrelationId,
          detail: { requestedMode: item.requestedMode, reason: 'unknown_title', subject },
        });
        results.push({ titleId: item.titleId, requestedMode: item.requestedMode, outcome: 'unauthorized' });
        continue;
      }

      const guardCtx = buildGuardContext(db, {
        titleId: item.titleId,
        mediaType: state.mediaType,
        watchedByAnyone: state.watchedByAnyone,
        lastPlayedAnyAt: state.lastPlayedAnyAt,
        nowSeconds,
        deleteRecentPlayDays: config.runtime.deleteRecentPlayDays,
        deleteInProgressDays: config.runtime.deleteInProgressDays,
        playbackUnavailable,
        subjectUsername: subject,
      });
      const guardEvaluations = runDeletionGuards(DELETION_GUARDS, guardCtx);

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

      if (decision.kind === 'invalid_mode') {
        // FR-DEL-15 — fail closed: an unrecognised requestedMode is refused
        // outright, exactly like `unauthorized`. No deletion row, no *arr
        // call, ever.
        writeAuditRow(db, {
          actor: actor.username,
          actorRole,
          onBehalfOf,
          action: 'access.denied',
          targetType: 'title',
          targetId: item.titleId,
          outcome: 'denied',
          source,
          correlationId: batchCorrelationId,
          detail: { requestedMode: item.requestedMode, reason: 'invalid_mode', subject },
        });
        results.push({ titleId: item.titleId, requestedMode: item.requestedMode, outcome: 'invalid_mode' });
        continue;
      }

      if (decision.kind === 'unauthorized') {
        writeAuditRow(db, {
          actor: actor.username,
          actorRole,
          onBehalfOf,
          action: 'access.denied',
          targetType: 'title',
          targetId: item.titleId,
          outcome: 'denied',
          source,
          correlationId: batchCorrelationId,
          detail: { requestedMode: item.requestedMode, reason: 'not_claimant', subject },
        });
        results.push({ titleId: item.titleId, requestedMode: item.requestedMode, outcome: 'unauthorized' });
        continue;
      }

      if (decision.kind === 'blocked') {
        const isDeleteFlavored = decision.reason === 'protected' || decision.reason === 'includes_uncharged_files' || decision.reason === 'guard';
        const mode: DeletionMode = isDeleteFlavored ? 'delete_files' : 'release_claim';
        const guardsForResult = decision.reason === 'guard' ? decision.guards : [];

        if (isDeleteFlavored) {
          writeAuditRow(db, {
            actor: actor.username,
            actorRole,
            onBehalfOf,
            action: 'delete.requested',
            targetType: 'title',
            targetId: item.titleId,
            outcome: 'ok',
            source,
            correlationId: batchCorrelationId,
            detail: { requestedMode: item.requestedMode, path: state.path, sizeBytes: state.sizeBytes },
          });
        }

        // FR-DEL-26 — in sweeper mode the pending row IS the record of this
        // attempt, so it is cancelled rather than duplicated by a fresh
        // `blocked` row. `markDeletionCancelled`'s `WHERE state='scheduled'`
        // also means a member who cancelled it a moment ago still wins.
        const fulfillingId = fulfilling?.get(item.titleId);
        if (fulfillingId !== undefined) {
          markDeletionCancelled(db, fulfillingId, { cancelledAt: nowSeconds, cancelledBy: 'system', cancelReason: `guard_blocked_at_execution:${decision.reason}` });
          writeAuditRow(db, {
            actor: actor.username,
            actorRole,
            onBehalfOf,
            action: 'delete.cancelled',
            targetType: 'title',
            targetId: item.titleId,
            outcome: 'ok',
            source,
            correlationId: batchCorrelationId,
            before: { state: 'scheduled' },
            after: { state: 'cancelled' },
            detail: { deletionId: fulfillingId, reason: 'guard_blocked_at_execution', blockedReason: decision.reason, owner: subject },
          });
        } else {
          insertDeletionRow(db, { ssoUsername: subject, titleId: item.titleId, mode, state: 'blocked', bytesClaimed: state.chargedBytes, requestedAt: nowSeconds });
        }

        writeAuditRow(db, {
          actor: actor.username,
          actorRole,
          onBehalfOf,
          action: 'delete.blocked',
          targetType: 'title',
          targetId: item.titleId,
          outcome: 'denied',
          source,
          correlationId: batchCorrelationId,
          detail: {
            requestedMode: item.requestedMode,
            reason: decision.reason,
            protectedReason: decision.reason === 'protected' ? decision.protectedReason : undefined,
            guards: guardsForResult.map((g) => ({ guardId: g.guardId, operatorMessage: g.operatorMessage, operatorDetail: g.operatorDetail })),
          },
        });

        results.push({
          titleId: item.titleId,
          requestedMode: item.requestedMode,
          outcome: 'blocked',
          blockedReason: decision.reason,
          guardMessages: actor.isOperator ? guardsForResult.map((g) => g.operatorMessage ?? '') : guardsForResult.map((g) => g.memberMessage ?? ''),
        });
        continue;
      }

      if (decision.kind === 'already_gone') {
        writeAuditRow(db, {
          actor: actor.username,
          actorRole,
          onBehalfOf,
          action: 'delete.requested',
          targetType: 'title',
          targetId: item.titleId,
          outcome: 'ok',
          source,
          correlationId: batchCorrelationId,
          detail: { requestedMode: item.requestedMode, path: state.path },
        });
        const goneFulfillingId = fulfilling?.get(item.titleId);
        if (goneFulfillingId !== undefined) {
          // The files went away during the grace window (an operator tidied
          // up, or Radarr lost the movie). The scheduled row's outcome is
          // "nothing left to do", not a second historical row.
          markDeletionDone(db, goneFulfillingId, { bytesFreed: 0, arrCall: null, arrStatus: null, executedAt: nowSeconds });
        } else {
          insertDeletionRow(db, {
            ssoUsername: subject,
            titleId: item.titleId,
            mode: 'delete_files',
            state: 'done',
            bytesClaimed: state.chargedBytes,
            requestedAt: nowSeconds,
            executedAt: nowSeconds,
          });
        }
        writeAuditRow(db, {
          actor: actor.username,
          actorRole,
          onBehalfOf,
          action: 'delete.executed',
          targetType: 'title',
          targetId: item.titleId,
          outcome: 'ok',
          source,
          correlationId: batchCorrelationId,
          detail: { requestedMode: item.requestedMode, alreadyGone: true, bytesFreed: 0 },
        });
        results.push({ titleId: item.titleId, requestedMode: item.requestedMode, outcome: 'already_gone', bytesFreed: 0 });
        continue;
      }

      // decision.kind === 'execute'
      if (decision.mode === 'release_claim') {
        if (decision.downgradedFromDelete) {
          writeAuditRow(db, {
            actor: actor.username,
            actorRole,
            onBehalfOf,
            action: 'delete.requested',
            targetType: 'title',
            targetId: item.titleId,
            outcome: 'ok',
            source,
            correlationId: batchCorrelationId,
            detail: { requestedMode: 'delete_files', downgradedTo: 'release_claim', reason: 'no_longer_sole_claimant' },
          });
        }

        releaseClaimWithAudit(
          db,
          {
            correlationId: batchCorrelationId,
            actorUsername: actor.username,
            actorRole,
            onBehalfOf,
            source,
            titleId: item.titleId,
            claimId: state.claimId!,
            chargedBytes: state.chargedBytes,
            remainingActiveClaimants: Math.max(0, state.activeClaimantCount - 1),
            downgradedFromDelete: decision.downgradedFromDelete,
            requestedMode: item.requestedMode,
          },
          nowSeconds,
        );

        // A delete scheduled while the member was sole claimant, executed
        // after someone else co-requested it: `deriveTitleAction` correctly
        // downgrades it to a release (FR-DEL-2). The pending DELETE is
        // therefore cancelled — it is genuinely not happening — and the
        // release gets its own row, so the audit trail shows both facts.
        const relFulfillingId = fulfilling?.get(item.titleId);
        if (relFulfillingId !== undefined) {
          markDeletionCancelled(db, relFulfillingId, { cancelledAt: nowSeconds, cancelledBy: 'system', cancelReason: 'downgraded_to_release' });
        }

        insertDeletionRow(db, {
          ssoUsername: subject,
          titleId: item.titleId,
          mode: 'release_claim',
          state: 'done',
          bytesClaimed: state.chargedBytes,
          requestedAt: nowSeconds,
          executedAt: nowSeconds,
        });

        results.push({
          titleId: item.titleId,
          requestedMode: item.requestedMode,
          outcome: 'released',
          finalMode: 'release_claim',
          downgradedFromDelete: decision.downgradedFromDelete,
        });
        continue;
      }

      // decision.mode === 'delete_files'
      // FR-DEL-17: count-and-reserve atomically, in one transaction — see
      // deletionStore.ts's reserveFileDeletionSlot for why this replaces a
      // separate "count, compare, then insert" sequence.
      // Sweeper mode: the row already exists and its rate-limit slot was
      // charged at schedule time. `claimScheduledDeletionForExecution` is the
      // atomic `scheduled -> executing` flip that makes this the ONLY caller
      // allowed to issue the DELETE — if it returns false, someone cancelled
      // in the gap and this item stops here (AGENTS.md rule 11: there is no
      // second attempt, ever).
      const scheduledRowId = fulfilling?.get(item.titleId);
      let deletionRowId: number | null;
      if (scheduledRowId !== undefined) {
        deletionRowId = claimScheduledDeletionForExecution(db, scheduledRowId) ? scheduledRowId : null;
        if (deletionRowId === null) {
          results.push({ titleId: item.titleId, requestedMode: item.requestedMode, outcome: 'cancelled' });
          continue;
        }
      } else {
        deletionRowId = reserveFileDeletionSlot(
          db,
          { ssoUsername: subject, titleId: item.titleId, bytesClaimed: state.chargedBytes, requestedAt: nowSeconds },
          nowSeconds - RATE_LIMIT_WINDOW_SECONDS,
          config.runtime.deleteMaxPerHour,
        );
      }

      if (deletionRowId === null) {
        writeAuditRow(db, {
          actor: actor.username,
          actorRole,
          onBehalfOf,
          action: 'delete.requested',
          targetType: 'title',
          targetId: item.titleId,
          outcome: 'ok',
          source,
          correlationId: batchCorrelationId,
          detail: { requestedMode: item.requestedMode, path: state.path, sizeBytes: state.sizeBytes },
        });
        writeAuditRow(db, {
          actor: actor.username,
          actorRole,
          onBehalfOf,
          action: 'access.denied',
          targetType: 'title',
          targetId: item.titleId,
          outcome: 'denied',
          source,
          correlationId: batchCorrelationId,
          detail: { reason: 'rate_limited', deleteMaxPerHour: config.runtime.deleteMaxPerHour, subject },
        });
        results.push({ titleId: item.titleId, requestedMode: item.requestedMode, outcome: 'rate_limited' });
        continue;
      }

      const callUrl = arrCallUrlFor(config.upstreams.radarrUrl, config.upstreams.sonarrUrl, state);

      try {
        await runRemoteEffect(db, {
          intent: {
            actor: actor.username,
            actorRole,
            onBehalfOf,
            action: 'delete.requested',
            targetType: 'title',
            targetId: item.titleId,
            source,
            correlationId: batchCorrelationId,
            detail: { requestedMode: item.requestedMode, path: state.path, sizeBytes: state.sizeBytes, arrCall: callUrl },
          },
          call: () => callArrDelete({ radarr, sonarr }, state),
          onSuccess: (value) => {
            // bytesFreed is the title's REAL known size (`state.sizeBytes`),
            // not the subject's charge (`state.chargedBytes`) — the two agree
            // whenever the subject holds a claim (D-3: chargedBytes IS the
            // title's full size), but an operator deleting a title nobody
            // currently claims (D-6's no-claim delete path) has
            // chargedBytes === 0 while real bytes are still being freed from
            // disk. bytesFreed must reflect reality, not "their share".
            markDeletionDone(db, deletionRowId, { bytesFreed: state.sizeBytes, arrCall: callUrl, arrStatus: value.status, executedAt: nowSeconds });
            return {
              action: 'delete.executed',
              targetType: 'title',
              targetId: item.titleId,
              outcome: 'ok',
              after: { arrCall: callUrl, arrStatus: value.status },
              detail: { bytesFreed: state.sizeBytes },
            };
          },
          onFailure: (error) => {
            const status = error instanceof UpstreamError ? error.status ?? null : null;
            markDeletionFailed(db, deletionRowId, { arrCall: callUrl, arrStatus: status, error: errorMessage(error), executedAt: nowSeconds });
            return {
              action: 'delete.failed',
              targetType: 'title',
              targetId: item.titleId,
              outcome: 'error',
              detail: { ...summarizeError(error), arrCall: callUrl },
            };
          },
        });
      } catch (err) {
        // AGENTS.md rule 11 / FR-DEL-8: never retried, never aborts the batch —
        // the intent + failure outcome rows are already written above by
        // runRemoteEffect; move on to the next item.
        results.push({ titleId: item.titleId, requestedMode: item.requestedMode, outcome: 'failed', error: errorMessage(err) });
        continue;
      }

      // Arr delete succeeded — FR-DEL-9: also remove the Seerr request.
      // FR-DEL-16: this is a remote effect too, and gets the SAME audited
      // intent/outcome treatment as the arr call above, sharing the batch's
      // correlationId — a bare `await seerr.deleteRequest(...)` with no
      // intent row and no success-outcome row would leave a Seerr cleanup
      // that failed after the files were already gone with no trace at all.
      let partial = false;
      let warning: string | undefined;
      if (state.seerrRequestId != null) {
        const seerrRequestId = state.seerrRequestId;
        const seerrCallUrl = seerrDeleteRequestCallUrl(config.upstreams.seerrUrl, seerrRequestId);
        try {
          await runRemoteEffect(db, {
            intent: {
              actor: actor.username,
              actorRole,
              onBehalfOf,
              action: 'delete.requested',
              targetType: 'title',
              targetId: item.titleId,
              source,
              correlationId: batchCorrelationId,
              detail: { stage: 'seerr_request_cleanup', seerrRequestId, seerrCall: seerrCallUrl },
            },
            call: () => seerr.deleteRequest(seerrRequestId),
            onSuccess: (value) => ({
              action: 'delete.executed',
              targetType: 'title',
              targetId: item.titleId,
              outcome: 'ok',
              after: { seerrCall: seerrCallUrl, seerrStatus: value.status },
              detail: { stage: 'seerr_request_cleanup', seerrRequestId },
            }),
            onFailure: (error) => ({
              action: 'delete.failed',
              targetType: 'title',
              targetId: item.titleId,
              outcome: 'error',
              detail: { stage: 'seerr_request_cleanup', filesDeleted: true, seerrRequestId, ...summarizeError(error) },
            }),
          });
        } catch (err) {
          partial = true;
          warning = 'Files were deleted, but the Seerr request could not be removed — needs operator attention.';
          markDeletionPartialFailure(db, deletionRowId, `seerr cleanup failed: ${errorMessage(err)}`);
        }
      }

      results.push({
        titleId: item.titleId,
        requestedMode: item.requestedMode,
        outcome: 'deleted',
        finalMode: 'delete_files',
        downgradedFromDelete: false,
        bytesFreed: state.sizeBytes,
        partial,
        warning,
      });
    } catch (err) {
      // FR-DEL-18 — the safety net. Everything above this catch already
      // handles its own known failure modes without throwing; this only
      // fires for something unexpected escaping (a DB error like
      // SQLITE_BUSY, `runDeletionGuards`' own fail-safe invariant throw,
      // etc). Whatever it was, THIS item gets a best-effort audit row and
      // its own `failed` result, and the loop moves on — it must never take
      // down the rest of the batch, silently dropping outcomes/audit rows
      // for titles that haven't been processed yet.
      try {
        writeAuditRow(db, {
          actor: actor.username,
          actorRole,
          onBehalfOf,
          action: 'delete.failed',
          targetType: 'title',
          targetId: item.titleId,
          outcome: 'error',
          source,
          correlationId: batchCorrelationId,
          detail: { requestedMode: item.requestedMode, stage: 'batch_item_processing', ...summarizeError(err) },
        });
      } catch {
        // The audit write itself failed too (plausibly the SAME DB error
        // that caused the original exception) — writeAuditRow already
        // recorded that via recordAuditWriteFailure (FR-AUD-7) before
        // rethrowing. There is nothing more this loop can do for this item;
        // the point of this whole catch is that it must not propagate
        // further and silence the REST of the batch either.
      }
      results.push({ titleId: item.titleId, requestedMode: item.requestedMode, outcome: 'failed', error: errorMessage(err) });
    }
  }

  return { correlationId: batchCorrelationId, items: results, summary: summarize(results) };
}
