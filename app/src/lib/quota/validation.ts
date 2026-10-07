/**
 * `FR-POL-9` validation. Split, same discipline as `src/lib/config.ts`:
 * `validateQuotaBytes`/`validateGraceBytes`/`checkFreeSpaceWarning` are pure
 * (no filesystem, no DB — hand-testable at the exact boundaries), and
 * `readBulkDriveFreeBytes` is the one function that touches the filesystem,
 * kept separate for that reason (mirrors `src/lib/config.ts`'s
 * `checkDbPathWritable` split from `validateConfig`).
 *
 * `validateGraceBytes`'s "skip the ceiling check when the default is unset"
 * rule mirrors `src/lib/config.ts`'s `validateConfig` EXACTLY (same skip
 * condition: `defaultQuotaBytes === null`, not `=== 0`) — `0` IS a decision
 * ("explicitly unlimited") and still participates in the ceiling check, same
 * as at boot. Kept as a literal port rather than an import because
 * `validateConfig` is boot-time-only (`Config`-shaped input) and this
 * feature's runtime setters need the same rule applied to `app_setting`
 * values instead — see `./policy.ts`.
 */
import fs from 'node:fs';

export type ValidationOutcome = { valid: true } | { valid: false; reason: string };

const ok: ValidationOutcome = { valid: true };

/** Rejects negative values and non-integer byte counts (the DB column is `integer`) and non-finite input. Used for both the global default and a per-member override — both are stored in the same `integer` shape. */
export function validateQuotaBytes(bytes: number, label: string = 'quota'): ValidationOutcome {
  if (!Number.isFinite(bytes)) {
    return { valid: false, reason: `${label} must be a finite number` };
  }
  if (bytes < 0) {
    return { valid: false, reason: `${label} must not be negative (got ${bytes})` };
  }
  if (!Number.isInteger(bytes)) {
    return { valid: false, reason: `${label} must be a whole number of bytes (got ${bytes}) — convert via gbToBytes first` };
  }
  return ok;
}

/**
 * `grace_bytes` must not be negative, and must not exceed `default_quota_bytes`
 * — EXCEPT when the default is genuinely unset (`null`), which is a valid
 * degraded state (`FR-POL-2`) the ceiling check doesn't apply to.
 */
export function validateGraceBytes(graceBytes: number, defaultQuotaBytes: number | null): ValidationOutcome {
  if (!Number.isFinite(graceBytes)) {
    return { valid: false, reason: 'grace_bytes must be a finite number' };
  }
  if (graceBytes < 0) {
    return { valid: false, reason: `grace_bytes must not be negative (got ${graceBytes})` };
  }
  if (defaultQuotaBytes !== null && graceBytes > defaultQuotaBytes) {
    return {
      valid: false,
      reason: `grace_bytes must not exceed default_quota_bytes (grace_bytes=${graceBytes}, default_quota_bytes=${defaultQuotaBytes})`,
    };
  }
  return ok;
}

/**
 * `FR-POL-9`: "MUST warn on a value above the free space on `/mnt/media`."
 * A WARNING, never a rejection — this function never returns `valid: false`
 * shaped output; it returns whether to warn and, if so, the message to show.
 * `freeBytes === undefined` (the real read failed, or wasn't attempted) means
 * "can't warn on data we don't have" — silently not-warning, never a false
 * alarm.
 */
export function checkFreeSpaceWarning(proposedBytes: number, freeBytes: number | undefined): { warn: boolean; message?: string } {
  if (freeBytes === undefined) return { warn: false };
  if (proposedBytes <= freeBytes) return { warn: false };
  return {
    warn: true,
    message: `${proposedBytes} bytes exceeds the ${freeBytes} bytes currently free on the bulk drive`,
  };
}

/**
 * The one filesystem-touching function in this module (mirrors
 * `src/lib/config.ts`'s `checkDbPathWritable`). Uses `statfsSync` — no
 * subprocess (`df`), no network. Returns `undefined` on any failure (path
 * not mounted, permission denied, not present in this environment) rather
 * than throwing: a warning that can't be computed is not itself an error
 * (`checkFreeSpaceWarning` above already treats `undefined` as "don't warn").
 * Available space is `bavail * bsize` (blocks available to an unprivileged
 * process), matching `df`'s "Avail" column — the same figure
 * a host's free-space tooling would report as e.g. "7.8 TB free". `statfs` is a
 * test seam (defaults to the real `node:fs.statfsSync`) so a test can point
 * this at a throwaway directory instead of the real bulk-media mount on a
 * production host.
 */
export function readBulkDriveFreeBytes(
  mountPath: string,
  statfs: (path: string) => { bavail: number; bsize: number } = (p) => fs.statfsSync(p),
): number | undefined {
  try {
    const stats = statfs(mountPath);
    return stats.bavail * stats.bsize;
  } catch {
    return undefined;
  }
}
