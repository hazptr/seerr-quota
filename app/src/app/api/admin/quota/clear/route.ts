/**
 * `POST /api/admin/quota/clear` — `FR-ADM-6`'s "clear it" half. Commits via
 * `@/lib/quota/policy.ts`'s `clearMemberOverride` (already built, already
 * audited — `quota.cleared`). Writes a bare `null` (inherit the default),
 * never a resolved value (`FR-POL-2a` — see that module's header comment).
 */
import { eq } from 'drizzle-orm';
import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { member } from '@/lib/db/schema';
import { clearMemberOverride } from '@/lib/quota';
import { readJsonBody, requireOperatorForRoute } from '../../_shared/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  ssoUsername: string;
  note?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await requireOperatorForRoute(req);
  if (guard.kind === 'denied') return guard.response;

  const parsed = await readJsonBody<Body>(req);
  if (parsed.kind === 'invalid') return parsed.response;
  const body = parsed.body;

  const ssoUsername = typeof body.ssoUsername === 'string' ? body.ssoUsername.trim() : '';
  if (ssoUsername === '') return NextResponse.json({ error: 'ssoUsername is required' }, { status: 400 });

  const db = getDb();
  const memberExists = db.select({ ssoUsername: member.ssoUsername }).from(member).where(eq(member.ssoUsername, ssoUsername)).get();
  if (!memberExists) return NextResponse.json({ error: 'unknown member' }, { status: 404 });

  const result = clearMemberOverride(db, {
    ssoUsername,
    actor: guard.identity.username,
    note: typeof body.note === 'string' && body.note.trim() !== '' ? body.note.trim() : undefined,
  });

  return NextResponse.json({ ok: true, before: result.before, after: result.after });
}
