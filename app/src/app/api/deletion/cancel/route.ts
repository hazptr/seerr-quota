/**
 * `POST /api/deletion/cancel` — undo a scheduled deletion before the sweeper
 * runs it (`FR-DEL-24`).
 *
 * Non-destructive by construction: the handler it calls can only move a
 * `deletion` row from `scheduled` to `cancelled`. There is deliberately no
 * three-step ceremony here — AGENTS.md rule 3 exists to make destruction
 * deliberate, and cancelling is the opposite of destruction. Making an undo
 * hard to reach would be the wrong lesson to draw from it.
 *
 * Identity is resolved server-side (`requireIdentity`) and passed as a
 * trusted actor; the body carries only the deletion id. Authority — owner or
 * operator — is re-derived inside `cancelScheduledDeletion` from the row's
 * own `sso_username`, never from the request, so guessing an id belonging to
 * someone else returns the same `not_found` as an id that doesn't exist.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { AuthError, requireEntitledMemberOrOperator, toAuthErrorResponse } from '@/lib/auth/authorize';
import { cancelScheduledDeletion } from '@/lib/deletion';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RawBody {
  deletionId?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let identity;
  try {
    // Security review (PR #17): a non-operator must be a currently
    // matched/entitled member; an operator bypasses that check (they may
    // be cancelling another member's deletion — FR-DEL-28) — see
    // `requireEntitledMemberOrOperator`'s own doc comment.
    identity = await requireEntitledMemberOrOperator({ route: req.nextUrl.pathname });
  } catch (err) {
    if (err instanceof AuthError) return toAuthErrorResponse(err);
    throw err;
  }

  let body: RawBody;
  try {
    body = (await req.json()) as RawBody;
  } catch {
    return NextResponse.json({ error: 'invalid json body' }, { status: 400 });
  }

  // Integer-only: a float or numeric string would reach SQLite's loose
  // comparison rules and could match a row the caller didn't name.
  const deletionId = typeof body.deletionId === 'number' && Number.isInteger(body.deletionId) ? body.deletionId : null;
  if (deletionId === null) {
    return NextResponse.json({ error: 'deletionId must be an integer' }, { status: 400 });
  }

  const result = cancelScheduledDeletion({ username: identity.username, isOperator: identity.isOperator }, deletionId, { source: 'ui' });

  // `not_found` covers "not yours" too (see `cancel.ts`) — 404 for both, so
  // the response can't be used to probe which ids exist.
  const status = result.outcome === 'cancelled' ? 200 : result.outcome === 'not_found' ? 404 : 409;
  return NextResponse.json(result, { status });
}
