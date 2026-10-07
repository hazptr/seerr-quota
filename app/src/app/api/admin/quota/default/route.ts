/**
 * `POST /api/admin/quota/default` — `FR-ADM-6`'s global-default half.
 * Commits via `@/lib/quota/policy.ts`'s `setGlobalDefaultQuota` (already
 * built, already audited — `setting.changed`, before/after, and a `detail`
 * summarising who this change pushes newly over/under, computed from the
 * SAME preview `POST .../preview` shows beforehand). This route's only job
 * is auth + input parsing; see `@/lib/quota/policy.ts` for the write itself.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { gbToBytes, setGlobalDefaultQuota } from '@/lib/quota';
import { readJsonBody, requireOperatorForRoute } from '../../_shared/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  proposedGb: number;
  note?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await requireOperatorForRoute(req, { type: 'setting', id: 'default_quota_bytes' });
  if (guard.kind === 'denied') return guard.response;

  const parsed = await readJsonBody<Body>(req);
  if (parsed.kind === 'invalid') return parsed.response;
  const body = parsed.body;

  if (typeof body.proposedGb !== 'number' || !Number.isFinite(body.proposedGb)) {
    return NextResponse.json({ error: 'proposedGb must be a finite number' }, { status: 400 });
  }

  const outcome = setGlobalDefaultQuota(getDb(), {
    proposedBytes: gbToBytes(body.proposedGb),
    actor: guard.identity.username,
    note: typeof body.note === 'string' && body.note.trim() !== '' ? body.note.trim() : undefined,
  });

  if (outcome.kind === 'invalid') return NextResponse.json({ error: outcome.reason }, { status: 400 });
  return NextResponse.json({ ok: true, before: outcome.result.before, after: outcome.result.after, warning: outcome.warning ?? null });
}
