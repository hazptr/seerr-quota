/**
 * The admin dashboard's main screen (P1-9, `wiki/Feature-07-Admin-Dashboard.md`
 * `FR-ADM-2/3/4/9/13`). Operator-only, enforced server-side (`FR-ADM-1`) via
 * `requireOperator` — the SAME guard every other operator-only path in this
 * app uses, so a member hitting this URL directly gets a genuine HTTP 403
 * (via `forbidden()`, `next.config.mjs`'s `experimental.authInterrupts`) and
 * an `access.denied` audit row (written by `requireOperator` itself, before
 * it throws) — never just a client-hidden link.
 *
 * P2-5 adds the mutating controls this file's original P1-9 comment
 * deferred: `DefaultQuotaEditor` (`FR-ADM-6`'s global-default half),
 * `SettingsPane` (`FR-ADM-11`, including the `enforcement_enabled` toggle),
 * and `ReconcileTrigger` inside `SyncStatusPane` (`FR-ADM-10`). Every
 * mutation re-checks operator status server-side on its own route
 * (`src/app/api/admin/**`, `FR-ADM-1`) — this page rendering the controls at
 * all already required `requireOperator` above, but each POST is
 * independently guarded too, since a hidden/absent button is not
 * authorization.
 */
import { forbidden, unauthorized } from 'next/navigation';
import { AppShell } from '@/components/shell/AppShell';
import { AdminSnapshotBar } from '@/components/admin/AdminSnapshotBar';
import { DefaultQuotaEditor } from '@/components/admin/DefaultQuotaEditor';
import { FleetPane } from '@/components/admin/FleetPane';
import { MemberTablePane } from '@/components/admin/MemberTablePane';
import { NeedsAttentionPane } from '@/components/admin/NeedsAttentionPane';
import { PendingDeletionsPane } from '@/components/member/PendingDeletionsPane';
import { EntitlementMismatchPane } from '@/components/admin/EntitlementMismatchPane';
import { ReconcileTrigger } from '@/components/admin/ReconcileTrigger';
import { SettingsPane } from '@/components/admin/SettingsPane';
import { SyncStatusPane } from '@/components/admin/SyncStatusPane';
import { Pane } from '@/components/ui/Pane';
import { AuthError, requireOperator } from '@/lib/auth/authorize';
import { getConfig } from '@/lib/config';
import type { Identity } from '@/lib/auth/identity';
import { loadAdminDashboard } from './_data/dashboard';
import { loadEntitlementMismatch } from './_data/entitlement';
import { loadPendingDeletions } from './_data/pendingDeletions';
import { loadCurrentSettings } from './_data/settings';

async function requireOperatorOrRespond(): Promise<Identity> {
  try {
    return await requireOperator({ route: '/admin' });
  } catch (err) {
    if (err instanceof AuthError) {
      // 401 is unreachable in normal operation — src/middleware.ts already
      // gates every route its matcher covers before a Server Component runs
      // (same defensive posture as src/app/page.tsx's own identity check).
      if (err.status === 403) forbidden();
      unauthorized();
    }
    throw err;
  }
}

export default async function AdminPage() {
  const identity = await requireOperatorOrRespond();

  const [dashboard, entitlement] = await Promise.all([loadAdminDashboard(), loadEntitlementMismatch()]);
  const settings = loadCurrentSettings();
  const { tz: timeZone } = getConfig().display;

  return (
    <AppShell identity={identity} activeSection="admin">
      <Pane title="quota — default">
        <DefaultQuotaEditor currentDefaultBytes={settings.defaultQuotaBytes} />
      </Pane>
      {dashboard.kind === 'no_data' ? (
        <Pane title="admin">
          <p className="sq-empty" style={{ margin: 0 }}>
            no data yet — first sync in progress
          </p>
          <ReconcileTrigger />
        </Pane>
      ) : (
        <>
          <AdminSnapshotBar
            attributionSnapshotAtSeconds={dashboard.attributionSnapshotAt}
            nowSeconds={dashboard.now}
            staleAfterSeconds={dashboard.staleAfterSeconds}
            allPipelinesOk={dashboard.pipelines.every((p) => !p.neverRun && p.overallOk === true)}
            timeZone={timeZone}
          />
          <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--sq-muted)' }}>
            enforcement: {dashboard.enforcementEnabled ? 'on' : 'off (shadow mode — decisions below show what WOULD happen)'}
          </p>
          {/* Before the fleet numbers, for the same reason as on the member
              page: those numbers already treat these bytes as freed. The
              operator can cancel any of them, including ones the owning
              member cannot undo themselves (`FR-DEL-28`). */}
          <PendingDeletionsPane
            rows={loadPendingDeletions()}
            nowSeconds={dashboard.now}
            timeZone={timeZone}
            title="pending deletions — fleet-wide"
            showOwner
          />
          <FleetPane fleet={dashboard.fleet} distinctTitleCount={dashboard.fleet.distinctAttributedTitleCount} />
          <NeedsAttentionPane attention={dashboard.attention} />
          <MemberTablePane members={dashboard.members} />
          <EntitlementMismatchPane result={entitlement} />
          <SyncStatusPane pipelines={dashboard.pipelines} nowSeconds={dashboard.now} staleAfterSeconds={dashboard.staleAfterSeconds} timeZone={timeZone} />
        </>
      )}
      <SettingsPane settings={settings} />
      <Pane title="audit log">
        <p style={{ margin: 0, fontSize: '0.875rem' }}>
          Browse and export the full audit log — filter by actor, action, target, outcome, and time range (<a href="/admin/audit">/admin/audit</a>).
        </p>
      </Pane>
    </AppShell>
  );
}
