/**
 * The pure core behind `GET /api/quota-status` (P2-10,
 * `wiki/Feature-10-In-Seerr-Banner.md`, `FR-BAN-3`/`FR-BAN-4`/`FR-BAN-5`).
 * No I/O, no `Date.now()` — plain data in, plain data out, so every state
 * transition is hand-calculable in `test/quota-status-derive.test.ts`
 * (AGENTS.md rule 9, pure core / impure shell). The impure shell that feeds
 * this from the DB is `./load.ts`.
 *
 * `FR-POL-2a`'s three quota states (`@/lib/members/quota`'s `EffectiveQuota`)
 * are collapsed here into the FOUR states the wiki's `GET /api/quota-status`
 * contract defines — `ok` / `over_quota` / `held_only` / `unconfigured` —
 * without ever conflating "unconfigured" with either "unlimited" or a real
 * zero, the same discipline `EffectiveQuota` itself exists to enforce.
 *
 * ## State precedence — `wiki/Feature-10-In-Seerr-Banner.md`'s "Precedence"
 * block is the authority:
 *
 *   1. `over_quota` — usage exceeds a LIMITED effective quota right now.
 *      Can only be true when `effective.kind === 'limited'`: `unlimited`
 *      (`quotaBytes === 0`) can never be exceeded by construction.
 *   2. `held_only` — **any** held request, whatever the quota state —
 *      OUTRANKS `unconfigured`. Those holds are already visible to the
 *      member as "Pending" in Seerr, so saying nothing is the one outcome
 *      guaranteed to confuse them. This combination only arises if the
 *      global default is cleared after holds already exist (a hold can only
 *      ever have been recorded while a quota WAS configured —
 *      `request_decision.reason` for a hold is always `over_quota`, never
 *      `quota_unconfigured`) — rare, but exactly the case this feature
 *      exists to cover.
 *   3. `unconfigured` — the quota policy itself is undecided, and there is
 *      no held request to report either. Renders nothing (`FR-BAN-4`).
 *   4. `ok` — quota is configured (limited or unlimited) and there is
 *      nothing to report. Renders nothing (`FR-BAN-4`).
 *
 * `shortfallBytes` ("how much to free", `FR-BAN-5`) is `null` — never `0` —
 * whenever there is no LIMITED quota to measure a shortfall against
 * (`unconfigured`/`unlimited`), matching `FR-POL-2a`'s "absence is never
 * zero" rule; `0` would read as "you're exactly at the line," a real,
 * different fact. It's `Math.max(0, usage - quotaBytes)` for a limited
 * quota — `0` for `held_only` under a limited-but-currently-compliant
 * quota (there is genuinely nothing to free right now), the true shortfall
 * for `over_quota`.
 */
import type { EffectiveQuota } from '@/lib/members/quota';

export type QuotaStatusState = 'ok' | 'over_quota' | 'held_only' | 'unconfigured';

/** Exactly the shape `wiki/Feature-10-In-Seerr-Banner.md`'s "The app" section documents for `GET /api/quota-status`. */
export interface QuotaStatusPayload {
  state: QuotaStatusState;
  /** Always a real measurement (SUM of this member's own active claims) — never withheld even when the banner won't render. */
  usageBytes: number;
  /** `null` only when `state === 'unconfigured'`. `0` means unlimited (a real operator decision, never conflated with "undecided"). */
  quotaBytes: number | null;
  /** `null` whenever there is no limited quota to measure against; otherwise `>= 0` — see this file's header comment. */
  shortfallBytes: number | null;
  /** Count of this member's CURRENT `request_decision` rows with `decision = 'hold'` (upserted per request, so this is "held right now," not "held ever"). */
  heldRequests: number;
  /** `FR-BAN-6` — always the same constant link to the self-service app. */
  url: string;
}

/**
 * Pure derivation: `EffectiveQuota` (`@/lib/members/quota`'s
 * `resolveEffectiveQuota`) + this member's usage/held-request counts + the
 * (constant) self-service URL, in; the exact `QuotaStatusPayload` the route
 * serializes, out.
 */
export function deriveQuotaStatus(
  effective: EffectiveQuota,
  usageBytes: number,
  heldRequests: number,
  url: string,
): QuotaStatusPayload {
  const quotaBytes = effective.kind === 'unconfigured' ? null : effective.kind === 'unlimited' ? 0 : effective.bytes;
  const shortfallBytes = effective.kind === 'limited' ? Math.max(0, usageBytes - effective.bytes) : null;
  const overQuota = effective.kind === 'limited' && usageBytes > effective.bytes;

  // Precedence per this file's header comment / wiki/Feature-10's
  // "Precedence" block: over_quota, then held_only (outranks unconfigured),
  // then unconfigured, then ok.
  const state: QuotaStatusState = overQuota
    ? 'over_quota'
    : heldRequests > 0
      ? 'held_only'
      : effective.kind === 'unconfigured'
        ? 'unconfigured'
        : 'ok';

  return { state, usageBytes, quotaBytes, shortfallBytes, heldRequests, url };
}
