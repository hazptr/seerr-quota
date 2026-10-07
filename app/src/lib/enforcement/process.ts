/**
 * The one shared decision-and-apply pipeline both the webhook route
 * (`app/src/app/api/seerr/webhook/route.ts`) and the poller (`./poller.ts`)
 * call — `FR-ENF-7`: "Every decision MUST be idempotent... the poller MUST
 * NOT re-decide a request already decided, and a duplicate webhook MUST NOT
 * produce a second Seerr call or a second notification." Both paths funnel
 * through `processPendingRequest` so they cannot disagree (`FR-ENF-1`'s "both
 * the webhook and the poller must call this same function").
 *
 * ## Idempotency, two layers
 *
 * 1. **Terminal decisions never re-fire.** Before evaluating anything, the
 *    request is re-fetched from Seerr (`FR-ENF-8` — the webhook payload is
 *    untrusted, only `request_id` is read from it). If its LIVE status is no
 *    longer `PENDING` — because THIS app already approved/declined it, or an
 *    operator acted on it directly in Seerr, or another member's request
 *    made the same title available — there is nothing left to decide:
 *    `hold`/`skip` are the only non-terminal decisions, and Seerr's own
 *    status is the source of truth for whether one is still outstanding.
 *    This also satisfies the spec's "Held request whose media becomes
 *    available anyway" edge case (`wiki/Feature-05-Enforcement.md`): the
 *    stale `hold` row in `request_decision` is simply never revisited again,
 *    which reads correctly as history (a decision made at time X), without
 *    inventing a reason value this app has no schema room for.
 * 2. **In-process concurrency guard.** The webhook (an HTTP request handler)
 *    and the poller (a background interval) are two independent async flows
 *    in the SAME Node process and CAN interleave around an `await` (e.g. two
 *    near-simultaneous webhook deliveries, or a webhook firing mid-sweep).
 *    `IN_FLIGHT` below de-dupes concurrent calls for the same
 *    `seerrRequestId` to the SAME underlying evaluation, so two overlapping
 *    callers get the SAME result rather than each independently calling
 *    Seerr. This is a single-process guard (does not survive a restart) —
 *    adequate here because this app runs exactly one instance.
 *
 * ## `enforcement_enabled = false` — zero Seerr calls, zero notifications
 *
 * Every branch below is written so the ONLY code paths that call
 * `seerrActions.approve/declineRequest` or `notifier.notify*` are gated on
 * `enforcementEnabled === true`, checked at the call site, not inferred from
 * `decide()`'s output — `FR-ENF-5` is a hard requirement to test directly
 * (`test/enforcement-process.test.ts` asserts the injected Seerr client is
 * never invoked at all when disabled), not just an emergent property of the
 * reason string `decide()` happens to return.
 */
import { newCorrelationId, runRemoteEffect, summarizeError, withAudit, writeAuditRow, type Source } from '@/lib/audit';
import { getConfig } from '@/lib/config';
import { getDb, type SeerrQuotaDb } from '@/lib/db';
import { resolveEffectiveQuota, type EffectiveQuota } from '@/lib/members/quota';
import { getGlobalDefaultQuotaBytes } from '@/lib/quota/policy';
import { decide } from './decide';
import { findMemberBySeerrUserId, loadQuotaBytes } from './member';
import { noopNotifier, type EnforcementNotifier } from './notify';
import { createEnforcementSeerrActions, EnforcementSeerrActions } from './seerrActions';
import { getRequestDecision, upsertRequestDecision, type RequestDecisionRow } from './requestDecisionStore';
import type { EnforcementDecision, EnforcementReason, EnforcementSource } from './types';
import { findLatestAttributionSnapshot, getEffectiveUsageBytes } from './usage';
import { MediaRequestStatus } from '@/lib/seerr/types';

export interface ProcessDeps {
  db?: SeerrQuotaDb;
  seerrActions?: EnforcementSeerrActions;
  notifier?: EnforcementNotifier;
}

