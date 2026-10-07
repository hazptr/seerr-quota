/**
 * The undo half of `FR-DEL-22`: calling off a scheduled deletion before the
 * sweeper runs it (`FR-DEL-24`). This module can only ever move a row from
 * `scheduled` to `cancelled`; it issues no upstream call and touches no file.
 *
 * ## Who may cancel (`FR-DEL-24`)
 *
 * The member who scheduled it, or the operator. Nobody else — a scheduled
 * deletion is not a shared object, and a co-claimant has no standing over
 * someone else's pending action any more than they have over their claim.
 * Authority is re-derived here from the row's OWN `sso_username` read fresh
 * from the database, never from anything the caller supplied, which is
 * `FR-DEL-14`'s IDOR guard restated for this surface: guessing a deletion id
 * must not reveal that it exists, let alone cancel it. An unauthorized
 * caller and a nonexistent id are therefore reported identically
 * (`not_found`).
 *
 * ## The quota interlock (`FR-DEL-28`)
 *
 * Scheduling credits the bytes back immediately (`FR-DEL-27`) so a member
 * who is out of room can act and request again straight away. That credit is
 * what makes cancellation dangerous: undoing a deletion takes the bytes back
 * onto their books, and if they have already spent the headroom, the cancel
 * would leave them over quota — retroactively, through no new request of
 * their own.
 *
 * The operator's decision was to refuse that cancel rather than allow the
 * overage (see `wiki/Feature-06-Self-Service-Deletion.md`). A member gets a
 * clear `would_exceed_quota` refusal naming the shortfall. **The operator is
 * not subject to this check** — the whole reason it exists is to stop a
 * member silently re-entering overage, and an operator undoing a member's
 * mistaken delete is precisely the case the interlock must not stand in the
 * way of. That asymmetry is deliberate and is why this refusal is a policy
 * check here rather than an invariant inside `markDeletionCancelled`.
 */
import type { ActorRole, Source } from '@/lib/audit';
import { newCorrelationId, writeAuditRow } from '@/lib/audit';
import { getDb, type SeerrQuotaDb } from '@/lib/db';
import { quotaPolicy } from '@/lib/db/schema';
import { getEffectiveUsageBytes } from '@/lib/enforcement/usage';
import { resolveEffectiveQuota } from '@/lib/members/quota';
import { getGlobalDefaultQuotaBytes } from '@/lib/quota/policy';
import { eq } from 'drizzle-orm';
import { findScheduledDeletion, markDeletionCancelled } from './deletionStore';
import type { DeletionActor } from './types';

export type CancelOutcome =
  | 'cancelled'
  /** No such `scheduled` row — genuinely absent, already executed, already cancelled, OR not this actor's to see (`FR-DEL-24`). */
  | 'not_found'
  /** Refused: restoring these bytes would put the member back over quota (`FR-DEL-28`). */
  | 'would_exceed_quota'
  /** Lost the race — the sweeper claimed the row between our read and our write. */
  | 'already_executing';

export interface CancelResult {
  outcome: CancelOutcome;
  deletionId: number;
  titleId?: string;
  bytesRestored?: number;
  /** Set on `would_exceed_quota`: how far over the member would land. */
  overageBytes?: number;
  quotaBytes?: number;
}

export interface CancelDeletionOptions {
  source?: Source;
  nowSeconds?: number;
  db?: SeerrQuotaDb;
}

export function cancelScheduledDeletion(actor: DeletionActor, deletionId: number, opts: CancelDeletionOptions = {}): CancelResult {
  const db = opts.db ?? getDb();
  const nowSeconds = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const source: Source = opts.source ?? 'ui';
  const actorRole: ActorRole = actor.isOperator ? 'operator' : 'member';
  const correlationId = newCorrelationId();

  const row = findScheduledDeletion(db, deletionId);

  // Unknown id and "someone else's" collapse to the same answer, and the
  // same audit row — see this file's header comment.
  if (!row || (!actor.isOperator && row.ssoUsername !== actor.username)) {
    writeAuditRow(db, {
      actor: actor.username,
      actorRole,
      action: 'access.denied',
      targetType: 'title',
      targetId: row?.titleId ?? `deletion:${deletionId}`,
      outcome: 'denied',
      source,
      correlationId,
      detail: { reason: 'not_found_or_not_owner', deletionId, stage: 'cancel' },
    });
    return { outcome: 'not_found', deletionId };
  }

  // FR-DEL-28 — members only. See this file's header comment on why the
  // operator is deliberately exempt.
  if (!actor.isOperator) {
    const quotaRow = db.select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, row.ssoUsername)).get();
    const quota = resolveEffectiveQuota(quotaRow?.quotaBytes ?? null, getGlobalDefaultQuotaBytes(db));
    if (quota.kind === 'limited') {
      const projected = getEffectiveUsageBytes(db, row.ssoUsername) + row.bytesClaimed;
      if (projected > quota.bytes) {
        writeAuditRow(db, {
          actor: actor.username,
          actorRole,
          action: 'access.denied',
          targetType: 'title',
          targetId: row.titleId,
          outcome: 'denied',
          source,
          correlationId,
          detail: { reason: 'would_exceed_quota', deletionId, projectedBytes: projected, quotaBytes: quota.bytes, bytesClaimed: row.bytesClaimed },
        });
        return {
          outcome: 'would_exceed_quota',
          deletionId,
          titleId: row.titleId,
          bytesRestored: row.bytesClaimed,
          overageBytes: projected - quota.bytes,
          quotaBytes: quota.bytes,
        };
      }
    }
  }

  const cancelled = markDeletionCancelled(db, deletionId, {
    cancelledAt: nowSeconds,
    cancelledBy: actor.username,
    cancelReason: actor.isOperator && row.ssoUsername !== actor.username ? 'operator_cancelled' : 'owner_cancelled',
  });

  if (!cancelled) {
    // The conditional UPDATE found nothing still `scheduled` — the sweeper
    // got there first. Nothing to undo; say so honestly rather than
    // reporting a cancellation that didn't happen.
    return { outcome: 'already_executing', deletionId, titleId: row.titleId };
  }

  writeAuditRow(db, {
    actor: actor.username,
    actorRole,
    onBehalfOf: row.ssoUsername !== actor.username ? row.ssoUsername : undefined,
    action: 'delete.cancelled',
    targetType: 'title',
    targetId: row.titleId,
    outcome: 'ok',
    source,
    correlationId,
    before: { state: 'scheduled', scheduledFor: row.scheduledFor },
    after: { state: 'cancelled' },
    detail: { deletionId, bytesRestored: row.bytesClaimed, owner: row.ssoUsername },
  });

  return { outcome: 'cancelled', deletionId, titleId: row.titleId, bytesRestored: row.bytesClaimed };
}
