/**
 * `FR-AUD-9`'s operator browse table. Renders `before`/`after`/`detail`
 * READABLY rather than dumping raw JSON at the operator (this task's
 * brief): each non-null blob sits behind a native `<details>` disclosure
 * (zero JS, `FR-UI-9`) labelled `before`/`after`/`detail`, pretty-printed
 * inside a `<pre>` that's both width- and height-bounded
 * (`overflow: auto`, `max-height`) so `serializeAuditBlob`'s ~8000-byte cap
 * (`src/lib/audit/redact.ts`) still can't blow out the page layout even
 * fully expanded — the "very large blob" edge case
 * (`wiki/Feature-08-Audit-Log.md`).
 */
import type { RawAuditRow } from '@/lib/audit';
import { formatTimestamp, outcomeSeverity, severityColorVar } from '@/components/member/logic';
import { Pagination } from './Pagination';
import type { PageMeta } from './logic';

const cellStyle = { padding: '0.375rem 0.625rem', borderBottom: 'var(--sq-border-width) var(--sq-rule-style) var(--sq-rule)', verticalAlign: 'top' as const };
const headStyle = { ...cellStyle, textAlign: 'left' as const, color: 'var(--sq-muted)', fontWeight: 400, whiteSpace: 'nowrap' as const };

function prettyJson(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw; // defensive — display code degrades rather than throwing
  }
}

function BlobDisclosure({ label, raw }: { label: string; raw: string | null }) {
  const pretty = prettyJson(raw);
  if (pretty === null) return null;
  return (
    <details style={{ marginTop: '0.25rem' }}>
      <summary style={{ cursor: 'pointer', color: 'var(--sq-muted)', fontSize: '0.75rem' }}>{label}</summary>
      <pre
        style={{
          margin: '0.25rem 0 0',
          padding: '0.5rem',
          fontSize: '0.75rem',
          background: 'var(--sq-bg)',
          border: 'var(--sq-border-width) var(--sq-rule-style) var(--sq-rule)',
          maxHeight: '16rem',
          maxWidth: '100%',
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {pretty}
      </pre>
    </details>
  );
}

export function AuditBrowseTable({
  basePath,
  rows,
  meta,
  timeZone,
  otherParams,
}: {
  basePath: string;
  rows: RawAuditRow[];
  meta: PageMeta;
  timeZone: string;
  otherParams: Record<string, string | number>;
}) {
  if (rows.length === 0) {
    return (
      <p className="sq-empty" style={{ margin: 0 }}>
        no audit rows match this filter
      </p>
    );
  }

  return (
    <>
      <div style={{ overflowX: 'auto', width: '100%' }}>
        <table className="sq-table-responsive" style={{ width: '100%', minWidth: '48rem', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
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
              <th style={headStyle} scope="col">
                source
              </th>
              <th style={headStyle} scope="col">
                detail
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
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
                <td data-label="source" style={cellStyle}>{r.source}</td>
                <td data-label="detail" style={{ ...cellStyle, minWidth: '16rem' }}>
                  <BlobDisclosure label="before" raw={r.before} />
                  <BlobDisclosure label="after" raw={r.after} />
                  <BlobDisclosure label="detail" raw={r.detail} />
                  {r.before === null && r.after === null && r.detail === null && <span style={{ color: 'var(--sq-dim)' }}>—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination basePath={basePath} paramName="page" meta={meta} otherParams={otherParams} />
    </>
  );
}
