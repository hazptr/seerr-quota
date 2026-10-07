/**
 * Shared types for the enforcement engine (P2-6, `wiki/Feature-05-Enforcement.md`).
 * Kept separate from `./decide.ts` only so the impure shell (`./process.ts`,
 * `./poller.ts`) can import just the shapes without pulling in the decision
 * algorithm — same split `src/lib/attribution/types.ts` uses for the same
 * reason.
 */
import type { EffectiveQuota } from '@/lib/members/quota';

/** Matches `request_decision.decision`'s enum in `src/lib/db/schema.ts` exactly (`D-4a`). */
export type EnforcementDecision = 'approve' | 'hold' | 'decline' | 'skip';

/**
 * Matches `request_decision.reason`'s enum in `src/lib/db/schema.ts` exactly.
 * Always the TRUE reason for the verdict, whether or not it was actually
 * applied (`FR-ENF-5`) — `enforcement_disabled` was removed from this enum;
 * see `Decision.enforced` below for how "shadow verdict" is now recorded.
 * The four fail-open causes (`FR-ENF-4`) are deliberately distinct values,
 * never collapsed: the operator's response to "you never configured a
 * default quota" (`quota_unconfigured`) is nothing like their response to
 * "this member isn't linked yet" (`member_not_matched`).
 */
export type EnforcementReason =
  | 'under_quota'
  | 'over_quota'
  | 'operator_exempt'
  | 'hold_expired'
  /** No `member` row at all for this request's requester (`FR-ENF-10`). */
  | 'unknown_member'
  /** A `member` row exists but `sync_status` isn't `matched` — `ambiguous` / `no_seerr_account` / `not_entitled`. */
  | 'member_not_matched'
  /** `FR-POL-2a` — an absence of a quota decision, NOT unlimited. */
  | 'quota_unconfigured'
  /** Attribution could not compute a usage figure this cycle. */
  | 'usage_unavailable'
  | 'stale_snapshot';

/** Matches `request_decision.source`'s enum in `src/lib/db/schema.ts` exactly. */
export type EnforcementSource = 'webhook' | 'poller' | 'manual';

/** Matches `member.sync_status`'s enum in `src/lib/db/schema.ts` exactly (`ExistingMemberSnapshot`/`ClassifiedMember` in `src/lib/members/types.ts` — not re-exported from there to keep this module's only dependency on `src/lib/members/**` the read-only `EffectiveQuota` type). */
export type MemberSyncStatus = 'matched' | 'no_seerr_account' | 'not_entitled' | 'ambiguous';

/**
 * `FR-ENF-1`'s pure-function inputs, named to match the spec's own list
 * verbatim: "(usage_bytes, effective quota, grace_bytes, enforcement_enabled,
 * member state, snapshot age, hold age)". `quota` is already resolved to an
 * `EffectiveQuota` (`src/lib/members/quota.ts`'s `resolveEffectiveQuota`) by
 * the caller — `decide()` stays pure either way (that resolver is itself pure,
 * no I/O), but reusing the shared type here is what makes "use it" (this
 * task's brief) actually true rather than a second parallel three-state enum.
 */
export interface DecisionInput {
  /** `FR-ENF-5` — the master switch. Ships `false`. */
  enforcementEnabled: boolean;
  /** `FR-ENF-10` — no `member` row at all for this request's requester. */
  memberRecognized: boolean;
  /** `null` iff `!memberRecognized`. `'matched'` is the only status enforcement can act on beyond the operator fast path; every other value is fail-open (`FR-ENF-4`). */
  memberSyncStatus: MemberSyncStatus | null;
  /** `FR-ENF-6` — the operator is exempt regardless of quota state. */
  isOperator: boolean;
  /** `FR-POL-2a`'s three-state resolution — never a bare `number | null`. */
  quota: EffectiveQuota;
  /** Current attributed usage for this member (`SUM(claim.charged_bytes)`), or `null` if it could not be computed this cycle (`FR-ENF-4`). */
  usageBytes: number | null;
  /** `GRACE_BYTES` — allowance above quota before holding (`FR-POL-8`). */
  graceBytes: number;
  /** Age, in seconds, of the attribution snapshot this evaluation is based on. `null` if no snapshot exists yet at all. */
  snapshotAgeS: number | null;
  /** `STALE_SNAPSHOT_MAX_AGE_S` — older than this, `snapshotAgeS` fails the freshness check (`FR-ENF-4`). */
  staleSnapshotMaxAgeS: number;
  /** Whether THIS request's most recent recorded decision (if any) was `hold` — gates the hold-age-out check; a request can only age out of a hold it is actually in. */
  isAlreadyHeld: boolean;
  /** Seconds since the hold began (`request_decision.held_since`). `null` unless `isAlreadyHeld`. */
  holdAgeS: number | null;
  /** `HOLD_MAX_DAYS` — `0` = never age out (`FR-ENF-12`). */
  holdMaxDays: number;
}

export interface Decision {
  decision: EnforcementDecision;
  reason: EnforcementReason;
  /**
   * `false` when `enforcementEnabled` was off at decision time — this row is
   * a shadow verdict (no Seerr call, no notification), and `decision`/`reason`
   * still carry the TRUE verdict so the operator can see "would have held
   * (over quota)" rather than just "would have held" (`FR-ENF-5`). Set
   * uniformly from `input.enforcementEnabled` regardless of which decision
   * was reached — including `skip`, whose real-world action is "nothing"
   * either way, but the column's own meaning ("was enforcement on at
   * decision time") is still a true, useful fact to record for every row.
   */
  enforced: boolean;
}
