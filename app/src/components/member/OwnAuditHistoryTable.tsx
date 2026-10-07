/**
 * `FR-AUD-10`: a member's own audit history. Renders ONLY
 * `MemberSafeAuditRow` (`@/lib/audit`'s `toMemberSafeAuditRow` output) —
 * this component never receives, and therefore cannot render, a raw
 * `before`/`after`/`detail` blob. See `src/lib/audit/memberSafe.ts`'s header
 * comment for why that allow-list boundary lives one layer down, in
 * `@/lib/audit`, rather than here: this component has no way to "leak"
 * something it was never handed.
 *
 * Read-only, plain server component (no client JS, `FR-UI-9`) — paging
 * reuses `@/components/admin/Pagination`'s generic plain-`<a>` pager (it has
 * no operator-specific behaviour, just `basePath`/`paramName`/`meta`).
 */
import { formatGB, formatTimestamp, outcomeSeverity, severityColorVar } from '@/components/member/logic';
import { Pagination } from '@/components/admin/Pagination';
import type { PageMeta } from '@/components/admin/logic';
import type { JsonScalar, MemberSafeAuditRow } from '@/lib/audit';

const cellStyle = { padding: '0.375rem 0.625rem', borderBottom: 'var(--sq-border-width) var(--sq-rule-style) var(--sq-rule)', verticalAlign: 'top' as const };
const headStyle = { ...cellStyle, textAlign: 'left' as const, color: 'var(--sq-muted)', fontWeight: 400, whiteSpace: 'nowrap' as const };

/** Bytes-suffixed numeric fields render as GB (matching this app's decimal-GB convention everywhere else, `FR-ACCT-9`); everything else renders as its plain value. */
function formatFieldValue(key: string, value: JsonScalar): string {
  if (typeof value === 'number' && /Bytes$/.test(key)) return formatGB(value);
  if (value === null) return '—';
  return String(value);
}

function FieldList({ label, fields }: { label: string; fields: Record<string, JsonScalar> }) {
  const entries = Object.entries(fields);
  if (entries.length === 0) return null;
  return (
    <div style={{ fontSize: '0.75rem' }}>
      <span style={{ color: 'var(--sq-muted)' }}>{label}: </span>
      {entries.map(([key, value], i) => (
        <span key={key}>
          {i > 0 ? ', ' : ''}
          {key} = {formatFieldValue(key, value)}
        </span>
      ))}
    </div>
  );
}

export function OwnAuditHistoryTable({
  basePath,
  history,
  timeZone,
  otherParams,
}: {
  basePath: string;
  history: { rows: MemberSafeAuditRow[]; meta: PageMeta };
  timeZone: string;
  otherParams?: Record<string, string | number>;
}) {
  return (
    <>
      {history.rows.length === 0 ? (
        <p className="sq-empty" style={{ margin: 0 }}>
          no history yet
        </p>
      ) : (
        <div style={{ overflowX: 'auto', width: '100%' }}>
          <table className="sq-table-responsive" style={{ width: '100%', minWidth: '40rem', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
            <thead>
              <tr>
                <th style={headStyle} scope="col">
                  when
                </th>
                <th style={headStyle} scope="col">
                  action
                </th>
                <th style={headStyle} scope="col">
                  target
                </th>
                <th style={headStyle} scope="col">
                  outcome
                </th>
                <th style={headStyle} scope="col">
                  detail
                </th>
              </tr>
            </thead>
            <tbody>
              {history.rows.map((r) => (
                <tr key={r.id}>
                  <td data-label="when" style={cellStyle}>{formatTimestamp(Math.floor(r.ts / 1000), timeZone)}</td>
                  <td data-label="action" style={cellStyle}>
                    {r.action}
                    {r.byOperator ? <span style={{ color: 'var(--sq-muted)' }}> (by an operator, on your behalf)</span> : null}
                  </td>
                  <td data-label="target" style={cellStyle}>
                    {r.targetType ?? '—'} {r.targetId ?? ''}
                  </td>
                  <td data-label="outcome" style={{ ...cellStyle, color: severityColorVar(outcomeSeverity(r.outcome)) }}>{r.outcome}</td>
                  <td data-label="detail" style={{ ...cellStyle, minWidth: '14rem' }}>
                    <FieldList label="before" fields={r.before} />
                    <FieldList label="after" fields={r.after} />
                    <FieldList label="detail" fields={r.detail} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination basePath={basePath} paramName="page" meta={history.meta} otherParams={otherParams ?? {}} />
    </>
  );
}
