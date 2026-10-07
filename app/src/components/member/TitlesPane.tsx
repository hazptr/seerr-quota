/**
 * P1-8 item 3: "Their titles ... Per row: title, size, watched-by-anyone,
 * last played ... if a row is shared, say so" (`D-3`: a co-requested title is
 * charged in FULL to each claimant, never divided). Sorted by `chargedBytes`
 * descending, full stop — see `./logic.ts`'s `sortMemberTitles` comment for
 * why the original unwatched-first grouping was dropped.
 *
 * Two columns trimmed 2026-08-25 for clutter (operator feedback): `year`
 * dropped entirely — a title name is enough to identify the row, and year
 * alone rarely disambiguates a remake/reboot anyway (the size and last-
 * played columns do more of that work). `shared` is now conditional on
 * `anyShared` (column header AND every cell) rather
 * than always-present with a `—` in the common case — a column that's empty
 * for 90% of rows just adds width. Neither trim touches privacy: `shared`
 * was always a bare COUNT (`otherActiveClaimants`), never other members'
 * usernames, and stays that way.
 *
 * Below 640px the table collapses into stacked label/value cards
 * (`.sq-table-responsive`, `src/app/globals.css`) instead of forcing
 * horizontal scroll — `data-label` on every `<td>` drives that. (Zebra
 * striping was tried here 2026-08-25 and reverted the same day — looked bad
 * combined with the card layout's tight padding; the dashed row rule is the
 * only row separator now.) Numeric columns are right-aligned with tabular-figure numerics
 * (wiki/Theming.md "The treatments" table). A long title is
 * truncated with a native `title` attribute carrying the full value (works
 * with no JS, `FR-UI-9`) rather than wrapping a cell into multiple lines.
 */
import Link from 'next/link';
import { Pane } from '@/components/ui/Pane';
import { SnapshotNote } from './SnapshotNote';
import { formatGB, formatTimestamp, sortMemberTitles, type MemberTitleRow } from './logic';
import { deriveWatchState, watchStateLabel } from '@/lib/playback/watchState';

const cellStyle = { padding: '0.375rem 0.625rem', borderBottom: 'var(--sq-border-width) var(--sq-rule-style) var(--sq-rule)' } as const;
const numericCellStyle = { ...cellStyle, textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const };
const headStyle = { ...cellStyle, textAlign: 'left' as const, color: 'var(--sq-muted)', fontWeight: 400, whiteSpace: 'nowrap' as const };
const numericHeadStyle = { ...headStyle, textAlign: 'right' as const };

function formatLastPlayed(lastPlayedAnyAt: number | null, timeZone: string): string {
  return lastPlayedAnyAt === null ? 'never' : formatTimestamp(lastPlayedAnyAt, timeZone);
}

export function TitlesPane({
  titles,
  snapshotAtSeconds,
  nowSeconds,
  staleAfterSeconds,
  timeZone,
}: {
  titles: MemberTitleRow[];
  snapshotAtSeconds: number;
  nowSeconds: number;
  staleAfterSeconds: number;
  timeZone: string;
}) {
  const sorted = sortMemberTitles(titles);
  const anyShared = sorted.some((t) => t.otherActiveClaimants > 0);

  return (
    <Pane title="my titles">
      <SnapshotNote
        snapshotAtSeconds={snapshotAtSeconds}
        nowSeconds={nowSeconds}
        staleAfterSeconds={staleAfterSeconds}
        timeZone={timeZone}
      />
      <hr className="sq-rule" />
      {sorted.length === 0 ? (
        <p className="sq-empty" style={{ margin: 0 }}>
          no titles attributed to you
        </p>
      ) : (
        <>
          <p style={{ margin: '0 0 0.5rem', fontSize: '0.8125rem', color: 'var(--sq-muted)' }}>
            sorted: largest first
          </p>
          <div style={{ overflowX: 'auto', width: '100%' }}>
            <table className="sq-table-responsive" style={{ width: '100%', minWidth: '34rem', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
              <thead>
                <tr>
                  <th style={headStyle} scope="col">
                    title
                  </th>
                  <th style={numericHeadStyle} scope="col">
                    size
                  </th>
                  <th style={headStyle} scope="col">
                    watched
                  </th>
                  <th style={headStyle} scope="col">
                    last played
                  </th>
                  {anyShared && (
                    <th style={headStyle} scope="col">
                      shared
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {sorted.map((row) => (
                  <tr key={row.titleId}>
                    <td
                      data-label="title"
                      style={{
                        ...cellStyle,
                        maxWidth: '16rem',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={row.name}
                    >
                      {row.name}
                    </td>
                    <td data-label="size" style={numericCellStyle}>{formatGB(row.chargedBytes)}</td>
                    <td data-label="watched" style={cellStyle}>
                    {watchStateLabel(deriveWatchState({ watchedByAnyone: row.watchedByAnyone, mediaType: row.mediaType, episodesPlayed: row.episodesPlayed, episodesTotal: row.episodesTotal }))}
                  </td>
                    <td data-label="last played" style={cellStyle}>{formatLastPlayed(row.lastPlayedAnyAt, timeZone)}</td>
                    {anyShared && (
                      <td data-label="shared" style={cellStyle}>{row.otherActiveClaimants > 0 ? `yes (+${row.otherActiveClaimants})` : '—'}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {anyShared && (
            <p style={{ margin: '0.75rem 0 0', fontSize: '0.8125rem', color: 'var(--sq-muted)' }}>
              &quot;shared&quot; titles were also requested by someone else — each requester is charged the full size,
              never split, so this isn&apos;t bytes borrowed from another member.
            </p>
          )}
          <hr className="sq-rule" />
          <Link href="/delete" style={{ fontSize: '0.875rem' }}>
            delete or release titles to free space →
          </Link>
        </>
      )}
    </Pane>
  );
}
