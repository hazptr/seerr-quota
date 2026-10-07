/**
 * The pipeline-ordering logic for a full reconcile cycle — runs the five
 * reconciler entry points (`src/lib/{members,library,playback,attribution}/
 * sync.ts`, `src/lib/enforcement/poller.ts`) in dependency order: members and
 * library/requests before attribution (which reads both), playback before
 * attribution (which reads `title.watched_by_anyone`), pending sweep last (it
 * needs a fresh attribution snapshot to decide against). Matches
 * `@/components/admin/logic`'s `ALL_PIPELINE_KINDS` order, which the
 * (already-built, read-only) `SyncStatusPane` displays.
 *
 * Originally lived in `src/app/admin/_actions/reconcileActions.ts` (the
 * dashboard's manual "reconcile now" button, `FR-ADM-10`). Extracted here so
 * `src/lib/reconcile/scheduler.ts` — the `RECONCILE_INTERVAL` timer loop —
 * can call the SAME function without importing anything from `src/app/**`.
 * `reconcileActions.ts` now just re-exports `triggerReconcile` from this
 * module; behaviour for the manual button is unchanged.
 *
 * **No new write surface.** This calls the SAME functions — with the SAME
 * `sync_run`/audit conventions those modules already implement internally —
 * whether triggered by the manual button, the boot run, or a scheduled tick.
 * In particular `runPendingSweep`'s last step evaluates every pending Seerr
 * request via `processPendingRequest(id, 'poller' | ..., ...)`, which CAN
 * call Seerr's approve/decline endpoints, but only when `enforcement_enabled`
 * is true; this is pre-existing, already-audited behaviour, not a new one.
 *
 * Each of the five functions is `runStep`-wrapped internally and does not
 * throw for an ordinary upstream failure (see each module's own header
 * comment); the `try`/`catch` here is a last-resort guard against a genuine
 * local error (e.g. a DB write failure) so one bad step can't stop the rest
 * of the chain from attempting to run.
 */
import { syncMembers } from '@/lib/members/sync';
import { runLibraryAndRequestSync } from '@/lib/library/sync';
import { runPlaybackSync } from '@/lib/playback/sync';
import { runAttributionSync } from '@/lib/attribution/sync';
import { runPendingSweep } from '@/lib/enforcement/poller';

export type ReconcileStepKind = 'members' | 'library_requests' | 'playback' | 'attribution' | 'pending_sweep';

export interface ReconcileStepOutcome {
  step: ReconcileStepKind;
  /** `false` only on a genuine thrown error from this step (see this file's header comment) — an ordinary upstream failure is already absorbed internally and still reports `true` here (the REAL per-step detail is `sync_run.steps`, read by the existing `SyncStatusPane` after a refresh, not this summary). */
  ok: boolean;
  error?: string;
}

async function runStepSafely(step: ReconcileStepKind, fn: () => Promise<unknown>): Promise<ReconcileStepOutcome> {
  try {
    await fn();
    return { step, ok: true };
  } catch (err) {
    return { step, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** `FR-ADM-10`: kicks off all five reconciler pipelines in order, sequentially (each later step reads state the earlier ones just wrote). Never throws. */
export async function triggerReconcile(): Promise<ReconcileStepOutcome[]> {
  const outcomes: ReconcileStepOutcome[] = [];
  outcomes.push(await runStepSafely('members', () => syncMembers()));
  outcomes.push(await runStepSafely('library_requests', () => runLibraryAndRequestSync()));
  outcomes.push(await runStepSafely('playback', () => runPlaybackSync()));
  outcomes.push(await runStepSafely('attribution', () => runAttributionSync()));
  outcomes.push(await runStepSafely('pending_sweep', () => runPendingSweep()));
  return outcomes;
}
