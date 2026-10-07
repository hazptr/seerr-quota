/**
 * `POST /api/admin/titles/unprotect` — `FR-ADM-7`. Body: `{ titleId }`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { unprotectTitle } from '@/app/admin/_actions/titleActions';
import { readJsonBody, requireOperatorForRoute } from '../../_shared/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  titleId: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await requireOperatorForRoute(req);
  if (guard.kind === 'denied') return guard.response;

  const parsed = await readJsonBody<Body>(req);
  if (parsed.kind === 'invalid') return parsed.response;
  const body = parsed.body;

  const titleId = typeof body.titleId === 'string' ? body.titleId.trim() : '';
  if (titleId === '') return NextResponse.json({ error: 'titleId is required' }, { status: 400 });

  const outcome = unprotectTitle(getDb(), { titleId, actor: guard.identity.username });

  if (outcome.kind === 'not_found') return NextResponse.json({ error: 'unknown title' }, { status: 404 });
  return NextResponse.json({ ok: true, titleId: outcome.titleId });
}
