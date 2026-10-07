import { describe, expect, it } from 'vitest';
import { toMemberSafeAuditRow, type AuditRowLike } from '@/lib/audit/memberSafe';

/**
 * `FR-AUD-10`'s "the careful part" (P2-7), proven directly: a real
 * `delete.blocked` row — shaped EXACTLY like `src/lib/deletion/execute.ts`
 * actually writes one (`detail.guards[].operatorDetail.playedBy` /
 * `operatorMessage`, both naming other members by username) — must not leak
 * either other member's username into `toMemberSafeAuditRow`'s output, at
 * ANY nesting depth. Recursively serializes the WHOLE returned object (not
 * just a couple of expected fields) so a leak hiding in a field this test
 * didn't think to check by name still fails it.
 */

function containsSubstringAnywhere(value: unknown, needle: string): boolean {
  if (typeof value === 'string') return value.includes(needle);
  if (Array.isArray(value)) return value.some((v) => containsSubstringAnywhere(v, needle));
  if (value !== null && typeof value === 'object') return Object.values(value).some((v) => containsSubstringAnywhere(v, needle));
  return false;
}

function baseRow(overrides: Partial<AuditRowLike>): AuditRowLike {
  return {
    id: 1,
    ts: 1_800_000_000_000,
    actor: 'dana',
    actorRole: 'member',
    onBehalfOf: null,
    action: 'delete.blocked',
    targetType: 'title',
    targetId: 'movie-1',
    before: null,
    after: null,
    outcome: 'denied',
    detail: null,
    source: 'ui',
    ...overrides,
  };
}

describe('toMemberSafeAuditRow — FR-DEL-4a x FR-AUD-10: delete.blocked never leaks another member', () => {
  const realShapeDetail = JSON.stringify({
    requestedMode: 'delete_files',
    reason: 'guard',
    protectedReason: undefined,
    guards: [
      {
        guardId: 'recently_played',
        operatorMessage: 'Played within the last 14 days by alice, bob.',
        operatorDetail: { lastPlayedAnyAt: 1_799_000_000, playedBy: ['alice', 'bob'] },
      },
    ],
  });

  const row = baseRow({ actor: 'dana', onBehalfOf: null, detail: realShapeDetail });
  const safe = toMemberSafeAuditRow(row, 'dana');
  const wholeResponseText = JSON.stringify(safe);

  it('never includes the other members usernames anywhere in the output, at any nesting depth', () => {
    expect(containsSubstringAnywhere(safe, 'alice')).toBe(false);
    expect(containsSubstringAnywhere(safe, 'bob')).toBe(false);
    expect(wholeResponseText).not.toContain('alice');
    expect(wholeResponseText).not.toContain('bob');
  });

  it('drops the guards array and operatorMessage/operatorDetail entirely, not just the usernames inside them', () => {
    expect(safe.detail).not.toHaveProperty('guards');
    expect(wholeResponseText).not.toContain('operatorMessage');
    expect(wholeResponseText).not.toContain('operatorDetail');
    expect(wholeResponseText).not.toContain('playedBy');
  });

  it('still allow-lists the safe reason field, so the member learns SOMETHING happened', () => {
    expect(safe.detail).toEqual({ reason: 'guard' });
  });

  it('also holds for the operator-acting-on-behalf-of variant (on_behalf_of set)', () => {
    const onBehalfRow = baseRow({ actor: 'admin', actorRole: 'operator', onBehalfOf: 'dana', detail: realShapeDetail });
    const safeOnBehalf = toMemberSafeAuditRow(onBehalfRow, 'dana');
    expect(JSON.stringify(safeOnBehalf)).not.toContain('alice');
    expect(JSON.stringify(safeOnBehalf)).not.toContain('bob');
    expect(safeOnBehalf.byOperator).toBe(true);
  });

  it('excludes protectedReason (operator free text) on the protected-title variant too', () => {
    const protectedDetail = JSON.stringify({ requestedMode: 'delete_files', reason: 'protected', protectedReason: 'keep — ask alice before touching this one' });
    const safeProtected = toMemberSafeAuditRow(baseRow({ detail: protectedDetail }), 'dana');
    expect(safeProtected.detail).toEqual({ reason: 'protected' });
    expect(JSON.stringify(safeProtected)).not.toContain('alice');
  });
});

