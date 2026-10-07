/**
 * `FR-ADM-5`: the operator's drill-down into one member — full title list,
 * claims, decisions, and audit history, each paginated server-side (the
 * page never loads more than one page's worth of rows into the browser).
 * Operator-only, same `requireOperator` guard as `/admin` (`FR-ADM-1`) — the
 * denied attempt names the specific member it targeted
 * (`target: {type: 'member', id: username}`), per
 * `src/lib/auth/authorize.ts`'s `AccessCheckContext` and
 * `wiki/Feature-08-Audit-Log.md`'s `access.denied` vocabulary row.
 */
import { forbidden, notFound, unauthorized } from 'next/navigation';
import { AppShell } from '@/components/shell/AppShell';
import { SnapshotNote } from '@/components/member/SnapshotNote';
import { MemberDetailHeader } from '@/components/admin/MemberDetailHeader';
import { MemberClaimsTable } from '@/components/admin/MemberClaimsTable';
import { MemberDecisionsTable } from '@/components/admin/MemberDecisionsTable';
import { MemberAuditTable } from '@/components/admin/MemberAuditTable';
import { AuthError, requireOperator } from '@/lib/auth/authorize';
import { getConfig } from '@/lib/config';
import type { Identity } from '@/lib/auth/identity';
import { loadMemberDetail } from './_data/memberDetail';

async function requireOperatorOrRespond(username: string): Promise<Identity> {
  try {
    return await requireOperator({ route: `/admin/members/${username}`, target: { type: 'member', id: username } });
  } catch (err) {
    if (err instanceof AuthError) {
      if (err.status === 403) forbidden();
      unauthorized();
    }
    throw err;
  }
}

function parsePage(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const n = raw ? Number.parseInt(raw, 10) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export default async function MemberDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ username: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { username } = await params;
  const identity = await requireOperatorOrRespond(username);

  const sp = await searchParams;
  const claimsPage = parsePage(sp.claimsPage);
  const decisionsPage = parsePage(sp.decisionsPage);
  const auditPage = parsePage(sp.auditPage);

  const detail = await loadMemberDetail(username, { claimsPage, decisionsPage, auditPage });
  if (detail.kind === 'not_found') notFound();

  const { tz: timeZone } = getConfig().display;
  const otherParams = { claimsPage: String(claimsPage), decisionsPage: String(decisionsPage), auditPage: String(auditPage) };

  return (
    <AppShell identity={identity} activeSection="admin">
      {detail.snapshot.attributionSnapshotAt === null ? (
        <p className="sq-empty" style={{ margin: 0 }}>
          no attribution reconcile has run yet — usage figures below may be incomplete
        </p>
      ) : (
        <SnapshotNote
          snapshotAtSeconds={detail.snapshot.attributionSnapshotAt}
          nowSeconds={Math.floor(Date.now() / 1000)}
          staleAfterSeconds={detail.snapshot.staleAfterSeconds}
          timeZone={timeZone}
        />
      )}
      <MemberDetailHeader header={detail.header} timeZone={timeZone} />
      <MemberClaimsTable ssoUsername={username} claims={detail.claims} timeZone={timeZone} otherParams={otherParams} />
      <MemberDecisionsTable ssoUsername={username} decisions={detail.decisions} timeZone={timeZone} otherParams={otherParams} />
      <MemberAuditTable ssoUsername={username} auditRows={detail.auditRows} timeZone={timeZone} otherParams={otherParams} />
    </AppShell>
  );
}
