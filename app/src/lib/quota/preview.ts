/**
 * `FR-POL-4`/`FR-POL-5` — the "what would this do" preview, as a PURE
 * function (AGENTS.md rule 9: "pure core, impure shell", the same
 * discipline `src/lib/enforcement/decide.ts` and `src/lib/attribution/
 * compute.ts` follow). No I/O, no `Date.now()`, no DB — every scenario is
 * hand-calculable, including against sample figures
 * (`test/quota-preview.test.ts`).
 *
 * Builds on `src/lib/members/quota.ts`'s `resolveEffectiveQuota` (imported,
 * never re-implemented — see this feature's task brief) for the three-state
 * distinction: `unconfigured`/`unlimited` are NEVER "over quota", no matter
 * how much a member has used (`FR-POL-2a`, and `src/lib/enforcement/
 * decide.ts`'s priority order, which this module's `isOverQuota` mirrors
 * exactly so the preview and the real enforcement decision can never
 * disagree about what "over" means).
 *
 * `./policy.ts` (the impure shell) is the only intended caller — it loads
 * usage/quota rows from the DB, calls the functions here, and is what
 * actually exposes this to an admin API route.
 */
import { resolveEffectiveQuota, type EffectiveQuota } from '@/lib/members/quota';

/**
 * `FR-ENF-2`/`src/lib/enforcement/decide.ts`: over quota is `usageBytes >
 * bytes + graceBytes` — strictly greater, and only for a `limited` quota.
 * `unconfigured` and `unlimited` are trivially never over, matching
 * `decide()`'s own priority order exactly (an unconfigured quota SKIPS
 * enforcement rather than being treated as a 0-byte limit).
 */
export function isOverQuota(usageBytes: number, quota: EffectiveQuota, graceBytes: number): boolean {
  if (quota.kind !== 'limited') return false;
  return usageBytes > quota.bytes + graceBytes;
}

/** How far `usageBytes` sits over `quota`'s limit+grace; `0` when not over (including the `unconfigured`/`unlimited` cases, which are never over). */
export function overageBytes(usageBytes: number, quota: EffectiveQuota, graceBytes: number): number {
  if (!isOverQuota(usageBytes, quota, graceBytes)) return 0;
  // isOverQuota only returns true for `kind === 'limited'`, so this cast is safe.
  const limited = quota as Extract<EffectiveQuota, { kind: 'limited' }>;
  return usageBytes - (limited.bytes + graceBytes);
}

export interface QuotaChangeEffect {
  ssoUsername: string;
  usageBytes: number;
  before: EffectiveQuota;
  after: EffectiveQuota;
  wasOver: boolean;
  isOver: boolean;
  /** `overageBytes(usageBytes, after, graceBytes)` — `0` unless `isOver`. */
  overageAfterBytes: number;
}

function evaluate(ssoUsername: string, usageBytes: number, before: EffectiveQuota, after: EffectiveQuota, graceBytes: number): QuotaChangeEffect {
  return {
    ssoUsername,
    usageBytes,
    before,
    after,
    wasOver: isOverQuota(usageBytes, before, graceBytes),
    isOver: isOverQuota(usageBytes, after, graceBytes),
    overageAfterBytes: overageBytes(usageBytes, after, graceBytes),
  };
}

// ---------------------------------------------------------------------------
// FR-POL-4, default-change preview: "which members would newly be over or
// newly under."
// ---------------------------------------------------------------------------

export interface DefaultChangePreviewMember {
  ssoUsername: string;
  usageBytes: number;
  /** This member's CURRENT effective quota — `resolveEffectiveQuota(quota_policy.quota_bytes, <current default>)`. */
  currentEffective: EffectiveQuota;
  /**
   * `quota_policy.source` for this member. An `'override'` member is
   * UNAFFECTED by a default change by definition — their override
   * supersedes the default (`FR-POL-2`) — so their `after` is always equal
   * to `before` and they can never appear in `newlyOver`/`newlyUnder`.
   */
  source: 'default' | 'override';
}

export interface DefaultChangePreview {
  /** Was NOT over before, IS over after — `FR-POL-4`'s headline list, sorted worst-overage-first. */
  newlyOver: QuotaChangeEffect[];
  /** WAS over before, is NOT over after — the self-heal side of the same edit. */
  newlyUnder: QuotaChangeEffect[];
  /** Every `source: 'default'` member's effect (over or not) — for a full before/after table, not just the two headline lists. */
  allAffected: QuotaChangeEffect[];
  /** Count of `source: 'override'` members passed in — included so a caller can show "N members are on a custom override and unaffected by this change" without re-deriving it. */
  unaffectedOverrideCount: number;
}

