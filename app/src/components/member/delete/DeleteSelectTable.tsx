'use client';

/**
 * Step 1 — Select (`FR-DEL-5`, `wiki/Feature-06-Self-Service-Deletion.md`
 * "The three-step flow"). Extends P1-8's read view rather than rebuilding
 * it: rows carry the same title/size/watched/last-played/shared shape
 * `TitlesPane` already renders (see that file's 2026-08-25 comment for why
 * `year` is gone and `shared` is conditional on `anyShared` — same trims,
 * same reasoning, applied here too), PLUS the one thing this feature adds —
 * the action each row would get (Delete / Release claim / why it's blocked),
 * which comes straight from `@/lib/deletion`'s `planDeletionItems` via this
 * page's server-side `DeleteSelectRow` (never re-derived client-side —
 * "ask the backend, never trust client cached state"). The action column
 * itself only renders text for the outcomes that AREN'T "delete" — the
 * checkbox next to a delete-outcome row already says that, so repeating the
 * word on every actionable row was pure noise; "Release claim" and every
 * blocked/unauthorized/already-gone reason still show, since those aren't
 * implied by anything else on the row.
 *
 * A real `<form method="GET" action="/delete/review">` carries the
 * selection forward with ZERO JS required for the actual navigation: every
 * checkbox's `name` is `d` or `r` (`selectionFieldName`, from the row's
 * CURRENT plan outcome, decided by the backend, never by the member —
 * `FR-DEL-2`), so ticking boxes and clicking "review selected" works with
 * JavaScript disabled via native browser form submission. Only the LIVE
 * running total (`computeSelectionSummary`) is inert without JS — it
 * degrades to a static "select titles below" hint, never blocking
 * navigation (`FR-UI-9`'s spirit, applied to a screen that is a step toward
 * a mutation rather than a pure read view).
 *
 * A checked row's WHOLE `<tr>` gets `--sq-focus-ring` as its background,
 * and reaches the pane's actual edges (`.sq-table-bleed`,
 * `src/app/globals.css`) rather than stopping at the table's own bounds —
 * the checkbox itself is a small target to visually confirm against; the
 * row is not (2026-08-25, operator feedback). Clicking anywhere in an
 * actionable row toggles it, same as clicking the checkbox — the click
 * handler ignores clicks that land directly on the checkbox input itself,
 * so its own native `onChange` fires exactly once rather than the row
 * handler double-toggling on top of it.
 */
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Pane } from '@/components/ui/Pane';
import type { EffectiveQuota } from '@/lib/members/quota';
import { formatGB } from '@/components/member/logic';
import { actionLabel, computeSelectionSummary, describeUnavailableReason, selectionFieldName, sortSelectRows, type DeleteSelectRow } from '@/components/member/deleteLogic';
import { deriveWatchState, watchStateLabel } from '@/lib/playback/watchState';

const cellStyle = { padding: '0.375rem 0.625rem', borderBottom: 'var(--sq-border-width) var(--sq-rule-style) var(--sq-rule)', verticalAlign: 'top' as const };
const numericCellStyle = { ...cellStyle, textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const };
const headStyle = { ...cellStyle, textAlign: 'left' as const, color: 'var(--sq-muted)', fontWeight: 400, whiteSpace: 'nowrap' as const };
const numericHeadStyle = { ...headStyle, textAlign: 'right' as const };
// First/last column only — compensates `.sq-table-bleed`'s edge-to-edge
// span so cell text still lines up with the pane's 1rem-inset content
// (real effect on desktop only; the mobile card layout's `!important` rules
// override this back down regardless, by design — see globals.css).
const firstCellStyle = { ...cellStyle, paddingLeft: '1rem' };
const firstHeadStyle = { ...headStyle, paddingLeft: '1rem' };
const lastCellStyle = { ...cellStyle, paddingRight: '1rem' };
const lastHeadStyle = { ...headStyle, paddingRight: '1rem' };

