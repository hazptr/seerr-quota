/**
 * `/delete/review` — Step 2 of 3 (`FR-DEL-5`/`FR-DEL-6`). Reads the
 * selection carried forward from Step 1 as plain query params (`?d=id&r=id`,
 * `d`=requested `delete_files`, `r`=requested `release_claim` — see
 * `parseSelectedItemsFromSearchParams`'s doc comment for why preserving the
 * EXACT mode shown at Step 1, rather than always re-asking "delete", matters:
 * it is what stops a state change between screens from silently upgrading a
 * shown "release" into an actual file delete). Then re-derives the CURRENT
 * truth via `planDeletionItems` — never trusts that what Step 1 showed is
 * still true; a title newly protected, newly watched, or already gone shows
 * up in "can't proceed" here even if Step 1 (rendered moments or minutes
 * earlier) showed it as deletable.
 */
import { getIdentity } from '@/lib/auth/session';
import { getMemberGate } from '@/lib/auth/memberGate';
import { AppShell } from '@/components/shell/AppShell';
import { GateScreen } from '@/components/member/GateScreen';
import { DeleteReviewPane, type ReviewRow } from '@/components/member/delete/DeleteReviewPane';
import { parseSelectedItemsFromSearchParams } from '@/components/member/deleteLogic';
import { planDeletionItems } from '@/lib/deletion';
import { loadTitleDisplayFields } from '../_data/mediaTypes';

export default async function DeleteReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
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

  const rows: ReviewRow[] = planItems.map((item) => {
    const fields = displayFieldsById.get(item.titleId);
    return {
      ...item,
      mediaType: fields?.mediaType ?? null,
      watchedByAnyone: fields?.watchedByAnyone ?? false,
      episodesPlayed: fields?.episodesPlayed ?? null,
      episodesTotal: fields?.episodesTotal ?? null,
    };
  });

  return (
    <AppShell identity={identity} activeSection="usage">
      <DeleteReviewPane items={rows} />
    </AppShell>
  );
}