/**
 * `FR-POL-4`: "for a default change, which members would newly be over or
 * newly under." `members` should be every member the caller cares about
 * (typically the whole fleet); `source: 'override'` rows pass through
 * unaffected and are counted, never evaluated for over/under.
 */
export function previewDefaultChange(
  members: readonly DefaultChangePreviewMember[],
  proposedDefaultBytes: number,
  graceBytes: number,
): DefaultChangePreview {
  // Every member evaluated here is `source: 'default'` (override rows are
  // filtered out below before this is used) — so their override is `null`,
  // and the proposed default is what they'd resolve to.
  const proposedEffective = resolveEffectiveQuota(null, proposedDefaultBytes);

  const allAffected: QuotaChangeEffect[] = [];
  let unaffectedOverrideCount = 0;

  for (const m of members) {
    if (m.source === 'override') {
      unaffectedOverrideCount += 1;
      continue;
    }
    allAffected.push(evaluate(m.ssoUsername, m.usageBytes, m.currentEffective, proposedEffective, graceBytes));
  }

  const newlyOver = allAffected
    .filter((e) => !e.wasOver && e.isOver)
    .sort((a, b) => b.overageAfterBytes - a.overageAfterBytes);
  const newlyUnder = allAffected.filter((e) => e.wasOver && !e.isOver);

  return { newlyOver, newlyUnder, allAffected, unaffectedOverrideCount };
}

// ---------------------------------------------------------------------------
// FR-POL-4 (override half) + FR-POL-5: single-member preview, for both
// "setting an override" and "clearing an override" (reverting to whatever
// the current default resolves to).
// ---------------------------------------------------------------------------

export interface MemberQuotaChangePreview extends QuotaChangeEffect {
  /**
   * `FR-POL-5`: "MUST require an explicit confirmation that states how far
   * over it puts them and that it will block their next request." `true`
   * exactly when `isOver` — the caller (an admin API route/UI, not this
   * module: "the confirmation UI is someone else's job") uses this to
   * decide whether to show the confirmation step at all.
   */
  requiresConfirmation: boolean;
}

function withConfirmation(effect: QuotaChangeEffect): MemberQuotaChangePreview {
  return { ...effect, requiresConfirmation: effect.isOver };
}

/**
 * Preview for setting a concrete per-member override (`FR-POL-2`: overrides
 * are always a decided value — `0` for unlimited, or a positive byte count —
 * never `null`; "clear" is a different operation, `previewClearOverride`
 * below).
 */
export function previewOverrideChange(input: {
  ssoUsername: string;
  usageBytes: number;
  currentEffective: EffectiveQuota;
  proposedOverrideBytes: number;
  graceBytes: number;
}): MemberQuotaChangePreview {
  // `proposedOverrideBytes` is always a decided value (FR-POL-2: never
  // `null` — clearing is a separate operation below), so the default is
  // irrelevant to this resolution: `resolveEffectiveQuota`'s override branch
  // short-circuits before it would ever consult it.
  const after = resolveEffectiveQuota(input.proposedOverrideBytes, null);
  return withConfirmation(evaluate(input.ssoUsername, input.usageBytes, input.currentEffective, after, input.graceBytes));
}

/**
 * Preview for clearing a per-member override — `FR-POL-2`: reverting to
 * "inherit the default" means resolving to whatever `default_quota_bytes`
 * currently is (possibly itself `null`/unconfigured, if no global default
 * has ever been set).
 */
export function previewClearOverride(input: {
  ssoUsername: string;
  usageBytes: number;
  currentEffective: EffectiveQuota;
  currentDefaultQuotaBytes: number | null;
  graceBytes: number;
}): MemberQuotaChangePreview {
  // Clearing means the override becomes `null` — the effective quota is
  // whatever the CURRENT default resolves to (possibly itself unconfigured).
  const after = resolveEffectiveQuota(null, input.currentDefaultQuotaBytes);
  return withConfirmation(evaluate(input.ssoUsername, input.usageBytes, input.currentEffective, after, input.graceBytes));
}
