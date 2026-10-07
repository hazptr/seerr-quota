/**
 * Shared boilerplate for every `src/app/api/admin/**` mutation route
 * (`FR-ADM-1`/`FR-SSO-5`: "Every route and API in this feature MUST be
 * operator-only, authorized server-side per request"). Two small helpers,
 * used at the top of every route handler in this task:
 *
 *   - `requireOperatorForRoute`: the SAME `requireOperator` guard every other
 *     operator-only path in this app uses (`src/lib/auth/authorize.ts`) —
 *     re-checked on THIS request, never cached from a page render — wrapped
 *     so a route handler gets back either the authorized `Identity` or an
 *     already-built 401/403 `NextResponse` to return verbatim. A denied
 *     attempt has already written its `access.denied` audit row (inside
 *     `requireOperator` itself) by the time this returns — see that
 *     function's own doc comment.
 *   - `readJsonBody`: the same "invalid JSON -> 400" shape
 *     `src/app/api/seerr/webhook/route.ts` already uses, factored out so
 *     eleven route handlers don't each hand-roll the try/catch.
 *
 * Naming (`_shared`, underscore-prefixed) mirrors `src/app/admin/_data/`'s
 * convention for "not a route segment" — Next's router still treats a plain
 * `route.ts` file specially, but `_shared/guard.ts` exports no HTTP method
 * handler, so there is nothing for the router to mount here regardless.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { AuthError, requireOperator, toAuthErrorResponse } from '@/lib/auth/authorize';
import type { Identity } from '@/lib/auth/identity';
import type { TargetType } from '@/lib/audit';

export type OperatorGuardResult = { kind: 'ok'; identity: Identity } | { kind: 'denied'; response: NextResponse };

/**
 * `FR-ADM-1`: re-checks operator status for THIS request. Pass `target` when
 * the mutation names a specific domain object (a member, a title, a setting)
 * so a denied attempt's `access.denied` row records that object, not just
 * the bare route — matching `src/lib/auth/authorize.ts`'s
 * `AccessCheckContext.target` and `wiki/Feature-08-Audit-Log.md`'s
 * `access.denied` vocabulary row.
 */
export async function requireOperatorForRoute(req: NextRequest, target?: { type: TargetType; id: string }): Promise<OperatorGuardResult> {
  try {
    const identity = await requireOperator({ route: req.nextUrl.pathname, target, source: 'ui' });
    return { kind: 'ok', identity };
  } catch (err) {
    if (err instanceof AuthError) return { kind: 'denied', response: toAuthErrorResponse(err) };
    throw err;
  }
}

export type JsonBodyResult<T> = { kind: 'ok'; body: T } | { kind: 'invalid'; response: NextResponse };

/** Parses the request body as JSON; a malformed/missing body 400s rather than throwing an unhandled error out of the route handler. */
export async function readJsonBody<T = unknown>(req: NextRequest): Promise<JsonBodyResult<T>> {
  try {
    const body = (await req.json()) as T;
    return { kind: 'ok', body };
  } catch {
    return { kind: 'invalid', response: NextResponse.json({ error: 'invalid json body' }, { status: 400 }) };
  }
}
