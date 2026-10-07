/**
 * The sweeper: the thing that actually executes deletions a member scheduled
 * and did not cancel (`FR-DEL-25`).
 *
 * ## This is not "automated destruction" (`D-11`, AGENTS.md rule 2)
 *
 * Worth being explicit, because a background job that deletes media is
 * exactly what this project forbids. Nothing here *decides* to delete
 * anything. It executes a decision a specific human already made, clicked
 * through all three steps of (`D-7`), and then declined to undo for a full
 * `DELETE_GRACE_PERIOD`. Every row it touches names that human, and the
 * audit trail attributes the deletion to them, not to `system`. The rule
 * that no *rule, timer, or heuristic* may select media for deletion is
 * untouched — this timer only controls *when* an already-chosen deletion
 * happens, and it is what buys the undo window that made deferral worth
 * doing. See `wiki/Architecture.md` `D-7`.
 *
 * ## Why it re-derives everything
 *
 * It calls `executeDeletionBatch` in sweeper mode rather than doing anything
 * itself, so the destructive path stays in exactly ONE function. That
 * function re-reads fresh state and re-runs the guards at execution time, so
 * the grace period is not merely a delay — a title somebody started watching
 * overnight is refused in the morning (`FR-DEL-26`) even though it was
 * perfectly deletable when it was scheduled.
 *
 * ## Failure isolation
 *
 * Modelled on `src/lib/reconcile/scheduler.ts`, for the same reasons: a
 * module-level in-flight flag (skip, never queue — two sweeps must not race
 * on the same rows), and a `try`/`catch` at the loop boundary so a bad tick
 * logs and is forgotten rather than taking the process down. Per-title
 * failure isolation is already `executeDeletionBatch`'s job (`FR-DEL-18`).
 */
import { getConfig } from '@/lib/config';
import { getDb, type SeerrQuotaDb } from '@/lib/db';
import { loadDueScheduledDeletions } from './deletionStore';
import { executeDeletionBatch, type ExecuteDeletionDeps } from './execute';
import type { DeletionRequestItem } from './types';

/**
 * Ceiling on how many due deletions one tick will execute. A backlog (the
 * container was down over a weekend) drains over several ticks instead of
 * issuing hundreds of `DELETE`s at Radarr in one burst.
 */
export const MAX_DELETIONS_PER_SWEEP = 25;

export interface SweepResult {
  /** True when a previous sweep was still running and this tick did nothing. */
  skipped: boolean;
  due: number;
  executed: number;
  failed: number;
  cancelled: number;
  blocked: number;
  startedAt: number;
  finishedAt: number;
  error?: string;
}

export interface RunDueDeletionsOptions {
  nowSeconds?: number;
  db?: SeerrQuotaDb;
  limit?: number;
}

function logEvent(event: string, fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- structured operational line, matching src/lib/reconcile/scheduler.ts's convention.
  console.log(JSON.stringify({ event, ...fields }));
}

/**
 * One pass. Groups due rows by their owner so each member's titles go through
 * `executeDeletionBatch` as that member — the actor on the resulting audit
 * rows is the person who scheduled the deletion, which is the whole point of
 * `D-11`'s "every byte deleted traces to a specific human".
 *
 * `isOperator: false` regardless of who the owner actually is: the operator's
 * extra powers (`onBehalfOf`, `overrideGuards`) are interactive levers for a
 * human at a keyboard, and a background sweep must never quietly exercise
 * them. An operator's own scheduled deletion is executed with exactly the
 * authority any member's would be — and if a guard has since fired on it, it
 * gets cancelled like anyone else's (`FR-DEL-26`).
 */
