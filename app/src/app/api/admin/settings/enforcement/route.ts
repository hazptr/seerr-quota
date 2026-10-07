/**
 * `POST /api/admin/settings/enforcement` — `FR-ADM-11`'s `enforcement_enabled`
 * toggle. Kept as its own route (rather than folded into the generic
 * `.../settings` handler) because it is the one switch in this task "that
 * changes production behaviour for real people" (the project's design): it gets
 * its own audit action (`enforcement.toggled`, not `setting.changed`), its
 * own refusal rule (`default_quota_bytes` must be configured before it can
 * be turned ON — `@/app/admin/_actions/settingsActions.ts`'s
 * `setEnforcementEnabled`), and its own read-only preview counterpart
 * (`./preview/route.ts`) so the client can show "N members would be affected
 * right now" before the operator confirms.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { setEnforcementEnabled } from '@/app/admin/_actions/settingsActions';
import { readJsonBody, requireOperatorForRoute } from '../../_shared/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  enabled: boolean;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await requireOperatorForRoute(req, { type: 'setting', id: 'enforcement_enabled' });
  if (guard.kind === 'denied') return guard.response;

  const parsed = await readJsonBody<Body>(req);
  if (parsed.kind === 'invalid') return parsed.response;
  const body = parsed.body;

  if (typeof body.enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 });
  }

  const outcome = await setEnforcementEnabled(getDb(), { enabled: body.enabled, actor: guard.identity.username });

  if (outcome.kind === 'invalid') return NextResponse.json({ error: outcome.reason }, { status: 400 });
  return NextResponse.json({ ok: true, before: outcome.before, after: outcome.after, affectedCount: outcome.affectedCount, affectedUsernames: outcome.affectedUsernames });
}
