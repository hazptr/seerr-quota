/**
 * `FR-AUD-10`: "A member MUST be able to see their own audit history, and
 * MUST NOT be able to see anyone else's." Any signed-in identity (member or
 * operator — everyone has their own history) — `getIdentity()` re-derives
 * `Remote-User` the same way `src/middleware.ts` already gated on, matching
 * `src/app/page.tsx`'s own "unreachable in normal operation" defensive
 * fallback for a missing identity.
 *
 * The scope check (`actor = me OR on_behalf_of = me`) AND the field-level
 * allow-list (`FR-DEL-4a`'s collision) both happen in
 * `./_data/history.ts`/`@/lib/audit` — this page only renders whatever that
 * loader hands it, for `identity.username`, never for any id a query param
 * or client could supply (there is no such param on this route at all).
 */
import { getIdentity } from '@/lib/auth/session';
import { AppShell } from '@/components/shell/AppShell';
import { Pane } from '@/components/ui/Pane';
import { OwnAuditHistoryTable } from '@/components/member/OwnAuditHistoryTable';
import { getConfig } from '@/lib/config';
import { loadOwnAuditHistory } from './_data/history';

function parsePage(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const n = raw ? Number.parseInt(raw, 10) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export default async function HistoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const identity = await getIdentity();
  if (!identity) {
    // Unreachable in normal operation — src/middleware.ts already 401'd
    // every route its matcher covers before a Server Component runs
    // (FR-SSO-2), same defensive fallback src/app/page.tsx uses.
    return <main style={{ padding: '2rem', fontFamily: 'var(--sq-font)', color: 'var(--sq-fg)' }}>Not signed in.</main>;
  }

  const sp = await searchParams;
  const page = parsePage(sp.page);
  const history = await loadOwnAuditHistory(identity.username, page);
  const { tz: timeZone } = getConfig().display;

  return (
    <AppShell identity={identity} activeSection="history">
      <Pane title="my history">
        <OwnAuditHistoryTable basePath="/history" history={history} timeZone={timeZone} />
      </Pane>
    </AppShell>
  );
}
