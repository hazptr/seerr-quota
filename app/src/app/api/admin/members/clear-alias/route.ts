/**
 * `POST /api/admin/members/clear-alias` — operator action (security review,
 * PR #17): clears a member's `login_alias`. Re-linking a stolen/incorrect
 * alias is never automatic (`src/lib/auth/memberGate.ts`'s `tryLinkByEmail`
 * refuses to overwrite one in place) — this is the explicit undo path.
 * Body: `{ ssoUsername }`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { clearLoginAlias } from '@/lib/auth/memberGate';
import { readJsonBody, requireOperatorForRoute } from '../../_shared/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  ssoUsername?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await requireOperatorForRoute(req);
  if (guard.kind === 'denied') return guard.response;

  const parsed = await readJsonBody<Body>(req);
  if (parsed.kind === 'invalid') return parsed.response;

  const ssoUsername = typeof parsed.body.ssoUsername === 'string' ? parsed.body.ssoUsername.trim() : '';
  if (ssoUsername === '') return NextResponse.json({ error: 'ssoUsername is required' }, { status: 400 });

  const outcome = clearLoginAlias(getDb(), ssoUsername, guard.identity.username);
  if (outcome.kind === 'not_found') return NextResponse.json({ error: 'unknown member' }, { status: 404 });
  return NextResponse.json({ ok: true, ssoUsername });
}
