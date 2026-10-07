/**
 * Pure derivation logic behind the member view (P1-8,
 * `wiki/Backlog.md`: "My usage": quota, usage, %, my titles sorted by
 * unwatched-bytes-descending, with size, watched state, and last played).
 * No I/O, no `Date.now()`, no DB — every input is plain data so it's
 * hand-testable (AGENTS.md rule 9, and this task's explicit instruction to
 * keep formatting/sorting/state-derivation out of JSX). The impure shell
 * that feeds this from the DB is `src/app/_data/memberDashboard.ts`.
 */
import type { EffectiveQuota } from '@/lib/members/quota';

// ---------------------------------------------------------------------------
// Sizes — FR-ACCT-9: decimal GB (10^9), always labelled, matching
// `analysis/attribution.py`'s `size_bytes/1e9:.2f` convention.
// ---------------------------------------------------------------------------

export function formatGB(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

// ---------------------------------------------------------------------------
// Quota display — FR-POL-2a's three states, turned into what the member
// page needs to render (percentage, remaining, over-quota flag). Never
// promotes "unconfigured" to a number.
// ---------------------------------------------------------------------------

export type QuotaDisplay =
  | { kind: 'unconfigured'; usedBytes: number }
  | { kind: 'unlimited'; usedBytes: number }
  | {
      kind: 'limited';
      quotaBytes: number;
      usedBytes: number;
      remainingBytes: number;
      percentUsed: number;
      overQuota: boolean;
    };

export function deriveQuotaDisplay(effective: EffectiveQuota, usedBytes: number): QuotaDisplay {
  if (effective.kind === 'unconfigured') return { kind: 'unconfigured', usedBytes };
  if (effective.kind === 'unlimited') return { kind: 'unlimited', usedBytes };
  const remainingBytes = effective.bytes - usedBytes;
  const percentUsed = (usedBytes / effective.bytes) * 100;
  return {
    kind: 'limited',
    quotaBytes: effective.bytes,
    usedBytes,
    remainingBytes,
    percentUsed,
    overQuota: usedBytes > effective.bytes,
  };
}

// ---------------------------------------------------------------------------
// Freshness — FR-ACCT-8: every figure carries its snapshot timestamp and is
// visibly marked stale past STALE_SNAPSHOT_MAX_AGE(_S).
// ---------------------------------------------------------------------------

export interface Freshness {
  ageSeconds: number;
  stale: boolean;
}

export function computeFreshness(snapshotEpochSeconds: number, nowEpochSeconds: number, maxAgeSeconds: number): Freshness {
  const ageSeconds = Math.max(0, nowEpochSeconds - snapshotEpochSeconds);
  return { ageSeconds, stale: ageSeconds > maxAgeSeconds };
}

/** Short, human relative-age string for the freshness note ("just now" / "12m ago" / "3h ago" / "2d ago"). */
export function formatAge(ageSeconds: number): string {
  if (ageSeconds < 60) return 'just now';
  const minutes = Math.floor(ageSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Renders an epoch-seconds timestamp in the given IANA timezone
 * (`Config.display.tz`), e.g. `2026-08-24 14:32 EDT`. Deterministic for a
 * given (epochSeconds, timeZone) pair — the timezone is an explicit
 * parameter (never read from the environment here) so this stays pure.
 */
export function formatTimestamp(epochSeconds: number, timeZone: string): string {
  const date = new Date(epochSeconds * 1000);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    // `hourCycle: 'h23'` (not just `hour12: false`) — some ICU builds render
    // midnight as "24:00" under `hour12: false` alone; `h23` pins it to
    // 00:00-23:59.
    hourCycle: 'h23',
    timeZoneName: 'short',
  });
  // en-CA's default separator is ", " between date and time — collapse to a single space.
  return formatter.format(date).replace(', ', ' ');
}

// ---------------------------------------------------------------------------
// Title ordering — largest charged_bytes first, full stop. (Originally
// grouped unwatched-before-watched on top of that, on the theory that
// unwatched titles are more "worth deleting" — dropped 2026-08-25: from the
// table, that reads as simply not sorted by size, since a small unwatched
// title would rank above a much larger watched one.)
// ---------------------------------------------------------------------------

export interface MemberTitleRow {
  titleId: string;
  name: string;
  year: number | null;
  chargedBytes: number;
  watchedByAnyone: boolean;
  /** Unix seconds; `null` if never played. */
  lastPlayedAnyAt: number | null;
  /** Needed to tell a part-watched series from a played movie (`deriveWatchState`). */
  mediaType?: 'movie' | 'tv' | null;
  /** Furthest-progressed viewer's episode count; `null` for movies/unknown. */
  episodesPlayed?: number | null;
  /** The series' episode count at last sync; `null` for movies/unknown. */
  episodesTotal?: number | null;
  /** Count of OTHER members (not this one) with an active claim on the same title — D-3: co-requested titles are charged in FULL to every claimant, never divided. */
  otherActiveClaimants: number;
}

export function sortMemberTitles(rows: readonly MemberTitleRow[]): MemberTitleRow[] {
  return [...rows].sort((a, b) => b.chargedBytes - a.chargedBytes);
}

// ---------------------------------------------------------------------------
// Snapshot selection — FR-ACCT-8 needs a concrete "this is the run these
// numbers came from" timestamp. `sync_run` (`src/lib/db/schema.ts`) has one
// row per reconcile step across several independent modules
// (`src/lib/{members,library,playback,attribution}/sync.ts`), each keying
// its own `steps` JSON differently; the attribution step
// (`src/lib/attribution/sync.ts`'s `runAttributionSync`) is the one that
// actually wrote the `claim`/usage figures this page shows, so it's the
// relevant snapshot for usage + titles.
// ---------------------------------------------------------------------------
export interface SyncRunLike {
  id: number;
  /** Unix seconds; `null` while a run is still in progress. */
  finishedAt: number | null;
  /** Raw `sync_run.steps` JSON text. */
  steps: string;
}

/** The most recent COMPLETED sync_run whose `steps` JSON contains an `attribution` key, or `undefined` if attribution has never run. */
export function findLatestAttributionSnapshot(rows: readonly SyncRunLike[]): { syncRunId: number; finishedAt: number } | undefined {
  let best: { syncRunId: number; finishedAt: number } | undefined;
  for (const row of rows) {
    if (row.finishedAt === null) continue;
    let steps: unknown;
    try {
      steps = JSON.parse(row.steps);
    } catch {
      continue;
    }
    if (steps === null || typeof steps !== 'object' || !('attribution' in steps)) continue;
    if (!best || row.finishedAt > best.finishedAt) best = { syncRunId: row.id, finishedAt: row.finishedAt };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Status severity — a small shared vocabulary (good/warning/critical) so a
// state that matters is colour-coded consistently everywhere it appears,
// ADDITIONAL to (never a replacement for) the text/glyph indicator FR-UI-7
// already requires. `critical` reuses `--sq-critical` (formerly reserved
// for destructive controls only, FR-UI-5, revised 2026-08-25 for full status
// coloring per the operator) so the single most severe tier — over quota, a
// failed sync step, a declined request, an audit error — reads as urgent
// everywhere, not just on a delete button.
// ---------------------------------------------------------------------------
export type Severity = 'good' | 'warning' | 'critical';

export function severityColorVar(severity: Severity): string {
  switch (severity) {
    case 'good':
      return 'var(--sq-good)';
    case 'warning':
      return 'var(--sq-warning)';
    case 'critical':
      return 'var(--sq-critical)';
  }
}

/**
 * Same vocabulary as `severityColorVar`, but for a solid FILL (a background,
 * e.g. the quota usage bar) rather than text/glyph colour. `--sq-critical`
 * is deliberately a TEXT-only token (tuned for 4.5:1 contrast as foreground
 * copy); a solid fill reuses `--sq-critical-fill` instead, same token the
 * destructive button uses, so a critical fill reads consistently wherever
 * it appears. `good`/`warning` have no separate fill token (they were
 * already fill-safe), so those two cases are identical to `severityColorVar`.
 */
export function severityFillVar(severity: Severity): string {
  return severity === 'critical' ? 'var(--sq-critical-fill)' : severityColorVar(severity);
}

/** Quota-bar / usage-percentage severity: at or over 100% is critical, the last 20 points before it is a warning, everything else reads as healthy. */
export function quotaSeverity(percentUsed: number): Severity {
  if (percentUsed >= 100) return 'critical';
  if (percentUsed >= 80) return 'warning';
  return 'good';
}

/** Audit-row severity (`@/lib/audit`'s `Outcome`) — `denied` is an expected policy block, not a failure, so it reads as a warning rather than critical; `error` is the one severity reserved for something actually going wrong. */
export function outcomeSeverity(outcome: 'ok' | 'denied' | 'error'): Severity {
  switch (outcome) {
    case 'ok':
      return 'good';
    case 'denied':
      return 'warning';
    case 'error':
      return 'critical';
  }
}

// ---------------------------------------------------------------------------
// Runtime settings — `wiki/Configuration.md`: "Operator-editable runtime
// settings ... live in the `app_setting` table, which wins over all three
// [env/config.yaml/default] once set." Mirrors
// `src/lib/members/sync.ts`'s `resolveDefaultQuotaBytes` JSON-parse-with-
// fallback shape for a different key (`stale_snapshot_max_age_s`), since
// that function is private to that module, so this is a deliberate local copy.
// ---------------------------------------------------------------------------
export function resolveNumericRuntimeSetting(row: { value: string } | undefined, fallback: number): number {
  if (!row) return fallback;
  try {
    const parsed = JSON.parse(row.value);
    return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}
