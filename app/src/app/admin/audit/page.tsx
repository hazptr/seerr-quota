/**
 * `FR-AUD-9`: the operator's audit browse + export screen. Operator-only,
 * re-checked server-side (`requireOperator`, `FR-ADM-1`) — same guard every
 * other operator-only page in this app uses, so a member hitting this URL
 * directly gets a genuine 403 and an `access.denied` audit row (written by
 * `requireOperator` itself before it throws).
 *
 * Server-side PAGINATED (`./​_data/auditBrowse.ts`) — this page never asks
 * for more than one page of rows. Export (CSV/JSONL) is a SEPARATE route
 * (`/api/admin/audit/export`, its own independent `requireOperator` check)
 * rather than something this page builds in-process, so the export can
 * stream instead of buffering into a Server Component's response.
 */
import { forbidden, unauthorized } from 'next/navigation';
import { AppShell } from '@/components/shell/AppShell';
import { Pane } from '@/components/ui/Pane';
import { AuditFilterForm } from '@/components/admin/AuditFilterForm';
import { AuditBrowseTable } from '@/components/admin/AuditBrowseTable';
import { parseAuditFilterQuery, type AuditFilterQuery } from '@/components/admin/auditLogic';
import { AuthError, requireOperator } from '@/lib/auth/authorize';
import { getConfig } from '@/lib/config';
import type { Identity } from '@/lib/auth/identity';
import { loadAuditBrowse } from './_data/auditBrowse';

const BASE_PATH = '/admin/audit';

async function requireOperatorOrRespond(): Promise<Identity> {
  try {
    return await requireOperator({ route: BASE_PATH });
  } catch (err) {
    if (err instanceof AuthError) {
      if (err.status === 403) forbidden();
      unauthorized();
    }
    throw err;
  }
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parsePage(value: string | string[] | undefined): number {
  const raw = firstValue(value);
  const n = raw ? Number.parseInt(raw, 10) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export default async function AdminAuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const identity = await requireOperatorOrRespond();
  const sp = await searchParams;

  const query: AuditFilterQuery = {
    actor: firstValue(sp.actor),
    action: firstValue(sp.action),
    targetType: firstValue(sp.targetType),
    targetId: firstValue(sp.targetId),
    outcome: firstValue(sp.outcome),
    from: firstValue(sp.from),
    to: firstValue(sp.to),
  };
  const filter = parseAuditFilterQuery(query);
  const page = parsePage(sp.page);

  const browse = await loadAuditBrowse(filter, page);
  const { tz: timeZone } = getConfig().display;

  const exportParams = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value) exportParams.set(key, value);
  }
  const exportQuery = exportParams.toString();
  const csvHref = `/api/admin/audit/export?format=csv${exportQuery ? `&${exportQuery}` : ''}`;
  const jsonlHref = `/api/admin/audit/export?format=jsonl${exportQuery ? `&${exportQuery}` : ''}`;

  const otherParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value) otherParams[key] = value;
  }

  return (
    <AppShell identity={identity} activeSection="admin">
      <Pane title="audit log">
        <AuditFilterForm basePath={BASE_PATH} current={query} />
        <p style={{ margin: '0 0 0.75rem', fontSize: '0.8125rem' }}>
          export filtered set: <a href={csvHref}>CSV</a> · <a href={jsonlHref}>JSONL</a>
        </p>
        <AuditBrowseTable basePath={BASE_PATH} rows={browse.rows} meta={browse.meta} timeZone={timeZone} otherParams={otherParams} />
      </Pane>
    </AppShell>
  );
}
