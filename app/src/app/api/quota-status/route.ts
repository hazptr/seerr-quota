/**
 * `GET /api/quota-status` — P2-10 (`wiki/Feature-10-In-Seerr-Banner.md`,
 * `FR-BAN-2`/`FR-BAN-3`/`FR-BAN-11`). Reached ONLY via a reverse-proxy
 * vhost for Seerr proxying its own `/_quota-status` location to
 * this app's `/api/quota-status` (the wiki's "Interactions" nginx snippet,
 * `examples/seerr-banner.nginx.snippet` in this task) —
 * that location includes the same Authentik forward-auth block as every
 * other gated vhost in front of it and sets `Remote-User`/`Remote-Groups`
 * before proxying, so this route sees exactly the identity
 * `src/lib/auth/session.ts`'s `getIdentity()` always resolves from.
 *
 * `src/middleware.ts`'s matcher does not exempt this path, so in normal
 * operation a request with no/blank `Remote-User` already 401s before this
 * handler ever runs (`FR-BAN-3`: "MUST NOT be reachable without
 * Remote-User"). The explicit check below is the same defensive,
 * belt-and-suspenders pattern `src/lib/auth/authorize.ts`'s
 * `requireIdentity()` documents on itself ("unreachable in normal
 * operation") — this route reads `getIdentity()` directly rather than that
 * helper because `requireIdentity`'s only extra behavior (throwing, for
 * `requireOperator`'s benefit) isn't useful here: there is no
 * operator/member distinction on this endpoint, every authenticated caller
 * is asking for their OWN figures.
 *
 * `FR-BAN-11` — cheap, from the last attribution snapshot, no upstream
 * calls, no recomputation: `loadQuotaStatus` (`@/lib/quotaStatus/load.ts`)
 * is three small indexed reads against the reconciler's already-materialized
 * `claim`/`quota_policy`/`request_decision` tables. Nothing here calls
 * Seerr, Radarr, Sonarr, Jellyfin, or Authentik.
 */
import { NextResponse } from 'next/server';
import { getIdentity } from '@/lib/auth/session';
import { loadQuotaStatus } from '@/lib/quotaStatus/load';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const identity = await getIdentity();
  if (!identity) {
    // Defensive only — see this file's header comment. Reachable in
    // practice only if this route were ever hit around src/middleware.ts's
    // gate (e.g. a future exempt-matcher change), so it degrades to the
    // same 401 shape every other unauthenticated hit on this app gets,
    // never a 500 or a partial body.
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // FR-BAN-3: filtered on this caller's OWN identity only — loadQuotaStatus
  // takes no other input that could name a different member.
  const payload = loadQuotaStatus(identity.username);
  return NextResponse.json(payload, { status: 200 });
}
