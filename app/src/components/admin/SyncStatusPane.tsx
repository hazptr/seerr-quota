/**
 * `FR-ADM-10`: both halves now. The READ half — "see per-step results from
 * the last `sync_run`" — is unchanged from P1-9: one row per reconciler
 * pipeline (this app has five independent entry points —
 * `src/lib/{members,library,playback,attribution}/sync.ts`,
 * `src/lib/enforcement/poller.ts` — each writing its own `sync_run` row; see
 * `@/components/admin/logic`'s `classifyPipeline` header comment), each
 * expandable into its own steps' `{ok,count,ms,error}`. `ReconcileTrigger`
 * is the WRITE half P1-9 explicitly left for this task — its own client
 * component (this table stays a Server Component) that POSTs
 * `/api/admin/reconcile` and refreshes the page.
 */
import { Pane } from '@/components/ui/Pane';
import { computeFreshness, formatAge, formatTimestamp, severityColorVar } from '@/components/member/logic';
import { ReconcileTrigger } from './ReconcileTrigger';
import type { PipelineStatus } from './logic';

const cellStyle = { padding: '0.375rem 0.625rem', borderBottom: 'var(--sq-border-width) var(--sq-rule-style) var(--sq-rule)' } as const;
const headStyle = { ...cellStyle, textAlign: 'left' as const, color: 'var(--sq-muted)', fontWeight: 400, whiteSpace: 'nowrap' as const };

function PipelineRow({ status, nowSeconds, staleAfterSeconds, timeZone }: { status: PipelineStatus; nowSeconds: number; staleAfterSeconds: number; timeZone: string }) {
  if (status.neverRun) {
    return (
      <tr>
        <td data-label="pipeline" style={cellStyle}>{status.label}</td>
        <td data-label="last run" style={cellStyle} colSpan={2}>
          <span className="sq-empty">never run yet</span>
        </td>
      </tr>
    );
  }

  const freshness = computeFreshness(status.finishedAt as number, nowSeconds, staleAfterSeconds);

  return (
    <tr>
      <td data-label="pipeline" style={cellStyle}>{status.label}</td>
      <td data-label="last run" style={cellStyle}>
        {formatTimestamp(status.finishedAt as number, timeZone)} ({formatAge(freshness.ageSeconds)})
        {freshness.stale && <strong style={{ color: severityColorVar('warning'), marginLeft: '0.375rem' }}>⚠ stale</strong>}
      </td>
      <td data-label="steps" style={cellStyle}>
        {status.steps.map((s) => (
          <div key={s.stepKey} style={{ whiteSpace: 'nowrap', color: s.ok ? undefined : severityColorVar('critical') }}>
            {s.ok ? '' : '⚠ '}
            {s.stepKey}: {s.ok ? `ok (${s.count})` : `failed${s.error ? ` — ${s.error}` : ''}`}
          </div>
        ))}
      </td>
    </tr>
  );
}

export function SyncStatusPane({
  pipelines,
  nowSeconds,
  staleAfterSeconds,
  timeZone,
}: {
  pipelines: PipelineStatus[];
  nowSeconds: number;
  staleAfterSeconds: number;
  timeZone: string;
}) {
  return (
    <Pane title="sync status">
      <ReconcileTrigger />
      <div style={{ overflowX: 'auto', width: '100%' }}>
        <table className="sq-table-responsive" style={{ width: '100%', minWidth: '32rem', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
          <thead>
            <tr>
              <th style={headStyle} scope="col">
                pipeline
              </th>
              <th style={headStyle} scope="col">
                last run
              </th>
              <th style={headStyle} scope="col">
                steps
              </th>
            </tr>
          </thead>
          <tbody>
            {pipelines.map((p) => (
              <PipelineRow key={p.kind} status={p} nowSeconds={nowSeconds} staleAfterSeconds={staleAfterSeconds} timeZone={timeZone} />
            ))}
          </tbody>
        </table>
      </div>
    </Pane>
  );
}
