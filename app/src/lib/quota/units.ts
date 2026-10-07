/**
 * `FR-POL-9`: "Quota values MUST be entered and displayed in GB (decimal)
 * and stored in bytes." This is the ONE place that conversion happens —
 * every other module in this feature (`./preview.ts`, `./policy.ts`) works
 * in bytes only, and the (not-yet-built) admin UI converts at its edges by
 * calling these two functions, never by hand-rolling `* 1_000_000_000`
 * somewhere else. `FR-ACCT-9`/`src/components/member/logic.ts`'s
 * `formatGB` already fixed decimal (10^9, not 2^30) as the house
 * convention — `BYTES_PER_GB` here is the same constant, kept local rather
 * than imported so this module has zero dependency on `src/components/**`.
 */

export const BYTES_PER_GB = 1_000_000_000;

/**
 * Decimal GB -> bytes, rounded to the nearest whole byte (the DB column is
 * `integer`; a fractional byte count could never be written faithfully).
 * Throws on non-finite input (`NaN`/`Infinity`) — a malformed number should
 * fail loudly at the conversion boundary, not silently become `0` or a
 * garbage byte count that then passes `validateQuotaBytes` by accident.
 * Negative values are NOT rejected here — that's `validateQuotaBytes`'s job
 * (`./validation.ts`), so a negative-GB input still converts predictably and
 * can be reported back to the user in the same units they typed.
 */
export function gbToBytes(gb: number): number {
  if (!Number.isFinite(gb)) {
    throw new RangeError(`gbToBytes: expected a finite number of GB, got ${gb}`);
  }
  return Math.round(gb * BYTES_PER_GB);
}

/** Bytes -> decimal GB, exact division (no rounding — display-time formatting, e.g. `.toFixed(2)`, is the caller's job). */
export function bytesToGb(bytes: number): number {
  return bytes / BYTES_PER_GB;
}