export type ProcessOutcome =
  /** The live Seerr request is no longer PENDING — nothing to decide (see this file's header comment). */
  | { kind: 'not_pending'; seerrRequestId: number }
  | { kind: 'decided'; seerrRequestId: number; decision: EnforcementDecision; reason: EnforcementReason }
  /** A Seerr call failed (or the re-fetch itself failed) — never thrown to the caller, so one bad request cannot abort a whole sweep (`FR-ACCT-10`'s failure-isolation discipline, applied here). */
  | { kind: 'error'; seerrRequestId: number; error: string };

function resolveDeps(deps: ProcessDeps): { db: SeerrQuotaDb; seerrActions: EnforcementSeerrActions; notifier: EnforcementNotifier } {
  const config = getConfig();
  return {
    db: deps.db ?? getDb(),
    seerrActions:
      deps.seerrActions ??
      createEnforcementSeerrActions(
        config.upstreams.seerrUrl,
        config.secrets.seerrApiKey,
        config.scheduling.upstreamTimeoutMs,
        config.scheduling.upstreamRetries,
      ),
    notifier: deps.notifier ?? noopNotifier,
  };
}

/**
 * `null` for `unconfigured` (no quota to record — writing `0` would say
 * "unlimited", exactly the absence-vs-zero conflation `FR-POL-2a` exists to
 * prevent), `0` for `unlimited` (matching `quota_policy`'s own `0 = unlimited`
 * convention — this IS a real, decided value), and the byte count for
 * `limited`. `request_decision.quota_bytes` is nullable specifically so this
 * function never has to lie.
 */
function quotaBytesForRow(quota: EffectiveQuota): number | null {
  if (quota.kind === 'unconfigured') return null;
  if (quota.kind === 'unlimited') return 0;
  return quota.bytes;
}

/** No `member` row matches `seerrUserId` — the established convention for an orphan Seerr account with no local identity (`wiki/Data-Model.md` §member: "keyed jellyfinUsername -> username -> seerr:{id} instead"). */
function placeholderSsoUsername(seerrUserId: number): string {
  return `seerr:${seerrUserId}`;
}

/**
 * `request_decision.source` (`webhook` / `poller` / `manual` —
 * `wiki/Data-Model.md`) and `audit.source` (`ui` / `webhook` / `poller` /
 * `cron` / `cli` — `src/lib/audit/actions.ts`'s `Source`) are two DIFFERENT
 * enums that happen to share two literal values. `request_decision.source`
 * names which enforcement PATHWAY decided a request; `audit.source` names
 * the audit log's own, older, more general "what kind of actor triggered
 * this" taxonomy — and it has no `'manual'` member (a human's action there
 * is `'ui'`, the same value the admin dashboard already uses for its own
 * operator-driven audit rows). This mapping is the seam: every
 * `EnforcementSource` this module ever produces gets funneled through it
 * before reaching `writeAuditRow`/`withAudit`/`runRemoteEffect`, so a future
 * `FR-ENF-11` manual-override caller (admin dashboard, out of this task's
 * scope) can pass `source: 'manual'` into `processPendingRequest` and have
 * it land correctly in BOTH tables without this module needing to change.
 */
function auditSourceFor(source: EnforcementSource): Source {
  return source === 'manual' ? 'ui' : source;
}

const IN_FLIGHT = new Map<number, Promise<ProcessOutcome>>();

/**
 * FR-ENF-1/FR-ENF-7/FR-ENF-8: the one shared entry point. `source` records
 * which caller triggered this evaluation (`request_decision.source` /
 * `audit.source`) — it never changes the verdict, only the record of how it
 * was reached.
 */
