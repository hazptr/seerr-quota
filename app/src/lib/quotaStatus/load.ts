/**
 * The impure shell behind `GET /api/quota-status` (P2-10, `FR-BAN-11`):
 * "MUST be cheap ... served from the last attribution snapshot, no upstream
 * calls, no recomputation. It is hit on every Seerr page load by every
 * user." Three tiny, indexed reads against tables the reconciler already
 * maintains — no Seerr/Radarr/Sonarr/Jellyfin/Authentik call, and no
 * re-running of `@/lib/attribution/compute.ts`'s attribution algorithm:
 *
 *   - `usageBytes`  — `SUM(claim.charged_bytes)` over this member's own
 *     ACTIVE claims (`claim_sso_active_idx` on `(sso_username, active)`
 *     covers it directly) — the exact figure
 *     `src/app/_data/memberDashboard.ts`'s `loadMemberDashboard` already
 *     derives for the full member view, computed here with one aggregate
 *     query instead of pulling every claim row.
 *   - `heldRequests` — `COUNT(*)` over `request_decision` rows for this
 *     member with `decision = 'hold'`. `request_decision.seerr_request_id`
 *     is upserted per request (`src/lib/enforcement/requestDecisionStore.ts`'s
 *     header comment), so this is "held RIGHT NOW," not "held at some point"
 *     — a request that later gets age-out declined or operator-approved no
 *     longer counts.
 *   - `quotaBytes` — the member's `quota_policy` row, or its absence
 *     (`@/lib/members/quota`'s `resolveEffectiveQuota` turns the raw
 *     `quota_bytes` into the three `FR-POL-2a` states).
 *
 * Deliberately does NOT gate on "has an attribution sync ever completed"
 * the way `loadMemberDashboard` does (its `no_snapshot` case) — a
 * documented, non-silent scoping choice: before any attribution has ever
 * run, `claim` is empty, so `usageBytes` reads `0` and — absent an
 * `unconfigured`/held override — the derived state is `ok`, which renders
 * NO banner (`FR-BAN-4`). That is the safe default direction for this
 * specific endpoint (never a false "you're over quota" from stale/missing
 * data), unlike the full dashboard, where a bare `0` could be misread as a
 * real measurement worth digging into. A `hold` row cannot exist without at
 * least one prior attribution computation (enforcement's `over_quota`
 * verdict is itself computed from an attribution snapshot), so `held_only`
 * is unaffected by this scoping choice either.
 *
 * Does NOT check `getMemberGate` (`@/lib/auth/memberGate.ts`) either — an
 * authenticated member with no/unmatched `member` row simply has no
 * `quota_policy` row to find, which resolves to `unconfigured` (renders
 * nothing) by the same construction, so the extra read would cost a query
 * without changing the outcome.
 */
import { and, eq, sql } from 'drizzle-orm';
import { getConfig } from '@/lib/config';
import { getDb, type SeerrQuotaDb } from '@/lib/db';
import { claim, quotaPolicy, requestDecision } from '@/lib/db/schema';
import { resolveEffectiveQuota } from '@/lib/members/quota';
import { getGlobalDefaultQuotaBytes } from '@/lib/quota/policy';
import { deriveQuotaStatus, type QuotaStatusPayload } from './derive';

function loadUsageBytes(db: SeerrQuotaDb, ssoUsername: string): number {
  const row = db
    .select({ total: sql<number>`coalesce(sum(${claim.chargedBytes}), 0)` })
    .from(claim)
    .where(and(eq(claim.ssoUsername, ssoUsername), eq(claim.active, true)))
    .get();
  return Number(row?.total ?? 0);
}

function loadHeldRequestCount(db: SeerrQuotaDb, ssoUsername: string): number {
  const row = db
    .select({ total: sql<number>`count(*)` })
    .from(requestDecision)
    .where(and(eq(requestDecision.ssoUsername, ssoUsername), eq(requestDecision.decision, 'hold')))
    .get();
  return Number(row?.total ?? 0);
}

/** Loads exactly `ssoUsername`'s own figures (`FR-BAN-3`) — every query below is filtered on this one caller-supplied username, never any other. */
export function loadQuotaStatus(ssoUsername: string): QuotaStatusPayload {
  const db = getDb();

  const usageBytes = loadUsageBytes(db, ssoUsername);
  const heldRequests = loadHeldRequestCount(db, ssoUsername);
  const quotaRow = db.select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, ssoUsername)).get();
  // `FR-POL-2a`: resolved at read time from BOTH the member's stored
  // override and the CURRENT global default — never a bare
  // `resolveEffectiveQuota(quotaRow?.quotaBytes ?? null)`.
  const effective = resolveEffectiveQuota(quotaRow?.quotaBytes ?? null, getGlobalDefaultQuotaBytes(db));

  // `FR-BAN-6` — this app's own public URL, a config concern (it ends up in
  // Seerr's chrome), never hardcoded.
  return deriveQuotaStatus(effective, usageBytes, heldRequests, getConfig().upstreams.appUrl);
}
