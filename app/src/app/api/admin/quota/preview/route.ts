/**
 * `POST /api/admin/quota/preview` — `FR-POL-4`/`FR-POL-5`'s "what would this
 * do" preview, read-only (no write, no audit row — matching
 * `@/lib/quota/policy.ts`'s own `preview*` functions, which this route calls
 * verbatim). The operator's client calls this BEFORE `POST .../default`,
 * `.../override`, or `.../clear`, to render the newly-over/newly-under list
 * (default) or the single-member overage + `requiresConfirmation` flag
 * (override/clear) ahead of a commit.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { checkFreeSpaceWarning, gbToBytes, previewGlobalDefaultChange, previewMemberClearOverride, previewMemberOverrideChange, readBulkDriveFreeBytes } from '@/lib/quota';
import { getConfig } from '@/lib/config';
import { readJsonBody, requireOperatorForRoute } from '../../_shared/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body =
  | { mode: 'default'; proposedGb: number }
  | { mode: 'override'; ssoUsername: string; proposedGb: number }
  | { mode: 'clear'; ssoUsername: string };

function freeSpaceWarningMessage(proposedBytes: number): string | null {
  const freeBytes = readBulkDriveFreeBytes(getConfig().paths.mediaFreeSpacePath);
  const warning = checkFreeSpaceWarning(proposedBytes, freeBytes);
  return warning.warn ? (warning.message ?? null) : null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await requireOperatorForRoute(req);
  if (guard.kind === 'denied') return guard.response;

  const parsed = await readJsonBody<Body>(req);
  if (parsed.kind === 'invalid') return parsed.response;
  const body = parsed.body;

  const db = getDb();

  if (body.mode === 'default') {
    if (typeof body.proposedGb !== 'number' || !Number.isFinite(body.proposedGb)) {
      return NextResponse.json({ error: 'proposedGb must be a finite number' }, { status: 400 });
    }
    const proposedBytes = gbToBytes(body.proposedGb);
    const preview = previewGlobalDefaultChange(db, proposedBytes);
    return NextResponse.json({ kind: 'default', preview, warning: freeSpaceWarningMessage(proposedBytes) });
  }

  if (body.mode === 'override') {
    if (typeof body.ssoUsername !== 'string' || body.ssoUsername.trim() === '') {
      return NextResponse.json({ error: 'ssoUsername is required' }, { status: 400 });
    }
    if (typeof body.proposedGb !== 'number' || !Number.isFinite(body.proposedGb)) {
      return NextResponse.json({ error: 'proposedGb must be a finite number' }, { status: 400 });
    }
    const proposedBytes = gbToBytes(body.proposedGb);
    const preview = previewMemberOverrideChange(db, body.ssoUsername, proposedBytes);
    if (!preview) return NextResponse.json({ error: 'unknown member' }, { status: 404 });
    return NextResponse.json({ kind: 'override', preview, warning: freeSpaceWarningMessage(proposedBytes) });
  }

  if (body.mode === 'clear') {
    if (typeof body.ssoUsername !== 'string' || body.ssoUsername.trim() === '') {
      return NextResponse.json({ error: 'ssoUsername is required' }, { status: 400 });
    }
    const preview = previewMemberClearOverride(db, body.ssoUsername);
    if (!preview) return NextResponse.json({ error: 'unknown member' }, { status: 404 });
    return NextResponse.json({ kind: 'clear', preview });
  }

  return NextResponse.json({ error: 'invalid mode' }, { status: 400 });
}
