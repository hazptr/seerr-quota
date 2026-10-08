/**
 * The audit action vocabulary — `wiki/Feature-08-Audit-Log.md` "Action
 * vocabulary" table, transcribed verbatim into a typed union. `audit.action`
 * is a plain `text` column in `src/lib/db/schema.ts` (no DB-level enum), so
 * this module is what actually stops a caller from inventing an action
 * string that isn't in the spec — a typo becomes a `tsc --noEmit` failure
 * instead of a row nobody can find later. See `test/audit-actions.test.ts`
 * for the compile-time proof (`@ts-expect-error` on an unknown action).
 */

/** Matches `audit.actor_role`'s enum in `src/lib/db/schema.ts` exactly. */
export type ActorRole = 'member' | 'operator' | 'system';

/** Matches `audit.outcome`'s enum in `src/lib/db/schema.ts` exactly. */
export type Outcome = 'ok' | 'denied' | 'error';

/** Matches `audit.source`'s enum in `src/lib/db/schema.ts` exactly. */
export type Source = 'ui' | 'webhook' | 'poller' | 'cron' | 'cli';

/** Matches `audit.target_type`'s enum in `src/lib/db/schema.ts` exactly. */
export type TargetType = 'member' | 'title' | 'request' | 'setting' | 'route';

/**
 * The 21 rows of the vocabulary table, one literal each. `title.protected` /
 * `title.unprotected` are two distinct actions (the table's `/`-joined cell
 * for one row).
 */
export type AuditAction =
  | 'member.created'
  | 'member.sync_changed'
  | 'member.entitlement_changed'
  /**
   * 0.2.0, `src/lib/auth/memberGate.ts`: the FIRST time a forward-auth login
   * username is resolved to an existing member via the email-header
   * fallback (no `sso_username` match), recording that username as the
   * member's `login_alias` so future logins resolve by alias directly.
   * `target_id` is the member's `sso_username`; `detail` carries the
   * resolved alias.
   */
  | 'member.alias_linked'
  /** Operator action: clears a member's `login_alias` (`POST /api/admin/members/clear-alias`). Re-linking an alias is a trust decision, so undoing one is explicit and audited, never automatic. */
  | 'member.alias_cleared'
  /**
   * The email-fallback resolution (`src/lib/auth/memberGate.ts`'s
   * `tryLinkByEmail`) refused to link because the target row already has an
   * alias, or is an operator/`ADMIN_USERS` row (never auto-linked). Written
   * at most once per (header username, member) pair — see that file's
   * dedup check — so a repeat visitor can't fill the log.
   */
  | 'member.alias_link_denied'
  | 'quota.set'
  | 'quota.cleared'
  | 'setting.changed'
  | 'enforcement.toggled'
  | 'request.approved'
  // `request.held` is the NORMAL over-quota outcome (D-4a): the request is left
  // pending and no Seerr call is made. `request.declined` is the exception —
  // an operator action, or the HOLD_MAX_DAYS age-out.
  | 'request.held'
  | 'request.declined'
  | 'request.notified'
  | 'request.skipped'
  | 'claim.released'
  | 'claim.reassigned'
  // P4-1 Wave 3: an operator's one-way series split decomposing an active
  // whole-series claim into one active claim per season — see
  // `src/lib/attribution/sync.ts`'s `splitSeriesClaims`. Distinct from
  // `claim.released`: the member is NOT releasing anything — they remain
  // fully attributed, just across N season claims instead of one.
  | 'claim.split'
  | 'title.protected'
  | 'title.unprotected'
  | 'delete.requested'
  /** A member confirmed a file deletion; nothing is destroyed yet (`FR-DEL-22`). Carries `scheduledFor`. */
  | 'delete.scheduled'
  /** A scheduled deletion was called off before it ran — by its owner, by the operator, or by `system` when an execution-time guard fired (`FR-DEL-24`/`FR-DEL-26`). */
  | 'delete.cancelled'
  | 'delete.executed'
  | 'delete.failed'
  | 'delete.blocked'
  | 'access.denied'
  | 'webhook.rejected'
  | 'sync.failed'
  /**
   * Second security review (PR #17), SHOULD-FIX 2: an operator explicitly
   * overrode `checkMassRevocationRisk`'s refusal for one sync cycle
   * (`src/lib/members/sync.ts`'s `syncMembers({ forceApply: true, ... })`,
   * `POST /api/admin/reconcile/force-members-sync`). No target — this
   * describes the OVERRIDE decision itself, not any one member.
   */
  | 'sync.forced'
  | 'invariant.violated';

/**
 * Every literal in `AuditAction`, for iteration (filters, docs, tests).
 * `satisfies readonly AuditAction[]` makes this array and the union type
 * fail to compile against each other if they ever drift apart.
 */
export const AUDIT_ACTIONS = [
  'member.created',
  'member.sync_changed',
  'member.entitlement_changed',
  'member.alias_linked',
  'member.alias_cleared',
  'member.alias_link_denied',
  'quota.set',
  'quota.cleared',
  'setting.changed',
  'enforcement.toggled',
  'request.approved',
  'request.held',
  'request.declined',
  'request.notified',
  'request.skipped',
  'claim.released',
  'claim.reassigned',
  'title.protected',
  'title.unprotected',
  'delete.requested',
  'delete.scheduled',
  'delete.cancelled',
  'delete.executed',
  'delete.failed',
  'delete.blocked',
  'access.denied',
  'webhook.rejected',
  'sync.failed',
  'sync.forced',
  'invariant.violated',
] as const satisfies readonly AuditAction[];

/**
 * Actions whose vocabulary-table "Target" column is `—` (no target at all):
 * `webhook.rejected` ("Bad/missing secret") and `sync.failed` ("Which step,
 * error"). Every other action names a member/title/request/setting and MUST
 * record `target_id` (FR-AUD-3). `access.denied` uses `target_type: 'route'`
 * when the denied attempt named no domain object (just a URL), or the domain
 * type when it did — so `writeAuditRow` (`./write.ts`) requires `targetId` for
 * it but does not force a specific `targetType`.
 */
const ACTIONS_WITHOUT_TARGET: ReadonlySet<AuditAction> = new Set(['webhook.rejected', 'sync.failed', 'sync.forced']);

export function requiresTarget(action: AuditAction): boolean {
  return !ACTIONS_WITHOUT_TARGET.has(action);
}
