/**
 * The `RECONCILE_INTERVAL` loop — the missing piece this task exists to
 * build. `wiki/Architecture.md` §Reconciler: "One interval job
 * (`RECONCILE_INTERVAL`, default 15m)"; `wiki/Configuration.md` §Scheduling:
 * `RECONCILE_ON_BOOT` (default `true`) runs once at startup, `RECONCILE_
 * INTERVAL` (default `15m`) repeats. Every reconciler step already existed
 * and was individually tested, and `@/lib/reconcile/orchestrator.ts`'s
 * `triggerReconcile()` already runs them in dependency order for the
 * dashboard's manual button — nothing ever called it on a schedule. This
 * module is that caller; `src/instrumentation.ts` wires it up at boot.
 *
 * **Overlap prevention.** These five steps hit five upstreams and write
 * claims/decisions; two concurrent runs would race on the same tables (`title`,
 * `claim`, `request_decision`, `sync_run`). `runReconcileTick` is guarded by a
 * single module-level in-process flag (`inFlight`) shared by BOTH the boot run
 * and every interval tick (they call the exact same function), so a run can
 * never start while one is already going. Per the task brief: **skip**, don't
 * queue — a slow run (an upstream stalling near `UPSTREAM_TIMEOUT`) must not
 * let ticks pile up and then stampede once it finally finishes. The skip is
 * recorded (returned + logged as a structured JSON line, matching the
 * `event`-keyed convention already used in `src/lib/attribution/sync.ts` /
 * `src/lib/enforcement/process.ts`) rather than silently dropped.
 *
 * **A failed run must never kill the process.** `triggerReconcile()` already
 * catches at each step (`orchestrator.ts`'s own header comment) and is not
 * expected to throw in ordinary operation — but this is the LOOP boundary:
 * `runReconcileTick` wraps the call in its own `try`/`catch` as a last-resort
 * guard against a genuine unexpected throw (a bug, an OOM-adjacent failure,
 * anything). The error is logged and swallowed here; it is explicitly NOT
 * rethrown, because `src/instrumentation.ts`'s `register()` calls
 * `process.exit(1)` on a *boot-validation* failure, and a runtime reconcile
 * error reaching that same code path would take the whole app down over a
 * transient upstream hiccup. The next tick gets its own attempt regardless of
 * whether the previous one errored.
 *
 * In-process only, on purpose: this is a single-container deployment (no
 * multi-instance seerr-quota), so a `setInterval` + a boolean flag is the
 * whole story — no cron library, no distributed lock (AGENTS.md scope: no new
 * npm dependency).
 */
import { getConfig, type Config } from '@/lib/config';
import { triggerReconcile } from './orchestrator';

export type ReconcileTickTrigger = 'boot' | 'interval';

export interface ReconcileTickResult {
  trigger: ReconcileTickTrigger;
  /** `true` when this tick did nothing because a previous run was still in flight — see this file's header comment. */
  skipped: boolean;
  startedAt: number;
  finishedAt: number;
  /** Set only when `triggerReconcile()` itself threw — see this file's header comment on why that's caught here rather than rethrown. */
  error?: string;
}

/** Module-level overlap guard. Deliberately NOT reset between calls except via `_resetReconcileSchedulerForTests` — this is real process state, not test scaffolding. */
let inFlight = false;

function logEvent(level: 'warn' | 'error', event: string, fields: Record<string, unknown>): void {
  // Structured operational JSON line, matching src/lib/attribution/sync.ts / src/lib/enforcement/process.ts's existing convention.
  console[level](JSON.stringify({ event, ...fields }));
}

/**
 * Runs one reconcile cycle, or skips if one is already in flight. Exported so
 * both `startReconcileScheduler` (the boot run + every interval tick) and
 * tests can drive it directly without needing fake timers for the
 * skip/error-isolation behaviour specifically.
 */
export async function runReconcileTick(trigger: ReconcileTickTrigger): Promise<ReconcileTickResult> {
  const startedAt = Date.now();
  if (inFlight) {
    logEvent('warn', 'reconcile.skipped_overlap', { trigger, startedAt });
    return { trigger, skipped: true, startedAt, finishedAt: startedAt };
  }
  inFlight = true;
  try {
    await triggerReconcile();
    return { trigger, skipped: false, startedAt, finishedAt: Date.now() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logEvent('error', 'reconcile.tick_failed', { trigger, error: message });
    return { trigger, skipped: false, startedAt, finishedAt: Date.now(), error: message };
  } finally {
    inFlight = false;
  }
}

export interface ReconcileSchedulerHandle {
  /** Clears the interval timer. Does not interrupt a run already in flight. Test-only in practice — production never calls this (the process lives as long as the container). */
  stop(): void;
}

/**
 * Wires up the boot run and the repeating interval, per `wiki/
 * Configuration.md` §Scheduling. Called once from `src/instrumentation.ts`'s
 * `register()`, already guarded there on `NEXT_RUNTIME === 'nodejs'` so this
 * never runs during `next build` (see that file's header comment).
 *
 * The boot run and the interval both go through `runReconcileTick`, so they
 * share the same overlap guard — if `RECONCILE_ON_BOOT` fires and, on an
 * absurdly short `RECONCILE_INTERVAL`, the first tick lands before it
 * finishes, that tick is skipped exactly like any other overlap.
 *
 * The interval timer is `unref()`'d so it can never by itself keep a process
 * (or a test's Node process) alive — the HTTP server is what keeps `next
 * start` running in production; nothing here should change process lifetime.
 */
export function startReconcileScheduler(config: Config = getConfig()): ReconcileSchedulerHandle {
  const { reconcileOnBoot, reconcileIntervalMs } = config.scheduling;

  if (reconcileOnBoot) {
    void runReconcileTick('boot');
  }

  const timer = setInterval(() => {
    void runReconcileTick('interval');
  }, reconcileIntervalMs);
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

/** Test-only escape hatch: resets the overlap guard so tests don't leak `inFlight = true` state across cases if a previous case didn't let its tick settle. */
export function _resetReconcileSchedulerForTests(): void {
  inFlight = false;
}
