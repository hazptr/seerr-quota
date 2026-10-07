/**
 * `FR-ADM-5`'s "audit history" — every audit row where this member is the
 * `actor` OR the `on_behalf_of` target (`FR-ADM-14`'s column, unused until
 * that later task writes it), server-side paginated. Read-only — the audit
 * log itself is append-only everywhere in this app (AGENTS.md rule 4); this
 * table never writes.
 */
import { Pane } from '@/components/ui/Pane';
import { formatTimestamp, outcomeSeverity, severityColorVar } from '@/components/member/logic';
import { Pagination } from './Pagination';
import type { PageMeta } from './logic';
import type { MemberAuditRow } from '@/app/admin/members/[username]/_data/memberDetail';

const cellStyle = { padding: '0.375rem 0.625rem', borderBottom: 'var(--sq-border-width) var(--sq-rule-style) var(--sq-rule)' } as const;
const headStyle = { ...cellStyle, textAlign: 'left' as const, color: 'var(--sq-muted)', fontWeight: 400, whiteSpace: 'nowrap' as const };

export function MemberAuditTable({
  ssoUsername,
  auditRows,
  timeZone,
  otherParams,
}: {
  ssoUsername: string;
  auditRows: { rows: MemberAuditRow[]; meta: PageMeta };
  timeZone: string;
  otherParams: Record<string, string | number>;
}) {
  return (
    <Pane title="audit history">
      {auditRows.rows.length === 0 ? (
        <p className="sq-empty" style={{ margin: 0 }}>
          no audit rows
        </p>
      ) : (
        <div style={{ overflowX: 'auto', width: '100%' }}>
          <table className="sq-table-responsive" style={{ width: '100%', minWidth: '38rem', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
            <thead>
              <tr>
                <th style={headStyle} scope="col">
                  when
                </th>
                <th style={headStyle} scope="col">
                  action
                </th>
                <th style={headStyle} scope="col">
                  actor
                </th>
                <th style={headStyle} scope="col">
                  target
                </th>
                <th style={headStyle} scope="col">
                  outcome
                </th>
              </tr>
            </thead>
            <tbody>
              {auditRows.rows.map((r) => (
                <tr key={r.id}>
                  <td data-label="when" style={cellStyle}>{formatTimestamp(Math.floor(r.ts / 1000), timeZone)}</td>
                  <td data-label="action" style={cellStyle}>{r.action}</td>
                  <td data-label="actor" style={cellStyle}>
                    {r.actor} ({r.actorRole}){r.onBehalfOf ? ` on behalf of ${r.onBehalfOf}` : ''}
                  </td>
                  <td data-label="target" style={cellStyle}>
                    {r.targetType ?? '—'} {r.targetId ?? ''}
                  </td>
                  <td data-label="outcome" style={{ ...cellStyle, color: severityColorVar(outcomeSeverity(r.outcome)) }}>{r.outcome}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination basePath={`/admin/members/${encodeURIComponent(ssoUsername)}`} paramName="auditPage" meta={auditRows.meta} otherParams={otherParams} />
    </Pane>
  );
}
