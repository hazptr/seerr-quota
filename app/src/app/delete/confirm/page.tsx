/**
 * `/delete/confirm` — Step 3 of 3 (`FR-DEL-5`). Same query-param carry-over
 * as `/delete/review` (`?d=id&r=id`), re-derived fresh via `planDeletionItems`
 * one more time — this is the LAST server-side read before the member can
 * click the one destructive button on the page, so it must reflect
 * right-now truth, not what Review showed moments earlier. Items that are
 * no longer actionable (newly blocked, already gone, no longer authorized)
 * are shown separately and excluded from what the confirm form can submit;
 * `executeDeletionBatch` would re-derive the same answer anyway if they were
 * included, but excluding them here keeps the confirm screen's own N/X
 * count (`FR-DEL-5` step 3.2) honest without waiting for a round trip.
 */
import { getIdentity } from '@/lib/auth/session';
import { getMemberGate } from '@/lib/auth/memberGate';
import { AppShell } from '@/components/shell/AppShell';
import { GateScreen } from '@/components/member/GateScreen';
import { Pane } from '@/components/ui/Pane';
import { DeleteConfirmForm, type ConfirmItem } from '@/components/member/delete/DeleteConfirmForm';
import { describeUnavailableReason, parseSelectedItemsFromSearchParams } from '@/components/member/deleteLogic';
import { planDeletionItems } from '@/lib/deletion';
import { loadTitleDisplayFields } from '../_data/mediaTypes';

export default async function DeleteConfirmPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const identity = await getIdentity();
  if (!identity) {
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

  const sp = await searchParams;
  const requested = parseSelectedItemsFromSearchParams(sp);

  const actor = { username: identity.username, isOperator: identity.isOperator };
  const planItems = planDeletionItems(actor, requested);
  const displayFieldsById = loadTitleDisplayFields(planItems.filter((p) => p.found).map((p) => p.titleId));

  const actionable: ConfirmItem[] = [];
  const cannotProceed: { titleId: string; name: string; reason: string }[] = [];

  for (const item of planItems) {
    if (item.outcome === 'delete' || item.outcome === 'release') {
      const fields = displayFieldsById.get(item.titleId);
      actionable.push({
        titleId: item.titleId,
        name: item.name ?? item.titleId,
        path: item.path,
        sizeBytes: item.sizeBytes ?? 0,
        chargedBytes: item.chargedBytes ?? 0,
        mode: item.outcome,
        watchedByAnyone: fields?.watchedByAnyone ?? false,
        episodesPlayed: fields?.episodesPlayed ?? null,
        episodesTotal: fields?.episodesTotal ?? null,
        otherActiveClaimants: item.otherActiveClaimants ?? 0,
        mediaType: fields?.mediaType ?? null,
      });
    } else {
      cannotProceed.push({ titleId: item.titleId, name: item.name ?? item.titleId, reason: describeUnavailableReason(item) });
    }
  }

  return (
    <AppShell identity={identity} activeSection="usage">
      {cannotProceed.length > 0 && (
        <Pane title="no longer available">
          <p style={{ margin: '0 0 0.5rem', fontSize: '0.8125rem', color: 'var(--sq-muted)' }}>
            These changed since you selected them and were dropped from this confirmation — nothing was done to them:
          </p>
          {cannotProceed.map((row) => (
            <p key={row.titleId} style={{ margin: '0 0 0.25rem', fontSize: '0.8125rem' }}>
              <strong>{row.name}</strong> — {row.reason}
            </p>
          ))}
        </Pane>
      )}
      <DeleteConfirmForm items={actionable} />
    </AppShell>
  );
}
