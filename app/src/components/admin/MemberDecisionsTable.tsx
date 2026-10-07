/**
 * `FR-ADM-5`'s "decisions" — one row per `request_decision` (`FR-ADM-5`),
 * server-side paginated. Renders shadow-mode verdicts correctly (this task's
 * item 5): a row with `enforced=false` shows "would have held — over quota",
 * never a bare "held" or a bare "would have held" — see
 * `@/components/admin/logic`'s `describeDecision`.
 *
 * `DecisionCell` also renders `ManualRedecideControl` (`FR-ADM-8`/
 * `FR-ENF-11`) for `hold`/`skip` rows — the only non-terminal decisions (an
 * `approve`/`decline` row is already reflected in Seerr; re-running it would
 * just report "already resolved"). This table stays a Server Component; only
 * that small per-row button is client-interactive.
 */
import { Pane } from '@/components/ui/Pane';
import { formatGB, formatTimestamp, severityColorVar } from '@/components/member/logic';
import { ManualRedecideControl } from './ManualRedecideControl';
import { Pagination } from './Pagination';
import { decisionSeverity, describeDecision, type PageMeta } from './logic';
import type { MemberDecisionRow } from '@/app/admin/members/[username]/_data/memberDetail';

const cellStyle = { padding: '0.375rem 0.625rem', borderBottom: 'var(--sq-border-width) var(--sq-rule-style) var(--sq-rule)' } as const;
const numericCellStyle = { ...cellStyle, textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const };
const headStyle = { ...cellStyle, textAlign: 'left' as const, color: 'var(--sq-muted)', fontWeight: 400, whiteSpace: 'nowrap' as const };

function DecisionCell({ row }: { row: MemberDecisionRow }) {
  const text = describeDecision(row.decision, row.reason, row.enforced);
  const severity = decisionSeverity(row.decision);
  const color = severity ? severityColorVar(severity) : undefined;
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: '0.25rem' }}>
      <span style={{ color }}>{row.decision === 'hold' && row.enforced ? <strong>{text}</strong> : text}</span>
      {(row.decision === 'hold' || row.decision === 'skip') && <ManualRedecideControl seerrRequestId={row.seerrRequestId} />}
    </span>
  );
}

export function MemberDecisionsTable({
  ssoUsername,
  decisions,
  timeZone,
  otherParams,
}: {
  ssoUsername: string;
  decisions: { rows: MemberDecisionRow[]; meta: PageMeta };
  timeZone: string;
  otherParams: Record<string, string | number>;
}) {
  return (
    <Pane title="enforcement decisions">
      {decisions.rows.length === 0 ? (
        <p className="sq-empty" style={{ margin: 0 }}>
          no decisions recorded
        </p>
      ) : (
        <div style={{ overflowX: 'auto', width: '100%' }}>
          <table className="sq-table-responsive" style={{ width: '100%', minWidth: '38rem', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
            <thead>
              <tr>
                <th style={headStyle} scope="col">
                  request
                </th>
                <th style={headStyle} scope="col">
                  decision
                </th>
                <th style={numericCellStyle} scope="col">
                  usage / quota
                </th>
                <th style={headStyle} scope="col">
                  source
                </th>
                <th style={headStyle} scope="col">
                  decided
                </th>
              </tr>
            </thead>
            <tbody>
              {decisions.rows.map((d) => (
                <tr key={d.seerrRequestId}>
                  <td data-label="request" style={cellStyle}>#{d.seerrRequestId}</td>
                  <td data-label="decision" style={cellStyle}>
                    <DecisionCell row={d} />
                  </td>
                  <td data-label="usage / quota" style={numericCellStyle}>
                    {d.usageBytes === null ? '—' : formatGB(d.usageBytes)} / {d.quotaBytes === null ? '—' : d.quotaBytes === 0 ? 'unlimited' : formatGB(d.quotaBytes)}
                  </td>
                  <td data-label="source" style={cellStyle}>{d.source}</td>
                  <td data-label="decided" style={cellStyle}>{formatTimestamp(d.decidedAt, timeZone)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination basePath={`/admin/members/${encodeURIComponent(ssoUsername)}`} paramName="decisionsPage" meta={decisions.meta} otherParams={otherParams} />
    </Pane>
  );
}
