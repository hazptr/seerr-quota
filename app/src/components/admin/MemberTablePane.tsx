/**
 * `FR-ADM-3`: the member table — usage, effective quota + source, % used,
 * never-watched bytes, title count, and state. `usedBytes`/`neverWatchedBytes`/
 * `titleCount` are `null` (rendered `—`) for a member with no linked Seerr
 * account or an ambiguous match — "linked and using nothing" and "not
 * linked" are different facts, and this table never conflates them with `0`.
 *
 * The usage column overlaps across rows (`D-3`: a co-requested title is
 * charged in full to every claimant) and MUST NOT be summed — the pane title
 * says so directly, matching the layout mock's "usage overlaps; do not sum"
 * strip, and `FleetPane`'s distinct-title total is shown right above this
 * pane for the honest comparison.
 *
 * **`FR-ADM-6` quota editing lives on the member drill-down, not inline
 * here.** `QuotaCell`/`MemberStateCell` were left as their own components
 * specifically so a control could slot in without restructuring this table,
 * but a full set/clear/preview/confirm form doesn't fit a table cell at
 * 375px (`FR-UI-6`) — the member-name link already takes the operator to
 * `/admin/members/{username}`, where `MemberOverrideEditor` lives (embedded
 * in `MemberDetailHeader`). This table stays read-only; nothing here writes.
 */
import Link from 'next/link';
import { Pane } from '@/components/ui/Pane';
import { formatGB, severityColorVar } from '@/components/member/logic';
import { memberStateLabel, memberStateSeverity, type AdminMemberRow } from './logic';

const cellStyle = { padding: '0.375rem 0.625rem', borderBottom: 'var(--sq-border-width) var(--sq-rule-style) var(--sq-rule)' } as const;
const numericCellStyle = { ...cellStyle, textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const };
const headStyle = { ...cellStyle, textAlign: 'left' as const, color: 'var(--sq-muted)', fontWeight: 400, whiteSpace: 'nowrap' as const };
const numericHeadStyle = { ...headStyle, textAlign: 'right' as const };

function formatOptionalGB(bytes: number | null): string {
  return bytes === null ? '—' : formatGB(bytes);
}

/** Quota value + its source, together (`FR-ADM-3`: "effective quota and its source"). Isolated component — the seam `FR-ADM-6`'s edit form slots into later. */
function QuotaCell({ member }: { member: AdminMemberRow }) {
  if (member.quota.kind === 'unconfigured') {
    return <span className="sq-empty">not set</span>;
  }
  const valueText = member.quota.kind === 'unlimited' ? 'unlimited' : formatGB(member.quota.bytes);
  const sourceText = member.quotaSource ? ` (${member.quotaSource})` : '';
  return (
    <span>
      {valueText}
      <span style={{ color: 'var(--sq-muted)' }}>{sourceText}</span>
    </span>
  );
}

/** Text/glyph state indicator, PLUS colour (`memberStateSeverity`) — colour is never the *sole* signal (`FR-UI-7`), so `over` stays bold with its ⚠ glyph regardless. */
function MemberStateCell({ member }: { member: AdminMemberRow }) {
  const label = memberStateLabel(member.state);
  const severity = memberStateSeverity(member.state);
  const color = severity ? severityColorVar(severity) : undefined;
  if (member.state === 'over') {
    return <strong style={{ color }}>⚠ {label}</strong>;
  }
  return <span style={{ color }}>{label}</span>;
}

function MemberRow({ member }: { member: AdminMemberRow }) {
  return (
    <tr>
      <td data-label="member" style={cellStyle}>
        <Link href={`/admin/members/${encodeURIComponent(member.ssoUsername)}`}>{member.displayName || member.ssoUsername}</Link>
      </td>
      <td data-label="usage" style={numericCellStyle}>{formatOptionalGB(member.usedBytes)}</td>
      <td data-label="quota" style={cellStyle}>
        <QuotaCell member={member} />
      </td>
      <td data-label="used" style={numericCellStyle}>{member.percentUsed === null ? '—' : `${member.percentUsed.toFixed(0)}%`}</td>
      <td data-label="unwatched" style={numericCellStyle}>{formatOptionalGB(member.neverWatchedBytes)}</td>
      <td data-label="titles" style={numericCellStyle}>{member.titleCount === null ? '—' : member.titleCount}</td>
      <td data-label="state" style={cellStyle}>
        <MemberStateCell member={member} />
      </td>
    </tr>
  );
}

export function MemberTablePane({ members }: { members: AdminMemberRow[] }) {
  return (
    <Pane title="members — usage overlaps, do not sum">
      {members.length === 0 ? (
        <p className="sq-empty" style={{ margin: 0 }}>
          no entitled members yet
        </p>
      ) : (
        <div style={{ overflowX: 'auto', width: '100%' }}>
          <table className="sq-table-responsive" style={{ width: '100%', minWidth: '42rem', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
            <thead>
              <tr>
                <th style={headStyle} scope="col">
                  member
                </th>
                <th style={numericHeadStyle} scope="col">
                  usage
                </th>
                <th style={headStyle} scope="col">
                  quota
                </th>
                <th style={numericHeadStyle} scope="col">
                  used
                </th>
                <th style={numericHeadStyle} scope="col">
                  unwatched
                </th>
                <th style={numericHeadStyle} scope="col">
                  titles
                </th>
                <th style={headStyle} scope="col">
                  state
                </th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <MemberRow key={m.ssoUsername} member={m} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p style={{ margin: '0.75rem 0 0', fontSize: '0.8125rem', color: 'var(--sq-muted)' }}>
        the usage column overlaps across members (a co-requested title is charged in full to each claimant, `D-3`) — never sum it for a
        fleet total; see the distinct-title total above instead.
      </p>
    </Pane>
  );
}