export function DeleteSelectTable({ rows, usedBytes, quota }: { rows: DeleteSelectRow[]; usedBytes: number; quota: EffectiveQuota }) {
  const sorted = useMemo(() => sortSelectRows(rows), [rows]);
  const anyShared = sorted.some((r) => (r.otherActiveClaimants ?? 0) > 0);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function toggle(titleId: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(titleId);
      else next.delete(titleId);
      return next;
    });
  }

  const summary = computeSelectionSummary(sorted, selected, usedBytes, quota);

  if (sorted.length === 0) {
    return (
      <Pane title="delete — step 1 of 3: select">
        <p className="sq-empty" style={{ margin: 0 }}>
          no titles attributed to you
        </p>
      </Pane>
    );
  }

  return (
    <Pane title="delete — step 1 of 3: select">
      <p style={{ margin: '0 0 0.75rem', fontSize: '0.8125rem', color: 'var(--sq-muted)' }}>
        Tick titles below, then review exactly what will happen on the next screen. Nothing is deleted or released here.
      </p>
      <form method="GET" action="/delete/review">
        <div className="sq-table-bleed" style={{ overflowX: 'auto' }}>
          <table className="sq-table-responsive" style={{ width: '100%', minWidth: '40rem', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
            <thead>
              <tr>
                <th style={firstHeadStyle} scope="col" aria-label="select" />
                <th style={headStyle} scope="col">
                  title
                </th>
                <th style={numericHeadStyle} scope="col">
                  size
                </th>
                <th style={headStyle} scope="col">
                  watched
                </th>
                {anyShared && (
                  <th style={headStyle} scope="col">
                    shared
                  </th>
                )}
                <th style={lastHeadStyle} scope="col">
                  action
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => {
                const field = selectionFieldName(row.outcome);
                const isSelected = selected.has(row.titleId);
                return (
                  <tr
                    key={row.titleId}
                    onClick={
                      field
                        ? (e) => {
                            // The checkbox's own `onChange` already handles a click
                            // that lands directly on it — toggling again here would
                            // immediately cancel it back out.
                            if ((e.target as HTMLElement).tagName === 'INPUT') return;
                            toggle(row.titleId, !isSelected);
                          }
                        : undefined
                    }
                    style={{
                      ...(isSelected ? { background: 'var(--sq-focus-ring)' } : null),
                      ...(field ? { cursor: 'pointer' } : null),
                    }}
                  >
                    <td data-label="select" style={firstCellStyle}>
                      {field ? (
                        <input
                          type="checkbox"
                          name={field}
                          value={row.titleId}
                          checked={isSelected}
                          onChange={(e) => toggle(row.titleId, e.target.checked)}
                          aria-label={`select ${row.name ?? row.titleId}`}
                          style={{ width: '1.125rem', height: '1.125rem' }}
                        />
                      ) : null}
                    </td>
                    <td data-label="title" style={{ ...cellStyle, maxWidth: '16rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.name}>
                      {row.name ?? row.titleId}
                    </td>
                    <td data-label="size" style={numericCellStyle}>{formatGB(row.chargedBytes ?? 0)}</td>
                    <td data-label="watched" style={cellStyle}>
                      {watchStateLabel(deriveWatchState({ watchedByAnyone: row.watchedByAnyone, mediaType: row.mediaType, episodesPlayed: row.episodesPlayed, episodesTotal: row.episodesTotal }))}
                    </td>
                    {anyShared && (
                      <td data-label="shared" style={cellStyle}>{(row.otherActiveClaimants ?? 0) > 0 ? `yes (+${row.otherActiveClaimants})` : '—'}</td>
                    )}
                    <td data-label="action" style={lastCellStyle}>
                      {row.outcome !== 'delete' && <span style={{ fontWeight: row.outcome === 'release' ? 600 : 400 }}>{actionLabel(row.outcome)}</span>}
                      {!field && (
                        <div style={{ fontSize: '0.75rem', color: 'var(--sq-muted)', marginTop: '0.125rem' }}>{describeUnavailableReason(row)}</div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <hr className="sq-rule" />

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem', justifyContent: 'space-between' }}>
          <p style={{ margin: 0, fontSize: '0.875rem' }}>
            {summary.selectedCount === 0 ? (
              <span style={{ color: 'var(--sq-muted)' }}>select titles above to see what you would free</span>
            ) : (
              <>
                selected {summary.selectedCount} — would free <strong>{formatGB(summary.freedBytes)}</strong>, taking your usage to{' '}
                <strong>{formatGB(usedBytes - summary.freedBytes)}</strong>
                {summary.projected.kind === 'limited' && <> of {formatGB(summary.projected.quotaBytes)}</>}
              </>
            )}
          </p>
          <Button type="submit">review selected</Button>
        </div>
      </form>
    </Pane>
  );
}
