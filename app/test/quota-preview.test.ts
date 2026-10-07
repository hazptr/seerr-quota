import { describe, expect, it } from 'vitest';
import { resolveEffectiveQuota } from '@/lib/members/quota';
import {
  isOverQuota,
  overageBytes,
  previewClearOverride,
  previewDefaultChange,
  previewOverrideChange,
  type DefaultChangePreviewMember,
} from '@/lib/quota/preview';

// Synthetic per-member usage figures chosen to exercise the quota-sizing
// ladder at several thresholds
// (full-charge model — the current, D-3-reversed model this app actually
// uses; see wiki/Data-Model.md §claim). Every assertion below is
// hand-checkable against that table.
const DANA = 1_040_000_000_000;
const ADMIN = 580_000_000_000;
const ERIN = 450_000_000_000;
const FRANK = 390_000_000_000;
const CAROL = 170_000_000_000;

describe('isOverQuota / overageBytes — mirrors src/lib/enforcement/decide.ts exactly', () => {
  it('unconfigured is never over, no matter the usage', () => {
    expect(isOverQuota(999_999_999_999, { kind: 'unconfigured' }, 0)).toBe(false);
    expect(overageBytes(999_999_999_999, { kind: 'unconfigured' }, 0)).toBe(0);
  });

  it('unlimited is never over, no matter the usage', () => {
    expect(isOverQuota(999_999_999_999, { kind: 'unlimited' }, 0)).toBe(false);
  });

  it('limited: strictly greater than bytes+grace, matching FR-ENF-2 ("exactly at your limit approves")', () => {
    expect(isOverQuota(500, { kind: 'limited', bytes: 500 }, 0)).toBe(false); // exactly at limit
    expect(isOverQuota(501, { kind: 'limited', bytes: 500 }, 0)).toBe(true);
    expect(overageBytes(501, { kind: 'limited', bytes: 500 }, 0)).toBe(1);
  });

  it('grace_bytes extends the threshold', () => {
    expect(isOverQuota(520, { kind: 'limited', bytes: 500 }, 20)).toBe(false); // exactly at limit+grace
    expect(isOverQuota(521, { kind: 'limited', bytes: 500 }, 20)).toBe(true);
    expect(overageBytes(521, { kind: 'limited', bytes: 500 }, 20)).toBe(1);
  });
});

