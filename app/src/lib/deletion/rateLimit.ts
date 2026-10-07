/**
 * `FR-DEL-12`: "a member MUST NOT be able to execute more than
 * `DELETE_MAX_PER_HOUR` (default 25) title deletions per hour. Exceeding it
 * is a denial with an audit row." Split out as its own tiny pure predicate —
 * same reasoning as the rest of this module: a one-line comparison is still
 * worth naming and testing directly rather than inlining a magic `>=` at the
 * one call site in `execute.ts`, especially given this is the guard that
 * stands between a mistake/automation bug and en-masse deletion.
 *
 * Deliberately counts only ACTUAL delete_files attempts (never releases —
 * releasing touches no file, so it isn't a "title deletion" in `FR-DEL-12`'s
 * sense) and only within the caller-supplied rolling window; see
 * `deletionStore.ts`'s `countRecentFileDeletions` for exactly what gets
 * counted.
 */
export function isOverDeleteRateLimit(recentFileDeletionCount: number, deleteMaxPerHour: number): boolean {
  return recentFileDeletionCount >= deleteMaxPerHour;
}
