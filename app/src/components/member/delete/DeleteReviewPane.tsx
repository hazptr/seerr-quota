/**
 * Step 2 — Review (`FR-DEL-5`/`FR-DEL-6`, wiki "The three-step flow"): "A
 * dedicated screen — not a modal — listing exactly what will happen to each
 * selected item ... Separate sections for 'files will be deleted' and
 * 'claim released only' so the two can't be visually conflated. Nothing is
 * executed from this screen." A plain Server Component — no client JS
 * anywhere on this screen, since there is nothing here to gate (the confirm
 * screen, Step 3, is where the required typed-field/checkbox interactivity
 * lives). Navigation to Step 3 is a real `<form method="GET">` with hidden
 * inputs carrying forward exactly the (titleId, mode) pairs THIS screen
 * showed — see `src/app/delete/review/page.tsx`'s header comment for why
 * that fidelity matters.
 */
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { Pane } from '@/components/ui/Pane';
import type { DeletionPlanItem } from '@/lib/deletion';
import { formatGB } from '@/components/member/logic';
import { describeUnavailableReason, seriesWholeShowWarning, splitReviewItems, watchedWarning, type ReviewSections } from '@/components/member/deleteLogic';

export interface ReviewRow extends DeletionPlanItem {
  mediaType: 'movie' | 'tv' | null;
  watchedByAnyone?: boolean;
  episodesPlayed?: number | null;
  episodesTotal?: number | null;
}

const rowStyle = { padding: '0.5rem 0', borderBottom: 'var(--sq-border-width) var(--sq-rule-style) var(--sq-rule)' };

function ItemCard({ row, kind }: { row: ReviewRow; kind: 'delete' | 'release' }) {
  const watched = watchedWarning(row);
  const wholeShow = seriesWholeShowWarning(row.mediaType ?? undefined);
  return (
    <div style={rowStyle}>
      <p style={{ margin: '0 0 0.25rem', fontWeight: 600 }}>
        {row.name} {row.year ? `(${row.year})` : ''}
      </p>
      {kind === 'delete' ? (
        <p style={{ margin: '0 0 0.125rem', fontSize: '0.8125rem' }}>
          path: <code>{row.path}</code> — size: {formatGB(row.sizeBytes ?? 0)}
        </p>
      ) : (
        <p style={{ margin: '0 0 0.125rem', fontSize: '0.8125rem', color: 'var(--sq-muted)' }}>
          nothing on disk is touched — only your own claim ({formatGB(row.chargedBytes ?? 0)}) ends
        </p>
      )}
      {row.downgradedFromDelete && (
        <p style={{ margin: '0 0 0.125rem', fontSize: '0.8125rem' }}>
          ⚠ you selected this to delete, but you&apos;re no longer the sole claimant — only your claim will be released, nothing is removed from disk.
        </p>
      )}
      {watched && <p style={{ margin: '0 0 0.125rem', fontSize: '0.8125rem', fontWeight: 600 }}>⚠ {watched}</p>}
      {wholeShow && <p style={{ margin: 0, fontSize: '0.8125rem' }}>⚠ {wholeShow}</p>}
    </div>
  );
}

export function DeleteReviewPane({ items }: { items: readonly ReviewRow[] }) {
  const sections: ReviewSections<ReviewRow> = splitReviewItems(items);
  const actionable = sections.toDelete.length + sections.toRelease.length;

  return (
    <Pane title="delete — step 2 of 3: review">
      <p style={{ margin: '0 0 0.75rem', fontSize: '0.8125rem', color: 'var(--sq-muted)' }}>
        Nothing is deleted or released yet. This is exactly what will happen if you continue.
      </p>

      {actionable === 0 && sections.cannotProceed.length === 0 && (
        <p className="sq-empty" style={{ margin: 0 }}>
          nothing selected — go back and pick titles
        </p>
      )}

      {sections.toDelete.length > 0 && (
        <section style={{ marginBottom: '1rem' }}>
          <h3 className="sq-heading" style={{ margin: '0 0 0.5rem', fontSize: '0.9375rem' }}>
            files will be deleted ({sections.toDelete.length})
          </h3>
          {sections.toDelete.map((row) => (
            <ItemCard key={row.titleId} row={row} kind="delete" />
          ))}
        </section>
      )}

      {sections.toRelease.length > 0 && (
        <section style={{ marginBottom: '1rem' }}>
          <h3 className="sq-heading" style={{ margin: '0 0 0.5rem', fontSize: '0.9375rem' }}>
            claim released only — nothing removed ({sections.toRelease.length})
          </h3>
          {sections.toRelease.map((row) => (
            <ItemCard key={row.titleId} row={row} kind="release" />
          ))}
        </section>
      )}

      {sections.cannotProceed.length > 0 && (
        <section style={{ marginBottom: '1rem' }}>
          <h3 className="sq-heading" style={{ margin: '0 0 0.5rem', fontSize: '0.9375rem' }}>
            can&apos;t proceed ({sections.cannotProceed.length})
          </h3>
          {sections.cannotProceed.map((row) => (
            <div key={row.titleId} style={rowStyle}>
              <p style={{ margin: '0 0 0.125rem', fontWeight: 600 }}>{row.name ?? row.titleId}</p>
              <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--sq-muted)' }}>{describeUnavailableReason(row)}</p>
            </div>
          ))}
        </section>
      )}

      <hr className="sq-rule" />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center', justifyContent: 'space-between' }}>
        <Link href="/delete" style={{ fontSize: '0.875rem', color: 'var(--sq-muted)' }}>
          ← back to select
        </Link>
        {actionable > 0 && (
          <form method="GET" action="/delete/confirm">
            {sections.toDelete.map((row) => (
              <input key={row.titleId} type="hidden" name="d" value={row.titleId} />
            ))}
            {sections.toRelease.map((row) => (
              <input key={row.titleId} type="hidden" name="r" value={row.titleId} />
            ))}
            <Button type="submit">proceed to confirm</Button>
          </form>
        )}
      </div>
    </Pane>
  );
}
