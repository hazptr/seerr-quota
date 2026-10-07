/**
 * `POST /api/admin/quota/override` — `FR-ADM-6`'s per-member half. Commits
 * via `@/lib/quota/policy.ts`'s `setMemberOverride` (already built,
 * already audited — `quota.set`, before/after, and `FR-POL-5`'s overage/
 * `requiresConfirmation` data in the audit `detail`). `0` means unlimited
 * (`FR-POL-2`); this route never special-cases it.
 *
 * Rejects an unknown `ssoUsername` with 404 BEFORE calling the write —
 * `setMemberOverride` itself would happily upsert a `quota_policy` row for a
 * username with no matching `member` row (the two tables aren't
 * foreign-keyed), which would silently create a phantom quota policy for a
 * typo'd username rather than surfacing the mistake.
 */
import { eq } from 'drizzle-orm';
import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { member } from '@/lib/db/schema';
import { gbToBytes, setMemberOverride } from '@/lib/quota';
import { readJsonBody, requireOperatorForRoute } from '../../_shared/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  ssoUsername: string;
  proposedGb: number;
  note?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Auth is checked BEFORE the body is even parsed — a member posting a
  // malformed body must still get a genuine 403, never a 400 that leaks
  // ahead of the authorization check.
  const guard = await requireOperatorForRoute(req);
  if (guard.kind === 'denied') return guard.response;

  const parsed = await readJsonBody<Body>(req);
  if (parsed.kind === 'invalid') return parsed.response;
  const body = parsed.body;

  const ssoUsername = typeof body.ssoUsername === 'string' ? body.ssoUsername.trim() : '';
  if (ssoUsername === '') return NextResponse.json({ error: 'ssoUsername is required' }, { status: 400 });

  if (typeof body.proposedGb !== 'number' || !Number.isFinite(body.proposedGb)) {
    return NextResponse.json({ error: 'proposedGb must be a finite number' }, { status: 400 });
  }

  const db = getDb();
  const memberExists = db.select({ ssoUsername: member.ssoUsername }).from(member).where(eq(member.ssoUsername, ssoUsername)).get();
  if (!memberExists) return NextResponse.json({ error: 'unknown member' }, { status: 404 });

  const outcome = setMemberOverride(db, {
    ssoUsername,
    proposedBytes: gbToBytes(body.proposedGb),
    actor: guard.identity.username,
    note: typeof body.note === 'string' && body.note.trim() !== '' ? body.note.trim() : undefined,
  });

  if (outcome.kind === 'invalid') return NextResponse.json({ error: outcome.reason }, { status: 400 });
  return NextResponse.json({ ok: true, before: outcome.result.before, after: outcome.result.after, effect: outcome.result.effect, warning: outcome.warning ?? null });
}