describe('previewDefaultChange — FR-POL-4, hand-calculated sample figures', () => {
  // Starting state: no default has ever been set (config.ts:
  // "DEFAULT_QUOTA_BYTES — no default"), so every member's CURRENT effective
  // quota is `unconfigured` — nobody is "over" today, by definition
  // (FR-POL-2a: an absence is never promoted to a limit).
  const membersUnconfigured: DefaultChangePreviewMember[] = [
    { ssoUsername: 'dana', usageBytes: DANA, currentEffective: resolveEffectiveQuota(null, null), source: 'default' },
    { ssoUsername: 'admin', usageBytes: ADMIN, currentEffective: resolveEffectiveQuota(null, null), source: 'default' },
    { ssoUsername: 'erin', usageBytes: ERIN, currentEffective: resolveEffectiveQuota(null, null), source: 'default' },
    { ssoUsername: 'frank', usageBytes: FRANK, currentEffective: resolveEffectiveQuota(null, null), source: 'default' },
    { ssoUsername: 'carol', usageBytes: CAROL, currentEffective: resolveEffectiveQuota(null, null), source: 'default' },
  ];

  it('a proposed 500 GB default identifies EXACTLY dana and admin as newly over', () => {
    const preview = previewDefaultChange(membersUnconfigured, 500_000_000_000, 0);

    const newlyOverNames = preview.newlyOver.map((e) => e.ssoUsername).sort();
    expect(newlyOverNames).toEqual(['admin', 'dana']);
    expect(preview.newlyUnder).toEqual([]);

    const danaEffect = preview.newlyOver.find((e) => e.ssoUsername === 'dana')!;
    // Hand-calculated: 1,040,000,000,000 - 500,000,000,000 = 540,000,000,000

    expect(danaEffect.overageAfterBytes).toBe(DANA - 500_000_000_000);
    expect(danaEffect.overageAfterBytes).toBe(540_000_000_000);

    const adminEffect = preview.newlyOver.find((e) => e.ssoUsername === 'admin')!;
    // Hand-calculated: 580,000,000,000 - 500,000,000,000 = 80,000,000,000

    expect(adminEffect.overageAfterBytes).toBe(ADMIN - 500_000_000_000);
    expect(adminEffect.overageAfterBytes).toBe(80_000_000_000);

    // erin/frank/carol are all comfortably under 500 GB and must not appear anywhere.
    expect(preview.allAffected.find((e) => e.ssoUsername === 'erin')!.isOver).toBe(false);
    expect(preview.allAffected.find((e) => e.ssoUsername === 'frank')!.isOver).toBe(false);
    expect(preview.allAffected.find((e) => e.ssoUsername === 'carol')!.isOver).toBe(false);
  });

  it('newlyOver is sorted worst-overage-first (dana before admin at 500 GB)', () => {
    const preview = previewDefaultChange(membersUnconfigured, 500_000_000_000, 0);
    expect(preview.newlyOver.map((e) => e.ssoUsername)).toEqual(['dana', 'admin']);
  });

  it('a proposed 300 GB default at a 300 GB default: dana, admin, erin, frank all newly over; carol never', () => {
    const preview = previewDefaultChange(membersUnconfigured, 300_000_000_000, 0);
    const newlyOverNames = preview.newlyOver.map((e) => e.ssoUsername).sort();
    expect(newlyOverNames).toEqual(['admin', 'dana', 'erin', 'frank']);
    expect(preview.newlyOver.find((e) => e.ssoUsername === 'erin')!.overageAfterBytes).toBe(ERIN - 300_000_000_000);
    expect(preview.newlyOver.find((e) => e.ssoUsername === 'frank')!.overageAfterBytes).toBe(FRANK - 300_000_000_000);
  });

  it('a proposed 1 TB default at a 1 TB default: only dana is over, by 40 GB', () => {
    const preview = previewDefaultChange(membersUnconfigured, 1_000_000_000_000, 0);
    expect(preview.newlyOver.map((e) => e.ssoUsername)).toEqual(['dana']);
    expect(preview.newlyOver[0].overageAfterBytes).toBe(DANA - 1_000_000_000_000);
    expect(preview.newlyOver[0].overageAfterBytes).toBe(40_000_000_000);
  });

  it('raising the default back OUT of over-quota range produces newlyUnder, not newlyOver — the self-heal direction, per the acceptance criterion "raises... rises"', () => {
    // Start everyone over at a tight 200 GB default, then raise to 500 GB.
    const membersAt200: DefaultChangePreviewMember[] = [
      { ssoUsername: 'dana', usageBytes: DANA, currentEffective: resolveEffectiveQuota(null, 200_000_000_000), source: 'default' },
      { ssoUsername: 'admin', usageBytes: ADMIN, currentEffective: resolveEffectiveQuota(null, 200_000_000_000), source: 'default' },
      { ssoUsername: 'erin', usageBytes: ERIN, currentEffective: resolveEffectiveQuota(null, 200_000_000_000), source: 'default' },
      { ssoUsername: 'frank', usageBytes: FRANK, currentEffective: resolveEffectiveQuota(null, 200_000_000_000), source: 'default' },
      { ssoUsername: 'carol', usageBytes: CAROL, currentEffective: resolveEffectiveQuota(null, 200_000_000_000), source: 'default' },
    ];
    const preview = previewDefaultChange(membersAt200, 500_000_000_000, 0);
    // erin (450) and frank (390) drop below 500 GB -> newly under.
    // dana (1040) and admin (580) remain over -> neither list (unchanged, still over).
    // carol was already under at 200 GB -> unaffected, in neither list.
    expect(preview.newlyUnder.map((e) => e.ssoUsername).sort()).toEqual(['erin', 'frank']);
    expect(preview.newlyOver).toEqual([]);
  });

  it('a member with an override is NEVER affected by a default change — before and after are identical, never appears in either list', () => {
    const members: DefaultChangePreviewMember[] = [
      ...membersUnconfigured,
      { ssoUsername: 'carol-override', usageBytes: 900_000_000_000, currentEffective: resolveEffectiveQuota(0, null), source: 'override' }, // unlimited override
    ];
    const preview = previewDefaultChange(members, 100_000_000_000, 0); // a tiny default that would otherwise catch everyone
    expect(preview.newlyOver.find((e) => e.ssoUsername === 'carol-override')).toBeUndefined();
    expect(preview.newlyUnder.find((e) => e.ssoUsername === 'carol-override')).toBeUndefined();
    expect(preview.allAffected.find((e) => e.ssoUsername === 'carol-override')).toBeUndefined();
    expect(preview.unaffectedOverrideCount).toBe(1);
  });

  it('a global default lowered below every member\'s usage puts everyone in newlyOver — the "will block everyone" edge case the spec calls unmissable', () => {
    const preview = previewDefaultChange(membersUnconfigured, 1, 0); // 1 byte — nobody clears this
    expect(preview.newlyOver.map((e) => e.ssoUsername).sort()).toEqual(['admin', 'carol', 'dana', 'erin', 'frank']);
  });
});

