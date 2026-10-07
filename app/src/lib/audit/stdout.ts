/**
 * FR-AUD-6: "Every row MUST also be written to stdout as one line of JSON."
 * — an independent copy so `docker logs seerr-quota` survives a DB write
 * failure. Called by `writeAuditRow` (`./write.ts`) BEFORE the DB insert is
 * attempted, precisely so this copy exists even when that insert throws.
 */
import type { PersistedAuditRow } from './write';

export function emitAuditLine(row: PersistedAuditRow): void {
  const line = JSON.stringify(row);
  try {
    process.stdout.write(line + '\n');
  } catch (err) {
    // A stdout write failing is exceptional (e.g. EPIPE) — fall back to
    // stderr rather than losing the event silently. Does not throw further:
    // writeAuditRow still attempts the DB insert regardless.
    // eslint-disable-next-line no-console
    console.error('seerr-quota audit: failed to write stdout JSON line', err);
  }
}
