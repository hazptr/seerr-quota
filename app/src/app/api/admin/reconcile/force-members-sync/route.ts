/**
 * `POST /api/admin/reconcile/force-members-sync` — second security review
 * (PR #17), SHOULD-FIX 2: the one-shot operator override for
 * `checkMassRevocationRisk`'s refusal (`src/lib/members/classify.ts`). A
 * refused cycle leaves `member` completely untouched and keeps refusing on
 * every SCHEDULED run — this route is the explicit, audited (`sync.forced`)
 * way for an operator who has confirmed the refusal is correct-but-unwanted
 * (a real, large departure, not a flaky Seerr response) to apply it anyway,
 * for exactly one cycle. Distinct from `POST /api/admin/reconcile` (which
 * runs the whole five-pipeline sequence and never bypasses this guard) —
 * this route runs ONLY the members-sync step, with the override flag set.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { syncMembers } from '@/lib/members/sync';
import { requireOperatorForRoute } from '../../_shared/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await requireOperatorForRoute(req);
  if (guard.kind === 'denied') return guard.response;

  const result = await syncMembers({}, undefined, { forceApply: true, forcedBy: guard.identity.username });
  return NextResponse.json({ ok: result.classify.ok, classify: result.classify, seerrUsers: result.seerrUsers });
}
