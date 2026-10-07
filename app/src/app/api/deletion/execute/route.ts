/**
 * `POST /api/deletion/execute` — step 3 of the `D-7` flow, the confirm
 * screen's submit target.
 *
 * **This endpoint no longer deletes anything** (`FR-DEL-22`). It hands off to
 * `scheduleDeletionBatch`, which records a pending deletion that becomes
 * cancellable for `DELETE_GRACE_PERIOD` and is executed later by the sweeper
 * (`@/lib/deletion/runner`) — or never, if somebody cancels it. Claim
 * *releases* still complete inline, because they destroy nothing
 * (`FR-DEL-23`).
 *
 * The path is kept at `/execute` rather than renamed to `/schedule`: it is
 * the same user-facing action (the confirm button) and the same request
 * body, and an in-flight client that still POSTs here must get the new, safer
 * behaviour rather than a 404 that looks like the delete silently failed.
 * `/api/deletion/schedule` exists as an alias for new callers.
 * Member-facing: any currently matched/entitled identity may call this for
 * THEIR OWN claims (`requireEntitledMember`, not `requireOperator` — this
 * route has no concept of "act on someone else's behalf", unlike the
 * backend module's operator-only `onBehalfOf`/`overrideGuards` options,
 * which this route deliberately never wires up — that is admin territory,
 * out of this task's scope). `requireEntitledMember` (security review, PR
 * #17) additionally re-checks `member.sync_status === 'matched'` — plain
 * `requireIdentity` would let a `not_entitled`/deactivated login (still
 * holding old claims from before they lost entitlement) reach this route.
 *
 * This route does NOT re-implement any authorization rule. It exists only
 * to (1) resolve the caller's identity server-side — never trusted from the
 * body — and (2) hand the request straight to `scheduleDeletionBatch`
 * (`@/lib/deletion`), which re-reads fresh claim/protection/guard state and
 * re-derives every decision itself (`FR-DEL-1`/`FR-DEL-14`). See that
 * module's own doc comments for the IDOR guard, the rate limit, and the
 * exception-safe batch loop — none of it is duplicated here.
 *
 * Body shape is passed through with only minimal structural validation
 * (an array of `{ titleId, requestedMode }`) — `requestedMode` is
 * deliberately NOT pre-validated against the `DeletionMode` allowlist here.
 * `deriveTitleAction` (`src/lib/deletion/authorize.ts`) validates it as its
 * very FIRST check and fails closed (`FR-DEL-15`) on anything else; adding a
 * second, weaker validation here would be exactly the kind of
 * caller-side-trust this module's own docs warn against. A malformed/absent
 * `items` array is the only thing this route itself rejects (400) — nothing
 * downstream of "well-formed JSON body" is this route's job to police.
 *
 * Never issues a real Radarr/Sonarr/Seerr call in a test — `scheduleDeletionBatch`
 * takes its upstream clients from config-resolved real HTTP clients only when
 * `deps` isn't supplied; this route never overrides `deps`, exactly like
 * production. Tests for this route accordingly must inject their own fake
 * clients directly against `scheduleDeletionBatch`, or (for the route
 * boundary itself) only exercise the auth/validation paths that return
 * before any upstream call would happen.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { AuthError, requireEntitledMember, toAuthErrorResponse } from '@/lib/auth/authorize';
import { scheduleDeletionBatch, type DeletionMode, type DeletionRequestItem } from '@/lib/deletion';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RawItem {
  titleId?: unknown;
  requestedMode?: unknown;
}

interface RawBody {
  items?: unknown;
}

function parseItems(body: RawBody): DeletionRequestItem[] | null {
  if (!Array.isArray(body.items) || body.items.length === 0) return null;
  const items: DeletionRequestItem[] = [];
  for (const raw of body.items as RawItem[]) {
    if (typeof raw !== 'object' || raw === null) return null;
    const titleId = typeof raw.titleId === 'string' ? raw.titleId.trim() : '';
    if (titleId === '') return null;
    // Deliberately NOT validated against the DeletionMode allowlist here —
    // see this file's header comment. Whatever the client sent (including
    // garbage) flows straight to `scheduleDeletionBatch`, which fails closed
    // on it (`FR-DEL-15`).
    items.push({ titleId, requestedMode: raw.requestedMode as DeletionMode });
  }
  return items;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let identity;
  try {
    // Security review (PR #17): re-checks `member.sync_status === 'matched'`
    // server-side, not just "some identity resolved" — see
    // `requireEntitledMember`'s own doc comment.
    identity = await requireEntitledMember({ route: req.nextUrl.pathname });
  } catch (err) {
    if (err instanceof AuthError) return toAuthErrorResponse(err);
    throw err;
  }

  let body: RawBody;
  try {
    body = (await req.json()) as RawBody;
  } catch {
    return NextResponse.json({ error: 'invalid json body' }, { status: 400 });
  }

  const items = parseItems(body);
  if (items === null) {
    return NextResponse.json({ error: 'items must be a non-empty array of { titleId, requestedMode }' }, { status: 400 });
  }

  // `onBehalfOf`/`overrideGuards` are never set from this route — a member
  // (operator or not) using their OWN delete flow only ever acts as
  // themselves. `scheduleDeletionBatch` still honours `identity.isOperator`
  // for the rules that are genuinely role-based regardless of actor
  // (e.g. an operator co-claimant's blanket delete authority, D-6) —
  // that is `@/lib/deletion`'s own decision, not something this route adds.
  const result = await scheduleDeletionBatch({ username: identity.username, isOperator: identity.isOperator }, items, {}, { source: 'ui' });

  return NextResponse.json(result, { status: 200 });
}
