/**
 * The single low-level entry point that turns an `AuditRowInput` into a
 * persisted, redacted, doubly-written row. Everything else in this module
 * (`local.ts`'s `withAudit`, `remote.ts`'s `runRemoteEffect`) is a thin
 * wrapper around this that shapes the transaction/timing guarantees around
 * it — neither one bypasses it.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { SeerrQuotaDb } from '@/lib/db';
import { audit } from '@/lib/db/schema';
import { getConfig } from '@/lib/config';
import type { ActorRole, AuditAction, Outcome, Source, TargetType } from './actions';
import type { SeerrQuotaDbOrTx } from './db-handle';
import { requiresTarget } from './actions';
import { serializeAuditBlob } from './redact';
import { emitAuditLine } from './stdout';
import { recordAuditWriteFailure } from './failures';

export interface AuditRowInput {
  /** Unix ms; defaults to `Date.now()`. Overriding is a test-only escape hatch — no production caller should need to. */
  ts?: number;
  /** `sso_username`, or `'system'` for reconciler/webhook/poller actions. */
  actor: string;
  actorRole: ActorRole;
  /** Set when an operator acts on a member's data. */
  onBehalfOf?: string;
  action: AuditAction;
  targetType?: TargetType;
  targetId?: string;
  /** JSON-serializable; redacted + size-capped by `serializeAuditBlob` before storage. */
  before?: unknown;
  after?: unknown;
  outcome: Outcome;
  detail?: unknown;
  source: Source;
  correlationId: string;
}

/** The shape actually persisted to `audit` and emitted to stdout — every JSON blob already redacted, truncated-if-needed, and serialized. */
export interface PersistedAuditRow {
  ts: number;
  actor: string;
  actorRole: ActorRole;
  onBehalfOf: string | null;
  action: AuditAction;
  targetType: TargetType | null;
  targetId: string | null;
  before: string | null;
  after: string | null;
  outcome: Outcome;
  detail: string | null;
  source: Source;
  correlationId: string;
}

/** FR-AUD-5: generates a fresh id to group the rows of one multi-step operation. */
export function newCorrelationId(): string {
  return randomUUID();
}

function knownSecretValues(): string[] {
  return Object.values(getConfig().secrets).filter((value) => value.length > 0);
}

/**
 * Inserts exactly one row into `audit`, after:
 *   1. Validating the action carries a `targetId` if its vocabulary-table
 *      "Target" column isn't `—` (FR-AUD-3) — thrown BEFORE anything is
 *      emitted or written, so a caller finds this at the call site, not by
 *      noticing a hole in the log later.
 *   2. Redacting + size-capping `before`/`after`/`detail` (FR-AUD-11, and the
 *      "very large blob" edge case) via `serializeAuditBlob`.
 *   3. Emitting the stdout JSON line (FR-AUD-6) — BEFORE the DB insert is
 *      even attempted, so that independent copy exists regardless of
 *      whether the insert below succeeds.
 *   4. Inserting into `audit` — an INSERT only, never `.update`/`.delete`
 *      (see `test/audit-append-only.test.ts`).
 *
 * Accepts a `SeerrQuotaDbOrTx` — a plain `SeerrQuotaDb` (`getDb()`'s return
 * type) OR the `tx` handle Drizzle passes into `db.transaction(tx => ...)`
 * (see `./db-handle.ts` for why these need an explicit union type rather
 * than being interchangeable). That's what lets this same function serve
 * both halves of FR-AUD-8: called with a `tx` from `local.ts`'s `withAudit`
 * (so the row commits/rolls back with the local change it describes), or
 * called with the plain `db` handle from `remote.ts`'s `runRemoteEffect` (so
 * the intent/outcome rows commit immediately, independent of the in-flight
 * remote call between them).
 *
 * On a DB insert failure: logs it via `recordAuditWriteFailure`
 * (FR-AUD-7 — error-level log + surfaced to `getAuditWriteFailures()`), then
 * RETHROWS. Never swallows the error. Inside a transaction this rolls back
 * the whole transaction (including whatever state change the row
 * describes); outside one, it forces the caller to decide how to handle a
 * write it cannot pretend succeeded.
 */
export function writeAuditRow(db: SeerrQuotaDbOrTx, input: AuditRowInput): void {
  if (requiresTarget(input.action) && !input.targetId) {
    throw new Error(
      `writeAuditRow: action '${input.action}' requires a targetId — its wiki/Feature-08-Audit-Log.md vocabulary-table "Target" entry is not "—" (FR-AUD-3)`,
    );
  }

  const secrets = knownSecretValues();
  const row: PersistedAuditRow = {
    ts: input.ts ?? Date.now(),
    actor: input.actor,
    actorRole: input.actorRole,
    onBehalfOf: input.onBehalfOf ?? null,
    action: input.action,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    before: serializeAuditBlob(input.before, secrets),
    after: serializeAuditBlob(input.after, secrets),
    outcome: input.outcome,
    detail: serializeAuditBlob(input.detail, secrets),
    source: input.source,
    correlationId: input.correlationId,
  };

  // FR-AUD-6: written twice — emitted BEFORE the DB insert is even attempted.
  emitAuditLine(row);

  try {
    db.insert(audit).values(row).run();
  } catch (err) {
    recordAuditWriteFailure(row, err);
    throw err;
  }
}

/** Convenience read helper for FR-AUD-5 (grouping) — used by tests and, eventually, the admin log browser (FR-AUD-9). Ordered oldest-first. */
export function readAuditRowsByCorrelationId(db: SeerrQuotaDb, correlationId: string) {
  return db.select().from(audit).where(eq(audit.correlationId, correlationId)).orderBy(audit.ts).all();
}
