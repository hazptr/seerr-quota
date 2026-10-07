/**
 * FR-AUD-8, local half: "For a local state change, the audit row MUST be
 * written in the same transaction as the change, so the two cannot
 * diverge."
 */
import type { SeerrQuotaDb } from '@/lib/db';
import type { SeerrQuotaTx } from './db-handle';
import type { AuditRowInput } from './write';
import { newCorrelationId, writeAuditRow } from './write';

export type LocalAuditRow = Omit<AuditRowInput, 'correlationId'> & { correlationId?: string };
export type AuditRecorder = (row: LocalAuditRow) => void;

export interface LocalChangeContext {
  /** The transaction handle — every write inside `fn` must go through this, not a fresh `getDb()` call, or it won't be part of the same transaction. This is `SeerrQuotaTx`, NOT `SeerrQuotaDb` — see `./db-handle.ts`. */
  tx: SeerrQuotaTx;
  /** Records one audit row IN THE SAME TRANSACTION as the rest of `fn`. Call at least once — see this function's doc comment for what happens if you don't. */
  audit: AuditRecorder;
  /** Shared correlation id for this operation (FR-AUD-5), pre-generated so a multi-row local change doesn't have to invent its own. */
  correlationId: string;
}

/**
 * Wraps `db.transaction()` so a local state change and the audit row(s)
 * describing it commit — or roll back — together, and can never diverge.
 *
 * This is the "design the API so a caller can't easily get this wrong" half
 * for local changes: `fn` is handed a bound `audit()` recorder instead of
 * being trusted to remember to call `writeAuditRow` itself, and if `fn`
 * returns having never called it, `withAudit` THROWS — which, because it's
 * still inside the `better-sqlite3` transaction, rolls back whatever state
 * change `fn` already made. A state change with no audit trail can commit
 * only if this function has a bug, not merely if a caller forgets a line —
 * turning AGENTS.md's "Before you finish" checklist item ("every new
 * state-changing path writes an audit row") from a review-time convention
 * into a runtime guarantee.
 *
 * `fn` runs synchronously (same constraint `better-sqlite3`'s own
 * `Database#transaction()` imposes) — this is only for LOCAL DB changes.
 * Anything that calls out to Seerr/Radarr/Sonarr belongs in
 * `remote.ts`'s `runRemoteEffect` instead, never inside a `withAudit` block
 * (holding a SQLite transaction open across a network round-trip is its own
 * hazard, separate from the audit guarantee this function provides).
 */
export function withAudit<T>(db: SeerrQuotaDb, fn: (ctx: LocalChangeContext) => T): T {
  const correlationId = newCorrelationId();
  return db.transaction((tx) => {
    let wrote = false;
    const record: AuditRecorder = (row) => {
      wrote = true;
      writeAuditRow(tx, { correlationId, ...row });
    };
    const result = fn({ tx, audit: record, correlationId });
    if (!wrote) {
      throw new Error(
        'withAudit: fn completed a local change without calling audit() at least once — every local state change MUST write its audit row in the same transaction (FR-AUD-8; AGENTS.md rule 4). The transaction is being rolled back.',
      );
    }
    return result;
  });
}
