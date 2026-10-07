/**
 * Next.js instrumentation hook (stable since Next 14, no config flag needed —
 * this app is on 15.5.20). `register()` runs once per server process at boot
 * — exactly where `wiki/Configuration.md` §"Validation at boot" needs to run:
 * before the app starts serving, resolve config and refuse to start on a
 * misconfiguration it cannot safely proceed under, naming exactly which
 * setting is wrong (`assertBootValid`, `src/lib/config.ts`).
 *
 * This deliberately does NOT probe any upstream (Seerr/Radarr/Sonarr/
 * Jellyfin/Authentik) — an unreachable upstream is a runtime condition, not a
 * misconfiguration, and the wiki is explicit that refusing to boot over it
 * "would be its own outage." No such reachability check happens here; the
 * reconciler started below discovers upstream trouble on its own schedule,
 * fails that step in isolation, and does not block boot on it.
 *
 * **Why this catches and calls `process.exit(1)` itself, rather than just
 * letting `assertBootValid` throw**: verified by running the built runner
 * image with `ENFORCEMENT_ENABLED=true` and no SMTP creds — confirmed that
 * a thrown error here does NOT stop `next start` — Next logs it as
 * `Failed to prepare server` / an `unhandledRejection` and the HTTP server
 * keeps listening and serving traffic anyway. A "refuse to start" rule that
 * leaves the process up and answering requests is not refusing to start, so
 * the failure is logged to stderr in full (every named setting) and the
 * process is killed explicitly here instead of trusting Next's error path.
 * `return`s immediately after so a test-mocked `process.exit` (which, unlike
 * the real thing, doesn't actually halt execution) can't fall through into
 * opening the DB / starting the reconcile scheduler below on a config the
 * app just refused to boot with.
 *
 * **After boot validation passes**, two more things happen, both gated on
 * the same `NEXT_RUNTIME === 'nodejs'` check as validation itself (so
 * neither ever runs during `next build`, which does not set that env var to
 * `'nodejs'` — see `test/instrumentation.test.ts`'s "no-op when NEXT_RUNTIME
 * is not nodejs" case):
 *
 *   1. `getDb()` (`@/lib/db`) is called once, forcing the lazy SQLite file
 *      open + idempotent `ensureSchema` migration to happen NOW, at boot,
 *      rather than on whatever request or reconcile tick happens to touch
 *      the DB first. Idempotent by construction (drizzle's own
 *      `__drizzle_migrations` bookkeeping table) — safe to call on every
 *      restart.
 *   2. `startReconcileScheduler()` (`@/lib/reconcile/scheduler.ts`) wires up
 *      the `RECONCILE_ON_BOOT` / `RECONCILE_INTERVAL` loop that actually
 *      calls the reconciler on a schedule — this app was otherwise
 *      completely inert (every step existed, individually tested, and
 *      wired into `sync_run`; nothing ever called any of them). See that
 *      module's header comment for the overlap-prevention and
 *      failure-isolation details.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { getConfig, assertBootValid, BootValidationFailure } = await import('@/lib/config');
    try {
      assertBootValid(getConfig());
    } catch (err) {
      if (err instanceof BootValidationFailure) {
        // eslint-disable-next-line no-console -- boot-failure diagnostics MUST reach stderr even if LOG_LEVEL suppresses info logging elsewhere.
        console.error(err.message);
      } else {
        // eslint-disable-next-line no-console
        console.error('seerr-quota refused to start: unexpected error during boot validation', err);
      }
      process.exit(1);
      return;
    }

    const { getDb } = await import('@/lib/db');
    getDb();

    const { startReconcileScheduler } = await import('@/lib/reconcile/scheduler');
    startReconcileScheduler();

    //   3. `startDeletionSweeper()` (`@/lib/deletion/runner.ts`) — the
    //      `DELETE_SWEEP_INTERVAL` loop that executes deletions members
    //      scheduled and did not cancel (`FR-DEL-25`). It selects nothing to
    //      delete on its own; see that module's header comment for why this
    //      is not the "automated destruction" AGENTS.md rule 2 forbids.
    const { startDeletionSweeper } = await import('@/lib/deletion/runner');
    startDeletionSweeper();
  }
}
