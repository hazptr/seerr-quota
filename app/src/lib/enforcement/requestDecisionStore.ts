/**
 * `request_decision` read/write helpers (`wiki/Data-Model.md` §request_decision).
 * `seerr_request_id` is the table's PRIMARY KEY and also the idempotency key
 * (`FR-ENF-7`) — every write here is an upsert keyed on it, never a second
 * row per request.
 */
import { eq } from 'drizzle-orm';
import type { SeerrQuotaDbOrTx } from '@/lib/audit/db-handle';
import type { SeerrQuotaDb } from '@/lib/db';
import { requestDecision } from '@/lib/db/schema';
import type { EnforcementDecision, EnforcementReason, EnforcementSource } from './types';

export interface RequestDecisionRow {
  seerrRequestId: number;
  ssoUsername: string;
  decision: EnforcementDecision;
  reason: EnforcementReason;
  /** `false` = shadow verdict, no Seerr call was made (`FR-ENF-5`). */
  enforced: boolean;
  /** `null` on a `usage_unavailable` skip — never `0` (absence != zero). */
  usageBytes: number | null;
  /** `null` on a `quota_unconfigured` skip — writing `0` would mean *unlimited* (`FR-POL-2a`). */
  quotaBytes: number | null;
  source: EnforcementSource;
  seerrStatus: number | null;
  heldSince: number | null;
  notifiedAt: number | null;
  decidedAt: number;
}

export function getRequestDecision(db: SeerrQuotaDb, seerrRequestId: number): RequestDecisionRow | undefined {
  const row = db.select().from(requestDecision).where(eq(requestDecision.seerrRequestId, seerrRequestId)).get();
  if (!row) return undefined;
  return {
    seerrRequestId: row.seerrRequestId,
    ssoUsername: row.ssoUsername,
    decision: row.decision,
    reason: row.reason,
    enforced: row.enforced,
    usageBytes: row.usageBytes,
    quotaBytes: row.quotaBytes,
    source: row.source,
    seerrStatus: row.seerrStatus,
    heldSince: row.heldSince,
    notifiedAt: row.notifiedAt,
    decidedAt: row.decidedAt,
  };
}

/** Upserts one `request_decision` row, keyed on `seerrRequestId` (`FR-ENF-7`, `FR-ENF-9`). Accepts a plain `SeerrQuotaDb` OR a transaction handle, same `SeerrQuotaDbOrTx` union `writeAuditRow` uses, so a caller can write this row and its audit row in the same `withAudit` transaction. */
export function upsertRequestDecision(dbOrTx: SeerrQuotaDbOrTx, row: RequestDecisionRow): void {
  dbOrTx
    .insert(requestDecision)
    .values(row)
    .onConflictDoUpdate({
      target: requestDecision.seerrRequestId,
      set: {
        ssoUsername: row.ssoUsername,
        decision: row.decision,
        reason: row.reason,
        enforced: row.enforced,
        usageBytes: row.usageBytes,
        quotaBytes: row.quotaBytes,
        source: row.source,
        seerrStatus: row.seerrStatus,
        heldSince: row.heldSince,
        notifiedAt: row.notifiedAt,
        decidedAt: row.decidedAt,
      },
    })
    .run();
}
