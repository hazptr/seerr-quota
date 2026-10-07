/**
 * FR-AUD-7: "Audit writes MUST NOT be able to fail silently. If the DB write
 * throws, the failure MUST be logged at error level and MUST be visible in
 * the admin dashboard's attention panel."
 *
 * The attention panel itself is a later backlog item (the admin UI hasn't
 * been built yet) — this in-process ring buffer is the surface it will read
 * from once it exists (`getAuditWriteFailures()`). A process restart clears
 * it, which is acceptable: the stderr line logged here (one JSON object per
 * failure, always emitted regardless of `LOG_LEVEL`) is the durable record,
 * matching `src/instrumentation.ts`'s existing convention of boot-failure
 * diagnostics bypassing the configured log level.
 */

export interface AuditWriteFailure {
  /** Unix ms — when the DB write threw, not when the audited event happened. */
  ts: number;
  message: string;
  /** The row that failed to persist — already redacted/truncated by `writeAuditRow` before this is called, so it's safe to retain and to log. */
  row: unknown;
}

const MAX_RETAINED = 100;
let failures: AuditWriteFailure[] = [];

/** Called by `writeAuditRow` (`./write.ts`) exactly where the DB insert throws — never call this for anything else. */
export function recordAuditWriteFailure(row: unknown, err: unknown): AuditWriteFailure {
  const entry: AuditWriteFailure = {
    ts: Date.now(),
    message: err instanceof Error ? err.message : String(err),
    row,
  };
  failures.push(entry);
  if (failures.length > MAX_RETAINED) failures.shift();
  try {
    // eslint-disable-next-line no-console -- audit write failures MUST reach stderr at error level regardless of LOG_LEVEL (FR-AUD-7), same convention as src/instrumentation.ts's boot-failure diagnostics.
    console.error(JSON.stringify({ level: 'error', msg: 'seerr-quota audit: DB write failed', ...entry }));
  } catch {
    // JSON.stringify/console.error themselves failing here is not recoverable further; writeAuditRow still rethrows the original error to its caller regardless.
  }
  return entry;
}

/** Read-only snapshot for the (future) admin dashboard attention panel. */
export function getAuditWriteFailures(): readonly AuditWriteFailure[] {
  return [...failures];
}

/** Test-only escape hatch. */
export function _resetAuditWriteFailuresForTests(): void {
  failures = [];
}
