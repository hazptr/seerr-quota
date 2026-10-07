/**
 * Server-side role enforcement (FR-SSO-5): "Every operator-only route (quota
 * edits, protect/unprotect, fleet views, other members' data, audit export)
 * MUST re-check the role server-side on each request and return 403 for
 * members. Hiding a control in the UI is not authorization."
 *
 * `requireOperator` is deliberately shaped to be hard to forget: it RETURNS
 * the authorized `Identity` on success and THROWS `AuthError` on failure,
 * rather than returning a boolean (or a boolean-shaped union) a caller could
 * silently ignore —
 *
 *   const identity = await requireOperator({ route: '/api/admin/quota' });
 *   // unreachable past this line unless `identity` is a real operator —
 *   // there is no code path that "forgets" to check a return value, because
 *   // there's nothing to check: either you have the Identity, or execution
 *   // never got here.
 *
 * A route handler that doesn't want a 500 on a thrown `AuthError` catches it
 * and converts via `toAuthErrorResponse` — see that function's doc comment.
 *
 * Every 403 this throws (a resolved, non-operator identity hitting an
 * operator-only check) writes an `access.denied` audit row FIRST, before
 * throwing — so a caller can never observe the 403 without the row already
 * being durably written (FR-AUD-4, FR-AUD-8's spirit: the audit write is not
 * something a route can race past).
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { newCorrelationId, writeAuditRow, type Source, type TargetType } from '@/lib/audit';
import { getIdentity } from './session';
import type { Identity } from './identity';

export class AuthError extends Error {
  readonly status: 401 | 403;

  constructor(status: 401 | 403, message: string) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

export interface AccessCheckContext {
  /** The route being guarded, e.g. `req.nextUrl.pathname` — recorded as `access.denied`'s `target_id` unless `target` below names something more specific. */
  route: string;
  /**
   * Set when the attempt named a specific domain object (e.g. another
   * member's id, a specific title) rather than just hitting an operator-only
   * route in general — per wiki/Feature-08-Audit-Log.md's `access.denied`
   * vocabulary-table row: "Target: route (or the domain type, when the
   * attempt named one)".
   */
  target?: { type: TargetType; id: string };
  /** Audit `source`; defaults to `'ui'`. */
  source?: Source;
  /** Extra detail merged into the audit row; defaults to `{ attemptedRoute: route }`. */
  detail?: unknown;
}

/**
 * Resolves the current request's `Identity`, throwing `AuthError(401)` if
 * `Remote-User` didn't resolve. Normally unreachable for any route
 * `src/middleware.ts`'s matcher covers (it already 401'd first) — this is
 * the defensive fallback for that otherwise-unreachable case, kept so a
 * Route Handler is never one refactor away from skipping the gate.
 */
export async function requireIdentity(): Promise<Identity> {
  const identity = await getIdentity();
  if (!identity) {
    throw new AuthError(
      401,
      'unauthorized: no identity resolved (Remote-User missing) — unreachable in normal operation, src/middleware.ts already gates every route its matcher covers before a Route Handler or Server Component runs',
    );
  }
  return identity;
}

/**
 * FR-SSO-5's operator guard. Returns the operator's `Identity` on success.
 * Throws `AuthError(401)` if there's no identity at all (see
 * `requireIdentity`), or `AuthError(403)` — after writing an `access.denied`
 * audit row — if the resolved identity is a member, not an operator.
 */
export async function requireOperator(ctx: AccessCheckContext): Promise<Identity> {
  const identity = await requireIdentity();
  if (!identity.isOperator) {
    recordAccessDenied(identity, ctx);
    throw new AuthError(403, `forbidden: operator-only route (${ctx.route})`);
  }
  return identity;
}

function recordAccessDenied(identity: Identity, ctx: AccessCheckContext): void {
  const db = getDb();
  writeAuditRow(db, {
    actor: identity.username,
    actorRole: 'member',
    action: 'access.denied',
    // KNOWN SPEC/CODE GAP (flagged, not silently worked around) —
    // wiki/Feature-08-Audit-Log.md's `access.denied` vocabulary-table row
    // says Target = "route (or the domain type, when the attempt named
    // one)", and `src/lib/db/schema.ts`'s `audit.target_type` SQLite column
    // enum literally includes `'route'`. But `src/lib/audit/actions.ts`'s
    // `route` when the denied attempt named no domain object (just a URL),
    // otherwise the domain type the caller supplied.
    targetType: ctx.target?.type ?? 'route',
    targetId: ctx.target?.id ?? ctx.route,
    outcome: 'denied',
    source: ctx.source ?? 'ui',
    correlationId: newCorrelationId(),
    detail: ctx.detail ?? { attemptedRoute: ctx.route },
  });
}

/**
 * Converts an `AuthError` into the matching `NextResponse` (401/403, a
 * generic non-secret-leaking JSON body). Route handlers that call
 * `requireOperator`/`requireIdentity` should catch and return this:
 *
 *   try {
 *     const identity = await requireOperator({ route: req.nextUrl.pathname });
 *     ...
 *   } catch (err) {
 *     return toAuthErrorResponse(err);
 *   }
 *
 * Rethrows anything that isn't an `AuthError` — this function only knows how
 * to translate the error shape it itself defines, never swallows an
 * unrelated failure.
 */
export function toAuthErrorResponse(err: unknown): NextResponse {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.status === 401 ? 'unauthorized' : 'forbidden: operator only' }, { status: err.status });
  }
  throw err;
}
