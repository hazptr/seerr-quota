/**
 * `FR-ADM-10`'s write half — the dashboard's manual "reconcile now" button
 * (`POST /api/admin/reconcile`, `src/app/api/admin/reconcile/route.ts`).
 *
 * The actual pipeline-ordering logic now lives in
 * `@/lib/reconcile/orchestrator.ts`, extracted out of `src/app/**` so the
 * `RECONCILE_INTERVAL` scheduler (`@/lib/reconcile/scheduler.ts`, wired up
 * from `src/instrumentation.ts`) can run the exact same five-step pipeline
 * without importing anything from the Next.js `app/` tree. This file is now
 * a thin re-export so every existing caller/import path (this route, its
 * tests) keeps working unchanged — the manual button's behaviour has not
 * changed at all.
 */
export { triggerReconcile, type ReconcileStepKind, type ReconcileStepOutcome } from '@/lib/reconcile/orchestrator';
