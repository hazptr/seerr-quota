/**
 * `POST /api/admin/titles/protect` — `FR-ADM-7`. Body: `{ titleId, reason }`.
 * `reason` is required (rejected empty) since it is shown, verbatim, to the
 * member whose deletion it blocks — see `../../../admin/_actions/titleActions.ts`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { protectTitle } from '@/app/admin/_actions/titleActions';
import { readJsonBody, requireOperatorForRoute } from '../../_shared/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  titleId: string;
  reason: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await requireOperatorForRoute(req);
  if (guard.kind === 'denied') return guard.response;

  const parsed = await readJsonBody<Body>(req);
  if (parsed.kind === 'invalid') return parsed.response;
  const body = parsed.body;

  const titleId = typeof body.titleId === 'string' ? body.titleId.trim() : '';
  if (titleId === '') return NextResponse.json({ error: 'titleId is required' }, { status: 400 });

  const outcome = protectTitle(getDb(), { titleId, reason: typeof body.reason === 'string' ? body.reason : '', actor: guard.identity.username });

  if (outcome.kind === 'not_found') return NextResponse.json({ error: 'unknown title' }, { status: 404 });
  if (outcome.kind === 'invalid') return NextResponse.json({ error: outcome.reason }, { status: 400 });
  return NextResponse.json({ ok: true, titleId: outcome.titleId, reason: outcome.reason });
}
