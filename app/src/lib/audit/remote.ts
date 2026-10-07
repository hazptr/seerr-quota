/**
 * FR-AUD-8, remote half: "For a remote effect (Seerr, Radarr, Sonarr), an
 * intent row MUST be written before the call and an outcome row after, both
 * sharing a correlation_id — so a crash mid-call leaves evidence that the
 * call may have happened."
 */
import type { SeerrQuotaDb } from '@/lib/db';
import type { AuditRowInput } from './write';
import { newCorrelationId, writeAuditRow } from './write';

export type RemoteEffectIntent = Omit<AuditRowInput, 'outcome' | 'correlationId'> & { correlationId?: string };
export type RemoteEffectOutcome = Omit<AuditRowInput, 'actor' | 'actorRole' | 'onBehalfOf' | 'source' | 'correlationId'>;

export interface RemoteEffectParams<T> {
  /** Written and durably committed BEFORE `call()` runs. Its `outcome` is implicitly `'ok'` — recording the intent itself always succeeds if this function got this far. */
  intent: RemoteEffectIntent;
  /** The actual upstream call (Seerr/Radarr/Sonarr/...). */
  call: () => Promise<T>;
  /** Builds the outcome row for the success path. Required — see this function's doc comment. */
  onSuccess: (value: T) => RemoteEffectOutcome;
  /** Builds the outcome row for the failure path. Required — see this function's doc comment. */
  onFailure: (error: unknown) => RemoteEffectOutcome;
}

/**
 * Writes an INTENT row, then calls out, then writes an OUTCOME row — intent
 * and outcome sharing one `correlationId` (FR-AUD-5). This is the
 * "design the API so a caller can't easily get this wrong" half for remote
 * effects: `onSuccess` AND `onFailure` are both REQUIRED parameters, so
 * `tsc --noEmit` refuses to compile a caller that only records the happy
 * path — there is no way to call this and silently drop the failure
 * outcome. If `call()` rejects, its outcome row is written and the original
 * error is always rethrown afterward (never swallowed here); the intent row
 * from before the call is unaffected either way, which is exactly the
 * acceptance criterion this exists for: "Given the app is restarted
 * mid-delete, when the log is read, then a `delete.requested` row exists
 * with no matching outcome row, making the ambiguity visible rather than
 * invisible" — a real process crash between the two `writeAuditRow` calls
 * below produces precisely that state, because each call is its own
 * committed SQLite write, not one transaction spanning the network call.
 *
 * Deliberately does NOT wrap `call()` (or either `writeAuditRow`) in a
 * `db.transaction()` — a transaction can't span a network round-trip
 * (`better-sqlite3` transactions are synchronous), and even if it could,
 * holding one open across an upstream call would be its own hazard. Local,
 * same-process state changes belong in `local.ts`'s `withAudit` instead.
 */
export async function runRemoteEffect<T>(db: SeerrQuotaDb, params: RemoteEffectParams<T>): Promise<T> {
  const { intent, call, onSuccess, onFailure } = params;
  const correlationId = intent.correlationId ?? newCorrelationId();

  writeAuditRow(db, { ...intent, outcome: 'ok', correlationId });

  let value: T;
  try {
    value = await call();
  } catch (error) {
    const outcome = onFailure(error);
    writeAuditRow(db, {
      actor: intent.actor,
      actorRole: intent.actorRole,
      onBehalfOf: intent.onBehalfOf,
      source: intent.source,
      correlationId,
      ...outcome,
    });
    throw error;
  }

  const outcome = onSuccess(value);
  writeAuditRow(db, {
    actor: intent.actor,
    actorRole: intent.actorRole,
    onBehalfOf: intent.onBehalfOf,
    source: intent.source,
    correlationId,
    ...outcome,
  });
  return value;
}
