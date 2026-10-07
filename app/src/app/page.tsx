/**
 * The member's own page: quota, current usage, percentage, remaining bytes,
 * operator note, their titles, and — since `FR-DEL-22` — any deletions they
 * have scheduled but can still cancel.
 *
 * The usage figure here is EFFECTIVE usage: raw claims minus anything already
 * scheduled for deletion (`FR-DEL-27`). That is why `PendingDeletionsPane`
 * renders first and says so explicitly; a member seeing only the reduced
 * number would reasonably conclude the deletion had already happened.
 *
 * Server component: identity comes from `getIdentity()` (re-derives
 * `Remote-User`/`Remote-Groups` the same way `src/middleware.ts` already
 * gated on), the `FR-SSO-8` gate from `getMemberGate()`, and the dashboard
 * data from `./_data/memberDashboard.ts`. No client JS is required to
 * render any of this — `FR-UI-9` ("the app MUST work with JavaScript
 * disabled to the extent of rendering the member's usage and title list
 * read-only") is satisfied for free by staying a pure Server Component; the
 * only client component anywhere in the tree is `ThemeToggle`, already
 * built and unrelated to data rendering.
 */
import { getIdentity } from '@/lib/auth/session';
import { getMemberGate } from '@/lib/auth/memberGate';
import { getConfig } from '@/lib/config';
import { AppShell } from '@/components/shell/AppShell';
import { GateScreen } from '@/components/member/GateScreen';
import { NoReconcileYet } from '@/components/member/NoReconcileYet';
import { PendingDeletionsPane } from '@/components/member/PendingDeletionsPane';
import { QuotaPane } from '@/components/member/QuotaPane';
import { TitlesPane } from '@/components/member/TitlesPane';
import { loadMemberDashboard } from './_data/memberDashboard';

export default async function HomePage() {
  const identity = await getIdentity();
  if (!identity) {
    // Unreachable in normal operation — src/middleware.ts already 401'd
    // every route its matcher covers before a Server Component runs
    // (FR-SSO-2). Defensive fallback only, matching
    // the equivalent guard this project uses elsewhere.
    return <main style={{ padding: '2rem', fontFamily: 'var(--sq-font)', color: 'var(--sq-fg)' }}>Not signed in.</main>;
  }

  const gate = await getMemberGate(identity);
  if (gate.status === 'blocked') {
    return (
      <AppShell identity={identity} activeSection="usage">
        <GateScreen gate={gate} />
      </AppShell>
    );
  }

  const dashboard = await loadMemberDashboard(identity.username);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const { tz: timeZone } = getConfig().display;

  return (
    <AppShell identity={identity} activeSection="usage">
      {dashboard.kind === 'no_snapshot' ? (
        <NoReconcileYet />
      ) : (
        <>
          {/* Above the quota figures on purpose: those figures have ALREADY
              had these pending deletions subtracted (`FR-DEL-27`), so a member
              who reads the reduced number without seeing this pane would think
              the files were gone and never look for the cancel button. */}
          <PendingDeletionsPane rows={dashboard.pendingDeletions} nowSeconds={nowSeconds} timeZone={timeZone} />
          <QuotaPane
            quota={dashboard.quota}
            usedBytes={dashboard.usedBytes}
            quotaNote={dashboard.quotaNote}
            snapshotAtSeconds={dashboard.snapshotAt}
            nowSeconds={nowSeconds}
            staleAfterSeconds={dashboard.staleAfterSeconds}
            timeZone={timeZone}
          />
          <TitlesPane
            titles={dashboard.titles}
            snapshotAtSeconds={dashboard.snapshotAt}
            nowSeconds={nowSeconds}
            staleAfterSeconds={dashboard.staleAfterSeconds}
            timeZone={timeZone}
          />
        </>
      )}
    </AppShell>
  );
}
