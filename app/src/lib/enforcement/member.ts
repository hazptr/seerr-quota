/**
 * Read-only `member`/`quota_policy` lookups the decision pipeline
 * (`./process.ts`) needs, keyed off Seerr's own `requestedBy.id`
 * (`member.seerr_user_id`) — the same reliable, always-populated join key
 * `src/lib/attribution/resolveMembers.ts` uses and documents (unlike
 * `jellyfinUsername`, which can be `null`).
 */
import { eq } from 'drizzle-orm';
import type { SeerrQuotaDb } from '@/lib/db';
import { member, quotaPolicy } from '@/lib/db/schema';
import type { MemberSyncStatus } from './types';

export interface EnforcementMember {
  ssoUsername: string;
  isOperator: boolean;
  syncStatus: MemberSyncStatus;
}

/** `null` iff no `member` row's `seerr_user_id` matches — `FR-ENF-10`: "the app MUST NOT act on a request belonging to a member it does not recognise." */
export function findMemberBySeerrUserId(db: SeerrQuotaDb, seerrUserId: number): EnforcementMember | undefined {
  const row = db.select().from(member).where(eq(member.seerrUserId, seerrUserId)).get();
  if (!row) return undefined;
  return { ssoUsername: row.ssoUsername, isOperator: row.isOperator, syncStatus: row.syncStatus };
}

/**
 * The member's raw `quota_policy.quota_bytes` — `null` if unset OR if no
 * `quota_policy` row exists at all (a `member` row should always have one,
 * seeded by `src/lib/members/sync.ts`'s `ensureDefaultQuotaPolicy`, but a
 * missing row is treated identically to an explicit `null`). Feed straight
 * into `src/lib/members/quota.ts`'s `resolveEffectiveQuota` ALONGSIDE the
 * current global default (`src/lib/quota/policy.ts`'s
 * `getGlobalDefaultQuotaBytes`) — a `null` here does NOT by itself mean
 * `FR-POL-2a`'s "unconfigured"; it means "inherit the default," which only
 * resolves to unconfigured if the default is ALSO unset. Never compared or
 * branched on directly here.
 */
export function loadQuotaBytes(db: SeerrQuotaDb, ssoUsername: string): number | null {
  const row = db.select({ quotaBytes: quotaPolicy.quotaBytes }).from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, ssoUsername)).get();
  return row?.quotaBytes ?? null;
}
