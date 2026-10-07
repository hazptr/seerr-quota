/**
 * First-boot / pre-reconcile empty state (P1-8 item 6: "before any reconcile
 * has run, say so. Never render zeros that look like measurements."). Shown
 * whenever `loadMemberDashboard` returns `{kind: 'no_snapshot'}` — no
 * `sync_run` row exists yet with an `attribution` step, so there is no real
 * usage/title data to show, and rendering `0.00 GB` here would look exactly
 * like a genuine, verified-empty measurement instead of the truth: nothing
 * has run yet.
 */
import { Pane } from '@/components/ui/Pane';

export function NoReconcileYet() {
  return (
    <Pane title="my usage">
      <p className="sq-empty" style={{ margin: 0 }}>
        no reconcile has run yet — usage and titles will appear here once the first sync completes
      </p>
    </Pane>
  );
}
