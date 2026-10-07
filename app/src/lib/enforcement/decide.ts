/**
 * The pure enforcement decision core (`FR-ENF-1`, `D-4a`, AGENTS.md rule 9:
 * "pure core, impure shell" — the other function this rule calls out by
 * name, alongside the attribution split). No I/O, no `Date.now()`, no DB —
 * every input is plain data (`./types.ts`'s `DecisionInput`), so every
 * scenario in `test/enforcement-decide.test.ts` is hand-calculated. Both the
 * webhook route and the poller call THIS function over the same snapshot, so
 * they cannot disagree (`FR-ENF-7`) — see `./process.ts` for the one shared
 * caller both paths actually go through.
 *
 * ## Priority order
 *
 * 1. **Unrecognised member** (`FR-ENF-10`) — no `member` row for this
 *    request's requester at all → `skip` / `unknown_member`.
 * 2. **Operator exemption** (`FR-ENF-6`) — checked before any data-quality
 *    gate below, because it doesn't depend on quota data being fresh or
 *    even present: an operator's own usage/quota state is never consulted,
 *    so a stale snapshot or unresolved quota must not block it either →
 *    `approve` / `operator_exempt`.
 * 3. **Non-`matched` sync status** (`ambiguous` / `no_seerr_account` /
 *    `not_entitled`) — `FR-ENF-4` fail-open → `skip` / `member_not_matched`,
 *    a distinct reason from `unknown_member` (a `member` row exists here,
 *    it's just not cleanly linked — the operator's remedy is different).
 * 4. **Usage uncomputable** (`usageBytes === null`) — `FR-ENF-4` → `skip` /
 *    `usage_unavailable`.
 * 5. **Stale snapshot** (`FR-ENF-4`) — `snapshotAgeS === null` (no snapshot
 *    yet) or older than `staleSnapshotMaxAgeS` → `skip` / `stale_snapshot`.
 * 6. **Quota resolution** (`FR-POL-2a`, three states — never a bare
 *    `number | null`):
 *    - `unconfigured` ("nobody has decided yet") → `skip` /
 *      `quota_unconfigured`. `FR-POL-2a` is explicit: an absence of a quota
 *      decision is NOT unlimited and MUST NOT silently approve.
 *    - `unlimited` → `approve` / `under_quota` (trivially never over; no
 *      dedicated "unlimited" reason value exists, and `under_quota`
 *      captures the practical meaning — "not over quota" — exactly).
 *    - `limited`: `usageBytes > bytes + graceBytes` → over quota, else not.
 *      **`>` not `>=`** (`FR-ENF-2`, the edge-case note in
 *      wiki/Feature-05-Enforcement.md: "Exactly at your limit approves;
 *      exceeding it holds").
 *      - Not over → `approve` / `under_quota`. This is the SELF-HEAL path
 *        (`D-4a`) and fires regardless of `isAlreadyHeld`/`holdAgeS` — a
 *        member who freed space is un-held immediately, never blocked by
 *        how long they were held.
 *      - Over, and NOT already held, or already held but not yet past
 *        `holdMaxDays` (`0` = never) → `hold` / `over_quota`. The normal
 *        over-quota outcome: left pending, zero Seerr writes.
 *      - Over, already held, and `holdAgeS` has passed `holdMaxDays` →
 *        `decline` / `hold_expired` (`FR-ENF-12`) — the ONLY automated
 *        decline path; the age-out check is nested inside "still over
 *        quota" specifically so a request cannot decline in the same
 *        evaluation it would otherwise have self-healed out of.
 *
 * ## `enforced` — shadow mode, without losing the reason (`FR-ENF-5`)
 *
 * `enforcement_enabled` is a first-class INPUT (see `./types.ts`'s
 * `DecisionInput` doc comment quoting `FR-ENF-1` verbatim), but it no longer
 * mutates `reason`. Every branch below returns the TRUE reason regardless of
 * the toggle; `enforced: input.enforcementEnabled` is set uniformly on every
 * returned `Decision` (including `skip`) and is what `./process.ts` reads to
 * decide whether to actually call Seerr/notify. This was previously an
 * `enforcement_disabled` override baked into `reason` itself — reverted
 * because it threw away exactly the information shadow mode exists to show
 * ("would have held (over quota)", not just "would have held").
 */
import type { EffectiveQuota } from '@/lib/members/quota';
import type { Decision, DecisionInput, EnforcementReason } from './types';

const SECONDS_PER_DAY = 86_400;

function decideForResolvedQuota(input: DecisionInput, quota: Extract<EffectiveQuota, { kind: 'limited' }>): { decision: Decision['decision']; reason: EnforcementReason } {
  const overQuota = (input.usageBytes as number) > quota.bytes + input.graceBytes;

  if (!overQuota) {
    // Self-heal (`D-4a`): freed space un-holds immediately, regardless of
    // how long — or whether — this request was previously held.
    return { decision: 'approve', reason: 'under_quota' };
  }

  const holdExpired =
    input.isAlreadyHeld &&
    input.holdMaxDays > 0 &&
    input.holdAgeS !== null &&
    input.holdAgeS >= input.holdMaxDays * SECONDS_PER_DAY;

  if (holdExpired) {
    return { decision: 'decline', reason: 'hold_expired' };
  }

  return { decision: 'hold', reason: 'over_quota' };
}

function withEnforced(input: DecisionInput, verdict: { decision: Decision['decision']; reason: EnforcementReason }): Decision {
  return { ...verdict, enforced: input.enforcementEnabled };
}

/** `FR-ENF-1`. See this file's header comment for the full priority order and the `enforced` design note. */
export function decide(input: DecisionInput): Decision {
  // 1. FR-ENF-10 — no member row at all.
  if (!input.memberRecognized) {
    return withEnforced(input, { decision: 'skip', reason: 'unknown_member' });
  }

  // 2. FR-ENF-6 — operator exemption, checked before any data-quality gate.
  if (input.isOperator) {
    return withEnforced(input, { decision: 'approve', reason: 'operator_exempt' });
  }

  // 3. FR-ENF-4 — a member row exists but isn't a clean `matched` account link.
  if (input.memberSyncStatus !== 'matched') {
    return withEnforced(input, { decision: 'skip', reason: 'member_not_matched' });
  }

  // 4. FR-ENF-4 — usage genuinely could not be computed this cycle.
  if (input.usageBytes === null) {
    return withEnforced(input, { decision: 'skip', reason: 'usage_unavailable' });
  }

  // 5. FR-ENF-4 — no snapshot, or one older than STALE_SNAPSHOT_MAX_AGE.
  if (input.snapshotAgeS === null || input.snapshotAgeS > input.staleSnapshotMaxAgeS) {
    return withEnforced(input, { decision: 'skip', reason: 'stale_snapshot' });
  }

  // 6. FR-POL-2a — three-state quota resolution.
  if (input.quota.kind === 'unconfigured') {
    return withEnforced(input, { decision: 'skip', reason: 'quota_unconfigured' });
  }
  if (input.quota.kind === 'unlimited') {
    return withEnforced(input, { decision: 'approve', reason: 'under_quota' });
  }
  return withEnforced(input, decideForResolvedQuota(input, input.quota));
}
