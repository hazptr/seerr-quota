/**
 * Domain types for account sync (`wiki/Feature-02-Account-Sync.md`,
 * `wiki/Data-Model.md` §member). Kept separate from `classify.ts` so
 * `src/lib/members/sync.ts` (the DB-touching shell) can import just the
 * shapes it needs without pulling in the classification algorithm.
 */

/** Matches `member.sync_status`'s enum in `src/lib/db/schema.ts` exactly. */
export type SyncStatus = 'matched' | 'no_seerr_account' | 'not_entitled' | 'ambiguous';

/**
 * A `member` row as it exists in the DB BEFORE this sync cycle runs —
 * `classifyMembers` (`./classify.ts`) is pure, so this is how it learns
 * "who did we already know about" (to carry forward `first_seen_at`, find
 * the existing row already linked to a given Seerr user id for key
 * stability, and detect a newly-lost Seerr account) without touching the
 * database itself.
 */
export interface ExistingMemberSnapshot {
  ssoUsername: string;
  /** DEPRECATED (0.2.0) — no longer written; carried forward as-is. See `src/lib/db/schema.ts`'s column comment. */
  authentikUuid: string | null;
  displayName: string | null;
  email: string | null;
  entitled: boolean;
  seerrUserId: number | null;
  jellyfinUserId: string | null;
  syncStatus: SyncStatus;
  syncNote: string | null;
  firstSeenAt: number;
  /** `ADMIN_USERS` (`FR-ENF-6`, background half — see `classify.ts`'s header comment). */
  isOperator: boolean;
}

/**
 * The desired-state row `classifyMembers` computes for one member this
 * cycle — everything `src/lib/members/sync.ts` needs to upsert `member`
 * (and, for a new row, seed `quota_policy`) without recomputing anything.
 */
export interface ClassifiedMember {
  ssoUsername: string;
  /** DEPRECATED (0.2.0) — never set for a new row; carried forward for an existing one. */
  authentikUuid: string | null;
  displayName: string | null;
  email: string | null;
  entitled: boolean;
  seerrUserId: number | null;
  jellyfinUserId: string | null;
  syncStatus: SyncStatus;
  /** Human-readable, non-null whenever `syncStatus !== 'matched'` (`FR-SYNC-4`). */
  syncNote: string | null;
  /** `true` iff this `ssoUsername` was absent from `existingMembers` going in — drives `member.created` vs `member.sync_changed`/`member.entitlement_changed` in the shell, and whether `quota_policy` needs seeding. */
  isNew: boolean;
  /** Carried forward from the existing row, or `nowSeconds` for a brand-new member — never re-derived once set (`member.first_seen_at` is written once). */
  firstSeenAt: number;
  /** `FR-ENF-6` (enforcement exemption). See `classify.ts`'s header comment for exactly how/when this is (re)computed vs. carried forward. */
  isOperator: boolean;
}
