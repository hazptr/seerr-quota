/**
 * Read-only DB helpers the decision pipeline (`./process.ts`) needs before it
 * can call the pure `decide()`: a member's current attributed usage, and the
 * age of the most recent successful attribution snapshot.
 *
 * Deliberately self-contained rather than importing
 * `src/app/_data/memberDashboard.ts` / `src/components/member/logic.ts`'s
 * equivalent helpers — those live inside the member-UI agent's exclusive,
 * CONCURRENTLY-being-built scope for this task (`app/src/app/**` /
 * `app/src/components/**`, explicitly "stay out"). Depending on in-flight
 * files owned by a parallel task would make this module's correctness hostage
 * to code this task cannot review or stabilise. `src/lib/**` modules (`audit`,
 * `http`, `members/quota`, `seerr/types`, ...) are the opposite case — already
 * shipped, stable, and explicitly listed in the project's design as existing
 * code to read and use — so those ARE imported normally.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { SeerrQuotaDb } from '@/lib/db';
import { claim, syncRun } from '@/lib/db/schema';
import { getPendingDeletionBytes } from '@/lib/deletion/deletionStore';

/**
 * `SUM(claim.charged_bytes) WHERE sso_username = ? AND active = 1`
 * (`wiki/Data-Model.md` §claim — the documented per-member usage query).
 * Summed in JS rather than via SQL `SUM()` so the result is unambiguously a
 * JS `number` (not a driver-dependent `string | null` for an aggregate) —
 * cheap at this app's scale (single-digit members, a title library in the
 * hundreds, never thousands of active claims per member).
 */
export function getMemberUsageBytes(db: SeerrQuotaDb, ssoUsername: string): number {
  const rows = db
    .select({ chargedBytes: claim.chargedBytes })
    .from(claim)
    .where(and(eq(claim.ssoUsername, ssoUsername), eq(claim.active, true)))
    .all();
  return rows.reduce((total, r) => total + r.chargedBytes, 0);
}

/** Safety cap on how many recent `sync_run` rows are scanned looking for the latest successful attribution step — defends against a pathological table, not a normal (15-minute-cadence, small) history. */
const SYNC_RUN_SCAN_LIMIT = 50;

interface SyncRunStepsShape {
  attribution?: { ok?: boolean };
}

/**
 * The most recent `sync_run` row whose `steps` JSON records a successful
 * (`ok: true`) `attribution` step — i.e. the freshest claim/usage snapshot
 * enforcement can trust. `src/lib/attribution/sync.ts`'s `runAttributionSync`
 * is the only writer of a step keyed `attribution`. Returns `undefined` if no
 * such row exists yet (no reconcile has ever completed attribution) — the
 * caller treats that identically to "infinitely stale" (`snapshotAgeS: null`
 * in `./types.ts`'s `DecisionInput`), which `decide()` skips on (`FR-ENF-4`).
 *
 * Scans newest-first and stops at the first match, so a recent failed
 * attribution run (`ok: false`) does not mask an earlier good one — the
 * snapshot's DATA is still whatever the last successful run left in `claim`,
 * regardless of how many failed cycles happened since (same "leave the last
 * good value untouched on failure" discipline `src/lib/attribution/sync.ts`'s
 * header comment documents for `title`/`claim`).
 */
export function findLatestAttributionSnapshot(db: SeerrQuotaDb): { finishedAt: number } | undefined {
  const rows = db
    .select({ finishedAt: syncRun.finishedAt, steps: syncRun.steps })
    .from(syncRun)
    .orderBy(desc(syncRun.id))
    .limit(SYNC_RUN_SCAN_LIMIT)
    .all();

  for (const row of rows) {
    if (row.finishedAt === null) continue;
    let steps: SyncRunStepsShape;
    try {
      steps = JSON.parse(row.steps) as SyncRunStepsShape;
    } catch {
      continue;
    }
    if (steps.attribution?.ok === true) {
      return { finishedAt: row.finishedAt };
    }
  }
  return undefined;
}

/**
 * `FR-DEL-27` — the number every quota comparison in the app must use.
 *
 * Raw active claims, minus the bytes this member has already committed to
 * giving back via a still-`scheduled` deletion. Scheduling credits
 * immediately (the operator's "credit on schedule" decision, recorded in
 * `wiki/Feature-06-Self-Service-Deletion.md`), so a member who is out of room
 * can clear space and request again in the same sitting instead of waiting
 * out the grace period — the "just a wall" failure `wiki/Backlog.md` calls
 * out. The counterweight is `FR-DEL-28`: cancelling a scheduled deletion is
 * refused if it would put them back over.
 *
 * Clamped at zero. A pending total briefly larger than current claims is
 * reachable if attribution drops a claim while its deletion is still
 * scheduled; reporting negative usage would be worse than reporting none.
 */
export function getEffectiveUsageBytes(db: SeerrQuotaDb, ssoUsername: string): number {
  return Math.max(0, getMemberUsageBytes(db, ssoUsername) - getPendingDeletionBytes(db, ssoUsername));
}
