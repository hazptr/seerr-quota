/**
 * `POST /api/admin/settings` — `FR-ADM-11`'s six plain `app_setting` values
 * (everything except `default_quota_bytes`, which is `FR-ADM-6`'s
 * `.../quota/default`, and `enforcement_enabled`, which has its own route —
 * see `../enforcement/route.ts`'s header comment for why).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { EDITABLE_NUMERIC_SETTINGS, type EditableNumericSettingKey } from '@/components/admin/logic';
import { setNumericSetting } from '@/app/admin/_actions/settingsActions';
import { readJsonBody, requireOperatorForRoute } from '../_shared/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  key: string;
  value: number;
}

function isEditableKey(key: string): key is EditableNumericSettingKey {
  return (EDITABLE_NUMERIC_SETTINGS as readonly string[]).includes(key);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await requireOperatorForRoute(req);
  if (guard.kind === 'denied') return guard.response;

  const parsed = await readJsonBody<Body>(req);
  if (parsed.kind === 'invalid') return parsed.response;
  const body = parsed.body;

  if (typeof body.key !== 'string' || !isEditableKey(body.key)) {
    return NextResponse.json({ error: `key must be one of: ${EDITABLE_NUMERIC_SETTINGS.join(', ')}` }, { status: 400 });
  }
  if (typeof body.value !== 'number' || !Number.isFinite(body.value)) {
    return NextResponse.json({ error: 'value must be a finite number' }, { status: 400 });
  }

  const outcome = setNumericSetting(getDb(), { key: body.key, value: body.value, actor: guard.identity.username });

  if (outcome.kind === 'invalid') return NextResponse.json({ error: outcome.reason }, { status: 400 });
  return NextResponse.json({ ok: true, key: body.key, before: outcome.before, after: outcome.after });
}
