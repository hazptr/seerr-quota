/**
 * `FR-POL-2`/`FR-POL-2a`/`wiki/Data-Model.md` §`quota_policy`: effective-quota
 * resolution needs BOTH the member's stored override (`quota_policy.
 * quota_bytes`) and the current global default (`app_setting.
 * default_quota_bytes`) — a one-argument resolver cannot express the
 * difference between "inherit the default" and "no quota configured at all",
 * because both start from a bare `null` on the override column.
 *
 * `quota_policy.quota_bytes` carries three meanings on its OWN:
 *   - `null` — inherit whatever the global default currently resolves to.
 *     NEVER materialised — a member with no override stores `null` forever;
 *     raising `default_quota_bytes` applies to them immediately, with no
 *     write to this row and nothing to drift out of sync.
 *   - `0`    — "unlimited," a deliberate per-member operator decision.
 *   - N (>0) — the actual per-member byte limit.
 *
 * ...and the global default (`app_setting.default_quota_bytes`, itself
 * `number | null`) carries the same three-way split one level up:
 *   - `null` — nobody has decided a default yet.
 *   - `0`    — "unlimited" by default.
 *   - N (>0) — the default byte limit.
 *
 * Combined, per `wiki/Data-Model.md` §`quota_policy`'s inheritance table:
 *
 * | override | default | effective         |
 * |----------|---------|-------------------|
 * | `0`      | *any*   | unlimited         |
 * | `N`      | *any*   | limited `N`       |
 * | `null`   | `0`     | unlimited         |
 * | `null`   | `N`     | limited `N`       |
 * | `null`   | unset   | **unconfigured**  |
 *
 * A bare `number | null` (or worse, `quotaBytes || DEFAULT` / `if
 * (!quotaBytes)`) invites exactly the bug this module exists to prevent:
 * treating "unconfigured" and "unlimited" as the same falsy thing.
 * `resolveEffectiveQuota` gives the three RESULT states distinct names so a
 * caller — `src/lib/quota/policy.ts`, `src/lib/enforcement/process.ts`,
 * `src/lib/quotaStatus/load.ts`, the admin UI's data loaders — has to handle
 * "unconfigured" explicitly rather than being able to fall through into
 * treating it as a number.
 */

export type EffectiveQuota = { kind: 'unconfigured' } | { kind: 'unlimited' } | { kind: 'limited'; bytes: number };

/**
 * `overrideBytes` — the member's own `quota_policy.quota_bytes`, verbatim
 * (never pre-coerced). `defaultBytes` — the CURRENT `default_quota_bytes`
 * (`src/lib/quota/policy.ts`'s `getGlobalDefaultQuotaBytes`), read fresh at
 * call time — this is what makes inheritance "resolved at read time, never
 * materialised" (`FR-POL-2a`) actually true: raising the default changes
 * every caller's next resolution with no write anywhere.
 */
export function resolveEffectiveQuota(overrideBytes: number | null, defaultBytes: number | null): EffectiveQuota {
  if (overrideBytes !== null) {
    // A decided override always wins, regardless of the default — including
    // `0`, which means unlimited no matter what the default is.
    return overrideBytes === 0 ? { kind: 'unlimited' } : { kind: 'limited', bytes: overrideBytes };
  }
  if (defaultBytes === null) return { kind: 'unconfigured' };
  return defaultBytes === 0 ? { kind: 'unlimited' } : { kind: 'limited', bytes: defaultBytes };
}