export function processPendingRequest(
  seerrRequestId: number,
  source: EnforcementSource,
  deps: ProcessDeps = {},
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<ProcessOutcome> {
  const existing = IN_FLIGHT.get(seerrRequestId);
  if (existing) return existing;

  const run = doProcessPendingRequest(seerrRequestId, source, deps, nowSeconds).finally(() => {
    IN_FLIGHT.delete(seerrRequestId);
  });
  IN_FLIGHT.set(seerrRequestId, run);
  return run;
}

async function doProcessPendingRequest(
  seerrRequestId: number,
  source: EnforcementSource,
  deps: ProcessDeps,
  now: number,
): Promise<ProcessOutcome> {
  const { db, seerrActions, notifier } = resolveDeps(deps);
  const config = getConfig();

  let request: Awaited<ReturnType<EnforcementSeerrActions['getRequestById']>>;
  try {
    request = await seerrActions.getRequestById(seerrRequestId);
  } catch (err) {
    return { kind: 'error', seerrRequestId, error: err instanceof Error ? err.message : String(err) };
  }

  if (request.status !== MediaRequestStatus.PENDING) {
    return { kind: 'not_pending', seerrRequestId };
  }

  const member = findMemberBySeerrUserId(db, request.requestedBySeerrUserId);
  const existingDecision = getRequestDecision(db, seerrRequestId);

  const quotaBytesRaw = member ? loadQuotaBytes(db, member.ssoUsername) : null;
  // `FR-POL-2a`: resolved at READ time, from BOTH the member's stored
  // override and the CURRENT global default (never materialised into
  // `quota_policy` — see `src/lib/quota/policy.ts`'s header comment) —
  // never a bare `resolveEffectiveQuota(quotaBytesRaw)`, which could only
  // ever express "inherit" and "unconfigured" as the same `null`.
  const quota = resolveEffectiveQuota(quotaBytesRaw, getGlobalDefaultQuotaBytes(db));

  let usageBytes: number | null = null;
  if (member) {
    try {
      usageBytes = getEffectiveUsageBytes(db, member.ssoUsername);
    } catch {
      usageBytes = null; // FR-ENF-4: uncomputable usage -> skip, never a crash
    }
  }

  const snapshot = findLatestAttributionSnapshot(db);
  const snapshotAgeS = snapshot ? now - snapshot.finishedAt : null;

  const isAlreadyHeld = existingDecision?.decision === 'hold';
  const holdAgeS = isAlreadyHeld && existingDecision?.heldSince != null ? now - existingDecision.heldSince : null;

  const verdict = decide({
    enforcementEnabled: config.runtime.enforcementEnabled,
    memberRecognized: member !== undefined,
    memberSyncStatus: member?.syncStatus ?? null,
    isOperator: member?.isOperator ?? false,
    quota,
    usageBytes,
    graceBytes: config.runtime.graceBytes,
    snapshotAgeS,
    staleSnapshotMaxAgeS: config.runtime.staleSnapshotMaxAgeS,
    isAlreadyHeld,
    holdAgeS,
    holdMaxDays: config.runtime.holdMaxDays,
  });

  const ssoUsername = member?.ssoUsername ?? placeholderSsoUsername(request.requestedBySeerrUserId);
  const baseRow: BaseRow = {
    seerrRequestId,
    ssoUsername,
    // Nullable, verbatim — a `usage_unavailable`/`quota_unconfigured` skip
    // has no real figure to snapshot, and writing `0` for either would be a
    // lie of exactly the kind FR-POL-2a warns about (absence != zero).
    usageBytes,
    quotaBytes: quotaBytesForRow(quota),
    enforced: verdict.enforced,
    source,
    decidedAt: now,
  };

  try {
    switch (verdict.decision) {
      case 'skip':
        applySkip(db, baseRow, verdict.reason, existingDecision);
        break;
      case 'approve':
        await applyApprove(db, seerrActions, notifier, baseRow, verdict.reason, existingDecision, config.runtime.enforcementEnabled, now);
        break;
      case 'hold':
        await applyHold(db, notifier, baseRow, verdict.reason, existingDecision, config.runtime.enforcementEnabled, now);
        break;
      case 'decline':
        await applyDecline(db, seerrActions, notifier, baseRow, verdict.reason, existingDecision, config.runtime.enforcementEnabled, now);
        break;
    }
  } catch (err) {
    // A remote Seerr failure (approve/decline 5xx, timeout, ...) — already
    // audited (outcome='error') by runRemoteEffect inside the apply* helper
    // that threw; request_decision is deliberately left untouched so the
    // next poll retries (acceptance criterion: "not marked final").
    return { kind: 'error', seerrRequestId, error: err instanceof Error ? err.message : String(err) };
  }

  return { kind: 'decided', seerrRequestId, decision: verdict.decision, reason: verdict.reason };
}

type BaseRow = {
  seerrRequestId: number;
  ssoUsername: string;
  /** `null` on a `usage_unavailable` skip. */
  usageBytes: number | null;
  /** `null` on a `quota_unconfigured` skip. */
  quotaBytes: number | null;
  /** `false` = shadow verdict (`FR-ENF-5`) — same value as `decide()`'s `Decision.enforced`. */
  enforced: boolean;
  source: EnforcementSource;
  decidedAt: number;
};

function decisionSummary(row: RequestDecisionRow | undefined) {
  if (!row) return null;
  return { decision: row.decision, reason: row.reason, heldSince: row.heldSince, notifiedAt: row.notifiedAt };
}

function applySkip(db: SeerrQuotaDb, base: BaseRow, reason: EnforcementReason, existing: RequestDecisionRow | undefined): void {
  withAudit(db, ({ tx, audit }) => {
    upsertRequestDecision(tx, {
      ...base,
      decision: 'skip',
      reason,
      seerrStatus: null,
      heldSince: null,
      notifiedAt: existing?.notifiedAt ?? null,
    });
    audit({
      actor: 'system',
      actorRole: 'system',
      action: 'request.skipped',
      targetType: 'request',
      targetId: String(base.seerrRequestId),
      outcome: 'ok',
      source: auditSourceFor(base.source),
      before: decisionSummary(existing),
      after: { decision: 'skip', reason },
      detail: { reason },
    });
  });
}

async function applyApprove(
  db: SeerrQuotaDb,
  seerrActions: EnforcementSeerrActions,
  notifier: EnforcementNotifier,
  base: BaseRow,
  reason: EnforcementReason,
  existing: RequestDecisionRow | undefined,
  enforcementEnabled: boolean,
  now: number,
): Promise<void> {
  if (!enforcementEnabled) {
    // FR-ENF-5: zero Seerr calls, zero notifications while disabled — record
    // the shadow verdict only.
    withAudit(db, ({ tx, audit }) => {
      upsertRequestDecision(tx, { ...base, decision: 'approve', reason, seerrStatus: null, heldSince: null, notifiedAt: existing?.notifiedAt ?? null });
      audit({
        actor: 'system',
        actorRole: 'system',
        action: 'request.approved',
        targetType: 'request',
        targetId: String(base.seerrRequestId),
        outcome: 'ok',
        source: auditSourceFor(base.source),
        before: decisionSummary(existing),
        after: { decision: 'approve', reason, enforced: false },
        detail: { reason },
      });
    });
    return;
  }

  const wasHeld = existing?.decision === 'hold';
  await runRemoteEffect(db, {
    intent: {
      actor: 'system',
      actorRole: 'system',
      action: 'request.approved',
      targetType: 'request',
      targetId: String(base.seerrRequestId),
      before: decisionSummary(existing),
      source: auditSourceFor(base.source),
    },
    call: () => seerrActions.approveRequest(base.seerrRequestId),
    onSuccess: () => {
      // Side effect deliberately performed here (not after `runRemoteEffect`
      // returns): synchronous, runs before the outcome audit row is written,
      // and only ever reached on a genuine 2xx — a failed call never reaches
      // this callback (see `onFailure` below and this module's header
      // comment on "not marked final").
      upsertRequestDecision(db, { ...base, decision: 'approve', reason, seerrStatus: 200, heldSince: null, notifiedAt: existing?.notifiedAt ?? null });
      return {
        action: 'request.approved',
        targetType: 'request',
        targetId: String(base.seerrRequestId),
        outcome: 'ok',
        after: { decision: 'approve', reason, seerrStatus: 200 },
        detail: { reason },
      };
    },
    onFailure: (error) => ({
      action: 'request.approved',
      targetType: 'request',
      targetId: String(base.seerrRequestId),
      outcome: 'error',
      detail: summarizeError(error),
    }),
  });

  // FR-ENF-15: tell the member their held request went through. Best-effort
  // and only reachable once the approve call above actually succeeded.
  if (wasHeld) {
    try {
      const result = await notifier.notifyApproved({ ssoUsername: base.ssoUsername, seerrRequestId: base.seerrRequestId });
      if (result.sent) {
        upsertRequestDecision(db, { ...base, decision: 'approve', reason, seerrStatus: 200, heldSince: null, notifiedAt: now });
        writeAuditRow(db, {
          actor: 'system',
          actorRole: 'system',
          action: 'request.notified',
          targetType: 'request',
          targetId: String(base.seerrRequestId),
          outcome: 'ok',
          source: auditSourceFor(base.source),
          correlationId: newCorrelationId(),
          detail: { notification: 'approved_after_hold' },
        });
      }
    } catch (err) {
      console.warn(JSON.stringify({ event: 'enforcement.notify_failed', seerrRequestId: base.seerrRequestId, error: summarizeError(err) }));
    }
  }
}

async function applyHold(
  db: SeerrQuotaDb,
  notifier: EnforcementNotifier,
  base: BaseRow,
  reason: EnforcementReason,
  existing: RequestDecisionRow | undefined,
  enforcementEnabled: boolean,
  now: number,
): Promise<void> {
  const isNewHold = existing?.decision !== 'hold';
  const heldSince = !isNewHold && existing?.heldSince != null ? existing.heldSince : now;

  // FR-ENF-3: notify on every NEW transition into hold, never on a re-decide
  // of an already-held request (that would re-mail on every 15-minute
  // sweep) — and never at all while enforcement is disabled (FR-ENF-5).
  let notifiedAt = existing?.notifiedAt ?? null;
  if (isNewHold && enforcementEnabled) {
    try {
      // `decide()` only ever returns `hold` from its `limited`-quota, over-quota
      // branch, which requires both a non-null `usageBytes` (step 4's
      // `usage_unavailable` skip gates that) and a `limited` quota (never
      // `null` in the `quotaBytesForRow` mapping) — so both are guaranteed
      // non-null here. `?? 0` is a type-safety fallback only, never expected
      // to actually apply.
      const usageBytesForNotify = base.usageBytes ?? 0;
      const quotaBytesForNotify = base.quotaBytes ?? 0;
      const shortfallBytes = usageBytesForNotify > quotaBytesForNotify ? usageBytesForNotify - quotaBytesForNotify : 0;
      const result = await notifier.notifyHeld({
        ssoUsername: base.ssoUsername,
        seerrRequestId: base.seerrRequestId,
        usageBytes: usageBytesForNotify,
        quotaBytes: quotaBytesForNotify,
        shortfallBytes,
      });
      if (result.sent) notifiedAt = now;
    } catch (err) {
      console.warn(JSON.stringify({ event: 'enforcement.notify_failed', seerrRequestId: base.seerrRequestId, error: summarizeError(err) }));
    }
  }

  withAudit(db, ({ tx, audit }) => {
    upsertRequestDecision(tx, { ...base, decision: 'hold', reason, seerrStatus: null, heldSince, notifiedAt });
    audit({
      actor: 'system',
      actorRole: 'system',
      action: 'request.held',
      targetType: 'request',
      targetId: String(base.seerrRequestId),
      outcome: 'ok',
      source: auditSourceFor(base.source),
      before: decisionSummary(existing),
      after: { decision: 'hold', reason, heldSince },
      detail: { reason, usageBytes: base.usageBytes, quotaBytes: base.quotaBytes },
    });
    if (notifiedAt === now && isNewHold) {
      audit({
        actor: 'system',
        actorRole: 'system',
        action: 'request.notified',
        targetType: 'request',
        targetId: String(base.seerrRequestId),
        outcome: 'ok',
        source: auditSourceFor(base.source),
        detail: { notification: 'held' },
      });
    }
  });
}

async function applyDecline(
  db: SeerrQuotaDb,
  seerrActions: EnforcementSeerrActions,
  notifier: EnforcementNotifier,
  base: BaseRow,
  reason: EnforcementReason,
  existing: RequestDecisionRow | undefined,
  enforcementEnabled: boolean,
  now: number,
): Promise<void> {
  if (!enforcementEnabled) {
    // FR-ENF-5: shadow-only, same as the disabled `approve` branch above.
    withAudit(db, ({ tx, audit }) => {
      upsertRequestDecision(tx, { ...base, decision: 'decline', reason, seerrStatus: null, heldSince: null, notifiedAt: existing?.notifiedAt ?? null });
      audit({
        actor: 'system',
        actorRole: 'system',
        action: 'request.declined',
        targetType: 'request',
        targetId: String(base.seerrRequestId),
        outcome: 'ok',
        source: auditSourceFor(base.source),
        before: decisionSummary(existing),
        after: { decision: 'decline', reason, enforced: false },
        detail: { reason },
      });
    });
    return;
  }

  // FR-ENF-12: "with a member notification sent first" — attempted BEFORE
  // the Seerr decline call, best-effort (a mail failure must not stop the
  // safety valve from firing; an unbounded pending queue is worse).
  let notifiedAt = existing?.notifiedAt ?? null;
  try {
    const result = await notifier.notifyDeclined({ ssoUsername: base.ssoUsername, seerrRequestId: base.seerrRequestId, reason: 'hold_expired' });
    if (result.sent) notifiedAt = now;
  } catch (err) {
    console.warn(JSON.stringify({ event: 'enforcement.notify_failed', seerrRequestId: base.seerrRequestId, error: summarizeError(err) }));
  }

  await runRemoteEffect(db, {
    intent: {
      actor: 'system',
      actorRole: 'system',
      action: 'request.declined',
      targetType: 'request',
      targetId: String(base.seerrRequestId),
      before: decisionSummary(existing),
      source: auditSourceFor(base.source),
    },
    call: () => seerrActions.declineRequest(base.seerrRequestId),
    onSuccess: () => {
      upsertRequestDecision(db, { ...base, decision: 'decline', reason, seerrStatus: 200, heldSince: null, notifiedAt });
      return {
        action: 'request.declined',
        targetType: 'request',
        targetId: String(base.seerrRequestId),
        outcome: 'ok',
        after: { decision: 'decline', reason, seerrStatus: 200 },
        detail: { reason },
      };
    },
    onFailure: (error) => ({
      action: 'request.declined',
      targetType: 'request',
      targetId: String(base.seerrRequestId),
      outcome: 'error',
      detail: summarizeError(error),
    }),
  });

  if (notifiedAt === now) {
    writeAuditRow(db, {
      actor: 'system',
      actorRole: 'system',
      action: 'request.notified',
      targetType: 'request',
      targetId: String(base.seerrRequestId),
      outcome: 'ok',
      source: auditSourceFor(base.source),
      correlationId: newCorrelationId(),
      detail: { notification: 'hold_expired' },
    });
  }
}
