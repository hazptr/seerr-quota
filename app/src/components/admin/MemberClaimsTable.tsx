/**
 * `FR-ADM-5`'s "full title list, claims" — one row per claim (active or
 * released), server-side paginated (`Pagination`). `ProtectedCell` renders
 * `TitleProtectionControl` (`FR-ADM-7`) — this table stays a Server
 * Component; only the small per-row control is client-interactive.
 */
import { Pane } from '@/components/ui/Pane';
import { formatGB, formatTimestamp } from '@/components/member/logic';
import { Pagination } from './Pagination';
import { TitleProtectionControl } from './TitleProtectionControl';
import type { PageMeta } from './logic';
import type { MemberClaimRow } from '@/app/admin/members/[username]/_data/memberDetail';
import { deriveWatchState, watchStateLabel } from '@/lib/playback/watchState';

const cellStyle = { padding: '0.375rem 0.625rem', borderBottom: 'var(--sq-border-width) var(--sq-rule-style) var(--sq-rule)' } as const;
const numericCellStyle = { ...cellStyle, textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const };
const headStyle = { ...cellStyle, textAlign: 'left' as const, color: 'var(--sq-muted)', fontWeight: 400, whiteSpace: 'nowrap' as const };

function ProtectedCell({ claim }: { claim: MemberClaimRow }) {
  return <TitleProtectionControl titleId={claim.titleId} initialProtected={claim.protected} initialReason={claim.protectedReason} />;
}

export function MemberClaimsTable({
  ssoUsername,
  claims,
  timeZone,
  otherParams,
}: {
  ssoUsername: string;
  claims: { rows: MemberClaimRow[]; meta: PageMeta };
  timeZone: string;
  otherParams: Record<string, string | number>;
}) {
  return (
    <Pane title="titles &amp; claims">
      {claims.rows.length === 0 ? (
        <p className="sq-empty" style={{ margin: 0 }}>
          no titles claimed
        </p>
      ) : (
        <div style={{ overflowX: 'auto', width: '100%' }}>
          <table className="sq-table-responsive" style={{ width: '100%', minWidth: '40rem', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
            <thead>
              <tr>
                <th style={headStyle} scope="col">
                  title
                </th>
                <th style={{ ...headStyle, textAlign: 'right' }} scope="col">
                  size
                </th>
                <th style={headStyle} scope="col">
                  active
                </th>
                <th style={headStyle} scope="col">
                  watched
                </th>
                <th style={headStyle} scope="col">
                  claimed
                </th>
                <th style={headStyle} scope="col">
                  protected
                </th>
              </tr>
            </thead>
            <tbody>
              {claims.rows.map((c) => (
                <tr key={c.titleId}>
                  <td data-label="title" style={{ ...cellStyle, maxWidth: '16rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.titleName}>
                    {c.titleName}
                    {c.year ? ` (${c.year})` : ''}
                  </td>
                  <td data-label="size" style={numericCellStyle}>{formatGB(c.chargedBytes)}</td>
                  <td data-label="active" style={cellStyle}>
                    {c.active ? 'yes' : `released${c.releasedBy ? ` by ${c.releasedBy}` : ''}${c.releasedAt ? ` (${formatTimestamp(c.releasedAt, timeZone)})` : ''}`}
                  </td>
                  <td data-label="watched" style={cellStyle}>
                    {watchStateLabel(deriveWatchState({ watchedByAnyone: c.watchedByAnyone, mediaType: c.mediaType, episodesPlayed: c.episodesPlayed, episodesTotal: c.episodesTotal }))}
                  </td>
                  <td data-label="claimed" style={cellStyle}>{formatTimestamp(c.createdAt, timeZone)}</td>
                  <td data-label="protected" style={cellStyle}>
                    <ProtectedCell claim={c} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination basePath={`/admin/members/${encodeURIComponent(ssoUsername)}`} paramName="claimsPage" meta={claims.meta} otherParams={otherParams} />
    </Pane>
  );
}
