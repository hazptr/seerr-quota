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

/**
 * Best-effort, pre-auth peek at the body's `ssoUsername` so a denied
 * attempt's `access.denied` row can name the specific member it targeted
 * (second security review, PR #17, SHOULD-FIX), matching
 * `src/lib/auth/authorize.ts`'s `AccessCheckContext.target` convention
 * every member-drill-down route already uses. Deliberately tolerant —
 * malformed/missing JSON here is NOT an error at this stage; the real,
 * validated parse (`readJsonBody`) still happens AFTER the operator check,
 * so a member posting garbage still gets a genuine 403, never a 400 that
 * leaks ahead of the authorization check.
 */
async function peekSsoUsername(req: NextRequest): Promise<string | undefined> {
  try {
    const raw = (await req.clone().json()) as Body;
    return typeof raw.ssoUsername === 'string' ? raw.ssoUsername.trim().toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const candidate = await peekSsoUsername(req);
  const guard = await requireOperatorForRoute(req, candidate ? { type: 'member', id: candidate } : undefined);
  if (guard.kind === 'denied') return guard.response;

  const parsed = await readJsonBody<Body>(req);
  if (parsed.kind === 'invalid') return parsed.response;

  // Lowercased — `member.sso_username` is always stored lowercase
  // (`src/lib/auth/identity.ts`'s convention); a differently-cased input
  // must not silently miss a real row and report a false `not_found`.
  const ssoUsername = typeof parsed.body.ssoUsername === 'string' ? parsed.body.ssoUsername.trim().toLowerCase() : '';
  if (ssoUsername === '') return NextResponse.json({ error: 'ssoUsername is required' }, { status: 400 });

  const outcome = clearLoginAlias(getDb(), ssoUsername, guard.identity.username);
  if (outcome.kind === 'not_found') return NextResponse.json({ error: 'unknown member' }, { status: 404 });
  return NextResponse.json({ ok: true, ssoUsername });
}
