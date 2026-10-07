/**
 * `POST /api/admin/reconcile` — `FR-ADM-10`'s trigger half (P1-9 built the
 * read half, `SyncStatusPane`, and deliberately left this for this task).
 * See `@/app/admin/_actions/reconcileActions.ts` for what actually runs and
 * why it needs no new audit action of its own: the five pipelines it calls
 * already write their own `sync_run` row and their own `member.*`/`sync.*`
 * audit rows on real changes (`FR-SYNC-9`'s "only changes are audited"
 * discipline) — this route's job is only to kick them off on demand and
 * return a quick per-step ok/error summary; the operator sees the
 * authoritative per-step detail in the (already-built) `SyncStatusPane`
 * after the page refreshes.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { triggerReconcile } from '@/app/admin/_actions/reconcileActions';
import { requireOperatorForRoute } from '../_shared/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await requireOperatorForRoute(req);
  if (guard.kind === 'denied') return guard.response;

  const outcomes = await triggerReconcile();
  return NextResponse.json({ ok: outcomes.every((o) => o.ok), steps: outcomes });
}