export async function runDueDeletions(deps: ExecuteDeletionDeps = {}, opts: RunDueDeletionsOptions = {}): Promise<Omit<SweepResult, 'skipped'>> {
  const db = opts.db ?? deps.db ?? getDb();
  const startedAt = Date.now();
  const nowSeconds = opts.nowSeconds ?? Math.floor(startedAt / 1000);
  const limit = opts.limit ?? MAX_DELETIONS_PER_SWEEP;

  const due = loadDueScheduledDeletions(db, nowSeconds, limit);
  if (due.length === 0) {
    return { due: 0, executed: 0, failed: 0, cancelled: 0, blocked: 0, startedAt, finishedAt: Date.now() };
  }

  const byOwner = new Map<string, { items: DeletionRequestItem[]; fulfilling: Map<string, number> }>();
  for (const row of due) {
    let bucket = byOwner.get(row.ssoUsername);
    if (!bucket) {
      bucket = { items: [], fulfilling: new Map() };
      byOwner.set(row.ssoUsername, bucket);
    }
    // A titleId can only appear once per owner among `scheduled` rows in
    // practice (scheduling de-dupes, and a title has one pending deletion per
    // member), but if it somehow did, first-wins keeps `fulfilling` and
    // `items` consistent with each other rather than silently mapping the
    // batch's single entry to the wrong row id.
    if (bucket.fulfilling.has(row.titleId)) continue;
    bucket.items.push({ titleId: row.titleId, requestedMode: 'delete_files' });
    bucket.fulfilling.set(row.titleId, row.id);
  }

  let executed = 0;
  let failed = 0;
  let cancelled = 0;
  let blocked = 0;

  for (const [owner, bucket] of byOwner) {
    const result = await executeDeletionBatch({ username: owner, isOperator: false }, bucket.items, deps, {
      source: 'cron',
      nowSeconds,
      fulfillingScheduledIds: bucket.fulfilling,
    });
    executed += result.summary.deleted + result.summary.alreadyGone;
    failed += result.summary.failed;
    cancelled += result.summary.cancelled;
    blocked += result.summary.blocked;
  }

  return { due: due.length, executed, failed, cancelled, blocked, startedAt, finishedAt: Date.now() };
}

/** Module-level overlap guard — real process state, reset only by `_resetDeletionSweeperForTests`. */
let inFlight = false;
let timer: ReturnType<typeof setInterval> | undefined;

export async function runSweepTick(deps: ExecuteDeletionDeps = {}, opts: RunDueDeletionsOptions = {}): Promise<SweepResult> {
  const startedAt = Date.now();
  if (inFlight) {
    logEvent('deletion.sweep_skipped', { reason: 'previous_sweep_in_flight' });
    return { skipped: true, due: 0, executed: 0, failed: 0, cancelled: 0, blocked: 0, startedAt, finishedAt: Date.now() };
  }
  inFlight = true;
  try {
    const result = await runDueDeletions(deps, opts);
    if (result.due > 0) {
      logEvent('deletion.sweep', result as unknown as Record<string, unknown>);
    }
    return { skipped: false, ...result };
  } catch (err) {
    // Loop boundary. Deliberately not rethrown — `src/instrumentation.ts`
    // exits the process on a *boot* failure, and a transient DB/upstream
    // error in a sweep reaching that path would take the whole app down.
    // The next tick gets its own attempt.
    const message = err instanceof Error ? err.message : String(err);
    logEvent('deletion.sweep_failed', { error: message });
    return { skipped: false, due: 0, executed: 0, failed: 0, cancelled: 0, blocked: 0, startedAt, finishedAt: Date.now(), error: message };
  } finally {
    inFlight = false;
  }
}

/**
 * Starts the `DELETE_SWEEP_INTERVAL` loop. Deliberately does NOT run a sweep
 * at boot: a container restart is exactly when state is least settled (the
 * reconciler hasn't run, playback may be unavailable), and `FR-DEL-21` would
 * have every guard fail-safe into cancelling perfectly good scheduled
 * deletions. Waiting one interval costs nothing — the grace period is hours.
 */
export function startDeletionSweeper(): void {
  const config = getConfig();
  if (timer) return;
  timer = setInterval(() => {
    void runSweepTick();
  }, config.scheduling.deleteSweepIntervalMs);
  // Never hold the process open for a sweep — matches the reconcile scheduler.
  timer.unref?.();
  logEvent('deletion.sweeper_started', { intervalMs: config.scheduling.deleteSweepIntervalMs, gracePeriodMs: config.scheduling.deleteGracePeriodMs });
}

export function _resetDeletionSweeperForTests(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  inFlight = false;
}
