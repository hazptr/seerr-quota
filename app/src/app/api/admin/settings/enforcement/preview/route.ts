/**
 * `GET /api/admin/settings/enforcement/preview` — read-only counterpart to
 * `../route.ts`. Lets the client show "enabling this holds N members'
 * requests right now: [names]" before the operator confirms, and disable the
 * "enable" control outright when `default_quota_bytes` is unset. No write,
 * no audit row.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { previewEnforcementToggle } from '@/app/admin/_actions/settingsActions';
import { requireOperatorForRoute } from '../../../_shared/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const guard = await requireOperatorForRoute(req);
  if (guard.kind === 'denied') return guard.response;

  const preview = await previewEnforcementToggle(getDb());
  return NextResponse.json(preview);
}
