/**
 * Public surface of the audit module (P1-7, `wiki/Feature-08-Audit-Log.md`).
 * Callers elsewhere in the app should import from `@/lib/audit`, not reach
 * into individual files here.
 */
export type { ActorRole, AuditAction, Outcome, Source, TargetType } from './actions';
export { AUDIT_ACTIONS, requiresTarget } from './actions';

export { REDACTED, redactValue, serializeAuditBlob, summarizeError } from './redact';

export type { AuditWriteFailure } from './failures';
export { getAuditWriteFailures, recordAuditWriteFailure, _resetAuditWriteFailuresForTests } from './failures';

export { emitAuditLine } from './stdout';

export type { AuditRowInput, PersistedAuditRow } from './write';
export { newCorrelationId, writeAuditRow, readAuditRowsByCorrelationId } from './write';

export type { AuditRecorder, LocalAuditRow, LocalChangeContext } from './local';
export { withAudit } from './local';

export type { RemoteEffectIntent, RemoteEffectOutcome, RemoteEffectParams } from './remote';
export { runRemoteEffect } from './remote';

// P2-7 (`FR-AUD-9`/`FR-AUD-10`) — read-only browse/export + member-safe view.
export type { AuditBrowseFilter, RawAuditRow } from './browse';
export { countAuditRows, countOwnAuditRows, forEachAuditRowBatch, ownAuditWhere, queryAuditRowsPage, queryOwnAuditRowsPage } from './browse';

export type { AuditRowLike, JsonScalar, MemberSafeAuditRow } from './memberSafe';
export { toMemberSafeAuditRow } from './memberSafe';
