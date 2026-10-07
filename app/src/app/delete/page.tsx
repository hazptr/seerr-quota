/**
 * `/delete` — Step 1 of 3 (`FR-DEL-5`, `wiki/Feature-06-Self-Service-Deletion.md`
 * "The three-step flow"). Same identity/gate/no-snapshot boilerplate as
 * `src/app/page.tsx` (P1-8), so a member who isn't linked or has no
 * attribution snapshot yet sees the exact same explanatory screens here as
 * on the main dashboard, rather than a different failure mode on this route.
 *
 * Data comes from two READ-ONLY calls, never a client-side fetch:
 *   - `loadMemberDashboard` (`@/app/_data/memberDashboard.ts`, P1-8,
 *     untouched by this task) — quota, usage, and the member's claimed
 *     titles (for `watchedByAnyone`/`lastPlayedAnyAt`, which
 *     `planDeletionItems` doesn't carry).
 *   - `planDeletionItems` (`@/lib/deletion`) — the SAME pure-core-backed
 *     preview `execute.ts` itself is built on, called with
 *     `requestedMode: 'delete_files'` for every claimed title (the member
 *     never picks delete vs release — `FR-DEL-2` — so this is always the
 *     right thing to ask "what would happen").
 *
 * This module does not implement, re-derive, or duplicate any authorization
 * rule — see `@/lib/deletion`'s own file headers.
 */
import { getIdentity } from '@/lib/auth/session';
import { getMemberGate } from '@/lib/auth/memberGate';
import { AppShell } from '@/components/shell/AppShell';
import { GateScreen } from '@/components/member/GateScreen';
import { NoReconcileYet } from '@/components/member/NoReconcileYet';
import { DeleteSelectTable } from '@/components/member/delete/DeleteSelectTable';
import type { DeleteSelectRow } from '@/components/member/deleteLogic';
import { planDeletionItems } from '@/lib/deletion';
import { loadMemberDashboard } from '@/app/_data/memberDashboard';
import { loadTitleDisplayFields } from './_data/mediaTypes';

export default async function DeleteSelectPage() {
  const identity = await getIdentity();
  if (!identity) {
    // Unreachable in normal operation — see src/app/page.tsx's identical guard.
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
  if (dashboard.kind === 'no_snapshot') {
    return (
      <AppShell identity={identity} activeSection="usage">
        <NoReconcileYet />
      </AppShell>
    );
  }

  const actor = { username: identity.username, isOperator: identity.isOperator };
  const planItems = planDeletionItems(
    actor,
    dashboard.titles.map((t) => ({ titleId: t.titleId, requestedMode: 'delete_files' as const })),
  );

  const displayFieldsById = loadTitleDisplayFields(planItems.filter((p) => p.found).map((p) => p.titleId));

  const rows: DeleteSelectRow[] = planItems.map((item) => {
    const fields = displayFieldsById.get(item.titleId);
    return {
      ...item,
      watchedByAnyone: fields?.watchedByAnyone ?? false,
      episodesPlayed: fields?.episodesPlayed ?? null,
      episodesTotal: fields?.episodesTotal ?? null,
      lastPlayedAnyAt: fields?.lastPlayedAnyAt ?? null,
      mediaType: fields?.mediaType ?? null,
    };
  });

  return (
    <AppShell identity={identity} activeSection="usage">
      <DeleteSelectTable rows={rows} usedBytes={dashboard.usedBytes} quota={dashboard.quota} />
    </AppShell>
  );
}