describe('previewOverrideChange — FR-POL-4 (override half) + FR-POL-5 (confirmation data)', () => {
  it('setting an override below current usage requires confirmation and states the exact overage', () => {
    // dana at 1040 GB usage, override set to 900 GB.
    const preview = previewOverrideChange({
      ssoUsername: 'dana',
      usageBytes: DANA,
      currentEffective: resolveEffectiveQuota(null, null),
      proposedOverrideBytes: 900_000_000_000,
      graceBytes: 0,
    });
    expect(preview.requiresConfirmation).toBe(true);
    expect(preview.isOver).toBe(true);
    expect(preview.overageAfterBytes).toBe(DANA - 900_000_000_000);
    expect(preview.overageAfterBytes).toBe(140_000_000_000);
  });

  it('setting an override above current usage never requires confirmation', () => {
    const preview = previewOverrideChange({
      ssoUsername: 'carol',
      usageBytes: CAROL,
      currentEffective: resolveEffectiveQuota(null, null),
      proposedOverrideBytes: 300_000_000_000,
      graceBytes: 0,
    });
    expect(preview.requiresConfirmation).toBe(false);
    expect(preview.overageAfterBytes).toBe(0);
  });

  it('override of 0 means unlimited — never requires confirmation regardless of usage', () => {
    const preview = previewOverrideChange({
      ssoUsername: 'dana',
      usageBytes: DANA,
      currentEffective: resolveEffectiveQuota(1_000_000_000_000, null),
      proposedOverrideBytes: 0,
      graceBytes: 0,
    });
    expect(preview.after).toEqual({ kind: 'unlimited' });
    expect(preview.requiresConfirmation).toBe(false);
  });

  it('a 1140 GB override for dana leaves her comfortably under, by exactly the 100 GB headroom', () => {
    const preview = previewOverrideChange({
      ssoUsername: 'dana',
      usageBytes: DANA,
      currentEffective: resolveEffectiveQuota(null, null),
      proposedOverrideBytes: 1_140_000_000_000,
      graceBytes: 0,
    });
    expect(preview.isOver).toBe(false);
    expect(preview.requiresConfirmation).toBe(false);
    // Headroom = 1140 GB - 1040 GB = 100 GB.
    expect(1_140_000_000_000 - DANA).toBe(100_000_000_000);
  });
});

describe('previewClearOverride — reverting to whatever the current global default resolves to', () => {
  it('clearing when a default IS configured resolves to that default, not to unconfigured', () => {
    const preview = previewClearOverride({
      ssoUsername: 'dana',
      usageBytes: DANA,
      currentEffective: resolveEffectiveQuota(1_150_000_000_000, null),
      currentDefaultQuotaBytes: 300_000_000_000,
      graceBytes: 0,
    });
    expect(preview.after).toEqual({ kind: 'limited', bytes: 300_000_000_000 });
    // 1040 GB usage against a 300 GB default -> now over.
    expect(preview.isOver).toBe(true);
    expect(preview.requiresConfirmation).toBe(true);
  });

  it('clearing when NO default has ever been set resolves to unconfigured, matching FR-POL-2a exactly (never silently promoted to 0/unlimited)', () => {
    const preview = previewClearOverride({
      ssoUsername: 'carol',
      usageBytes: CAROL,
      currentEffective: resolveEffectiveQuota(0, null),
      currentDefaultQuotaBytes: null,
      graceBytes: 0,
    });
    expect(preview.after).toEqual({ kind: 'unconfigured' });
    expect(preview.isOver).toBe(false); // unconfigured is never "over"
    expect(preview.requiresConfirmation).toBe(false);
  });
});