describe('toMemberSafeAuditRow — deny-by-default for actions with no allow-list entry', () => {
  it('a system-actor action (e.g. member.created) yields empty before/after/detail even if it somehow matched scope', () => {
    const row = baseRow({
      action: 'member.created',
      actor: 'system',
      actorRole: 'system',
      before: null,
      after: JSON.stringify({ classification: 'matched', defaultQuotaBytes: 500_000_000_000 }),
      detail: JSON.stringify({ note: 'anything at all' }),
    });
    const safe = toMemberSafeAuditRow(row, 'dana');
    expect(safe.before).toEqual({});
    expect(safe.after).toEqual({});
    expect(safe.detail).toEqual({});
  });

  it('an unrecognised/future action string also yields empty fields, never throws', () => {
    const row = baseRow({ action: 'some.future.action', detail: JSON.stringify({ ssoUsername: 'alice', secretish: 'x' }) });
    const safe = toMemberSafeAuditRow(row, 'dana');
    expect(safe.detail).toEqual({});
  });
});

describe('toMemberSafeAuditRow — the operator viewing their OWN history: setting.changed default-quota variant', () => {
  it('newlyOver/newlyUnder (arrays of OTHER members usernames) never reach the operator-as-viewer output', () => {
    const detail = JSON.stringify({
      affectedMemberCount: 3,
      newlyOver: [{ ssoUsername: 'alice', usageBytes: 1, overageAfterBytes: 1 }],
      newlyUnder: ['bob'],
    });
    const row = baseRow({
      action: 'setting.changed',
      actor: 'admin',
      actorRole: 'operator',
      targetType: 'setting',
      targetId: 'default_quota_bytes',
      before: JSON.stringify({ defaultQuotaBytes: 500_000_000_000 }),
      after: JSON.stringify({ defaultQuotaBytes: 300_000_000_000, note: 'tightening' }),
      detail,
    });
    const safe = toMemberSafeAuditRow(row, 'admin');
    expect(JSON.stringify(safe)).not.toContain('alice');
    expect(JSON.stringify(safe)).not.toContain('bob');
    // `value` isn't present on this variant's before/after (it's `defaultQuotaBytes`,
    // not on the allow-list for setting.changed), so both come back empty —
    // sparse-but-safe, not a reconstruction of the quota-change detail.
    expect(safe.before).toEqual({});
    expect(safe.after).toEqual({});
    expect(safe.detail).toEqual({});
  });

  it('the plain-setting variant (grace_bytes etc) DOES show the scalar before/after value', () => {
    const row = baseRow({
      action: 'setting.changed',
      actor: 'admin',
      actorRole: 'operator',
      targetType: 'setting',
      targetId: 'grace_bytes',
      before: JSON.stringify({ value: 0 }),
      after: JSON.stringify({ value: 5_000_000_000 }),
      detail: null,
    });
    const safe = toMemberSafeAuditRow(row, 'admin');
    expect(safe.before).toEqual({ value: 0 });
    expect(safe.after).toEqual({ value: 5_000_000_000 });
  });
});

describe('toMemberSafeAuditRow — scalar-only defense in depth', () => {
  it('drops an allow-listed key even when its value is an array/object, not just when the key is unlisted', () => {
    // Simulates a future bug where `quota.set`'s `after.quotaBytes` field got
    // accidentally replaced with a nested object — the allow-list alone
    // would let the KEY through; the scalar guard is the second, independent
    // check that still drops it.
    const row = baseRow({
      action: 'quota.set',
      actor: 'admin',
      actorRole: 'operator',
      targetType: 'member',
      targetId: 'dana',
      before: null,
      after: JSON.stringify({ quotaBytes: { nested: 'oops', ssoUsername: 'alice' }, source: 'override' }),
      detail: null,
    });
    const safe = toMemberSafeAuditRow(row, 'admin');
    expect(safe.after).toEqual({ source: 'override' }); // quotaBytes dropped, source (a real scalar) kept
    expect(JSON.stringify(safe)).not.toContain('alice');
  });

  it('a null/malformed blob never throws and yields no fields', () => {
    const row = baseRow({ action: 'delete.blocked', detail: 'not valid json {{{' });
    expect(() => toMemberSafeAuditRow(row, 'dana')).not.toThrow();
    expect(toMemberSafeAuditRow(row, 'dana').detail).toEqual({});
  });
});

describe('toMemberSafeAuditRow — byOperator flag', () => {
  it('false when the member acted themselves', () => {
    const safe = toMemberSafeAuditRow(baseRow({ actor: 'dana', onBehalfOf: null }), 'dana');
    expect(safe.byOperator).toBe(false);
  });

  it('true when on_behalf_of matches the viewer', () => {
    const safe = toMemberSafeAuditRow(baseRow({ actor: 'admin', actorRole: 'operator', onBehalfOf: 'dana' }), 'dana');
    expect(safe.byOperator).toBe(true);
  });
});
