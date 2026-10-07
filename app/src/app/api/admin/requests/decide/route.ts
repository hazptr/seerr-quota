/**
 * `POST /api/admin/requests/decide` — `FR-ADM-8`/`FR-ENF-11`: manually
 * re-evaluate one pending-or-held Seerr request right now, rather than
 * waiting for the next poll. Goes through `processPendingRequest(id,
 * 'manual', deps)` — `@/lib/enforcement`'s existing audited remote-effect
 * path (an intent row before any Seerr call, an outcome row after,
 * `FR-AUD-8`) — the SAME pure `decide()` function the webhook and poller
 * call, so this can never disagree with them (`FR-ENF-1`/`FR-ENF-7`).
 *
 * **Why this isn't a raw force-approve/force-decline.** `decide()` has no
 * parameter for an operator-chosen outcome — it is a pure function of real
 * usage/quota/hold-age state, deliberately the ONE place that logic lives
 * (`FR-ENF-1`'s "so the webhook and poller cannot disagree"). Building a
 * SECOND path that bypasses it (calling Seerr's approve/decline directly)
 * would fork the single source of truth this architecture exists to
 * centralise, and this task is explicitly scoped to go through
 * `processPendingRequest`. So "manually approve/decline a request" is
 * implemented here as "decide it again, right now, with `source: 'manual'`"
 * — which resolves to whatever `decide()` says given the CURRENT data (often
 * exactly what the operator expects: e.g. a member freed space and the
 * operator wants it approved without waiting for the next 15-minute sweep,
 * or a stale-snapshot skip can now resolve). The UI surfaces the ACTUAL
 * resulting decision rather than assuming the click's label happened.
 * Flagged in the project notes as a resolved spec/implementation
 * tension (FR-ADM-8's prose reads as operator-chosen outcomes; the only
 * in-scope, audited write path does not support that).
 *
 * **P2-7 fix**: this route used to call `processPendingRequest` with NO
 * notifier, so `./process.ts`'s `resolveDeps` fell back to `noopNotifier` —
 * meaning a manual operator decline sent the member nothing (`D-4a`'s "a
 * bare unexplained rejection" is exactly what a Seerr decline alone looks
 * like, and this route was silently producing it). Wired the same real
 * notifier `./poller.ts`/the webhook route already build, `source: 'ui'`
 * since this is a human, synchronous action (matching `wiki/Feature-08-
 * Audit-Log.md`'s own "a human's action there is 'ui'" convention for
 * `audit.source`, not the enforcement `request_decision.source: 'manual'`
 * this call already passes separately) — built fresh per request, same "no
 * I/O at construction" cost the webhook route's own comment documents.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createEnforcementNotifier, processPendingRequest } from '@/lib/enforcement';
import { readJsonBody, requireOperatorForRoute } from '../../_shared/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  seerrRequestId: number;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await requireOperatorForRoute(req);
  if (guard.kind === 'denied') return guard.response;

  const parsed = await readJsonBody<Body>(req);
  if (parsed.kind === 'invalid') return parsed.response;
  const body = parsed.body;

  if (typeof body.seerrRequestId !== 'number' || !Number.isInteger(body.seerrRequestId) || body.seerrRequestId <= 0) {
    return NextResponse.json({ error: 'seerrRequestId must be a positive integer' }, { status: 400 });
  }

  const outcome = await processPendingRequest(body.seerrRequestId, 'manual', { notifier: createEnforcementNotifier({ source: 'ui' }) });
  return NextResponse.json({ ok: true, outcome });
}
