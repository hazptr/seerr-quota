import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

// Isolated throwaway DB file — same pattern as test/members-sync.test.ts and
// test/member-dashboard-data.test.ts. Must be set BEFORE `@/lib/db`
// (transitively imported by `@/lib/quota/policy`) is imported.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-policy-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const { getDb, _resetDbForTests } = await import('@/lib/db');
const { appSetting, audit, claim, member, quotaPolicy, title } = await import('@/lib/db/schema');
const { _resetConfigCacheForTests } = await import('@/lib/config');
const { resolveEffectiveQuota } = await import('@/lib/members/quota');
const {
  clearMemberOverride,
  getGlobalDefaultQuotaBytes,
  getGraceBytes,
  getMemberQuotaPolicy,
  listMemberQuotaPolicies,
  previewGlobalDefaultChange,
  previewMemberClearOverride,
  previewMemberOverrideChange,
  setGlobalDefaultQuota,
  setMemberOverride,
} = await import('@/lib/quota/policy');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Fresh DB per test — this suite asserts exact row/audit counts and exact
  // before/after values, which a shared handle across tests would pollute
  // (same discipline as test/members-sync.test.ts).
  _resetDbForTests();
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(`${tmpDbPath}-wal`, { force: true });
  fs.rmSync(`${tmpDbPath}-shm`, { force: true });
  _resetConfigCacheForTests();
});

const NOW = 1_800_000_000;

function insertMember(ssoUsername: string): void {
  getDb()
    .insert(member)
    .values({ ssoUsername, entitled: true, isOperator: false, syncStatus: 'matched', firstSeenAt: NOW, lastSyncedAt: NOW })
    .run();
}

function insertQuotaPolicy(ssoUsername: string, quotaBytes: number | null, source: 'default' | 'override', note: string | null = null): void {
  getDb().insert(quotaPolicy).values({ ssoUsername, quotaBytes, source, note, updatedAt: NOW, updatedBy: 'system' }).run();
}

let nextArrId = 1;
let nextTitleId = 1;
function insertClaim(ssoUsername: string, chargedBytes: number, active = true): void {
  const titleId = `movie:${nextTitleId++}`;
  getDb()
    .insert(title)
    .values({ id: titleId, mediaType: 'movie', arrInstance: 'radarr', arrId: nextArrId++, title: titleId, sizeBytes: chargedBytes, path: `/data/${titleId}`, lastSyncedAt: NOW })
    .run();
  getDb().insert(claim).values({ titleId, ssoUsername, chargedBytes, active, createdAt: NOW }).run();
}

function auditRowsFor(action: string, targetId: string) {
  return getDb()
    .select()
    .from(audit)
    .where(and(eq(audit.action, action as never), eq(audit.targetId, targetId)))
    .all();
}

// ---------------------------------------------------------------------------
// getGlobalDefaultQuotaBytes / getGraceBytes
// ---------------------------------------------------------------------------

describe('getGlobalDefaultQuotaBytes', () => {
  it('is null when nothing has ever been set — FR-POL-2: an absence, never coerced to 0', () => {
    expect(getGlobalDefaultQuotaBytes(getDb())).toBeNull();
  });

  it('reads the DB value once set', () => {
    getDb().insert(appSetting).values({ key: 'default_quota_bytes', value: JSON.stringify(300_000_000_000), updatedAt: NOW, updatedBy: 'admin' }).run();
    expect(getGlobalDefaultQuotaBytes(getDb())).toBe(300_000_000_000);
  });

  it('a DB value of 0 (explicitly unlimited) is returned as 0, not treated as "unset"', () => {
    getDb().insert(appSetting).values({ key: 'default_quota_bytes', value: JSON.stringify(0), updatedAt: NOW, updatedBy: 'admin' }).run();
    expect(getGlobalDefaultQuotaBytes(getDb())).toBe(0);
  });
});

describe('getGraceBytes', () => {
  it('defaults to 0 when unset', () => {
    expect(getGraceBytes(getDb())).toBe(0);
  });

  it('reads the DB value once set', () => {
    getDb().insert(appSetting).values({ key: 'grace_bytes', value: JSON.stringify(5_000_000), updatedAt: NOW, updatedBy: 'admin' }).run();
    expect(getGraceBytes(getDb())).toBe(5_000_000);
  });
});

// ---------------------------------------------------------------------------
// setGlobalDefaultQuota — FR-POL-1, FR-POL-3, FR-POL-9
// ---------------------------------------------------------------------------

describe('setGlobalDefaultQuota', () => {
  it('rejects a negative proposed value, writes nothing', () => {
    const outcome = setGlobalDefaultQuota(getDb(), { proposedBytes: -1, actor: 'admin' });
    expect(outcome.kind).toBe('invalid');
    expect(getGlobalDefaultQuotaBytes(getDb())).toBeNull();
    expect(auditRowsFor('setting.changed', 'default_quota_bytes')).toHaveLength(0);
  });

  it('rejects a proposed default below the current grace_bytes (FR-POL-9)', () => {
    getDb().insert(appSetting).values({ key: 'grace_bytes', value: JSON.stringify(10_000_000_000), updatedAt: NOW, updatedBy: 'admin' }).run();
    const outcome = setGlobalDefaultQuota(getDb(), { proposedBytes: 5_000_000_000, actor: 'admin' });
    expect(outcome.kind).toBe('invalid');
    expect(getGlobalDefaultQuotaBytes(getDb())).toBeNull();
  });

  it('acceptance criterion: a member with no override sees their effective quota rise when the default rises, with NO write to their quota_policy row', () => {
    insertMember('erin');
    insertQuotaPolicy('erin', null, 'default'); // unconfigured — no default has ever been set

    const first = setGlobalDefaultQuota(getDb(), { proposedBytes: 300_000_000_000, actor: 'admin', freeBytesOverride: 999_000_000_000_000 });
    expect(first.kind).toBe('ok');
    let row = getDb().select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, 'erin')).get()!;
    // Untouched — inheritance is resolved at READ time, never materialised
    // (FR-POL-2a). This is the whole point: no fan-out write.
    expect(row.quotaBytes).toBeNull();
    expect(row.source).toBe('default');
    expect(resolveEffectiveQuota(row.quotaBytes, getGlobalDefaultQuotaBytes(getDb()))).toEqual({ kind: 'limited', bytes: 300_000_000_000 });

    const second = setGlobalDefaultQuota(getDb(), { proposedBytes: 500_000_000_000, actor: 'admin', freeBytesOverride: 999_000_000_000_000 });
    expect(second.kind).toBe('ok');
    row = getDb().select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, 'erin')).get()!;
    expect(row.quotaBytes).toBeNull(); // STILL untouched after a second default change
    // Rose along with the default — resolved fresh on read, no second write needed.
    expect(resolveEffectiveQuota(row.quotaBytes, getGlobalDefaultQuotaBytes(getDb()))).toEqual({ kind: 'limited', bytes: 500_000_000_000 });

    const rows = auditRowsFor('setting.changed', 'default_quota_bytes');
    expect(rows).toHaveLength(2);
    const secondRow = rows[1];
    expect(JSON.parse(secondRow.before!)).toEqual({ defaultQuotaBytes: 300_000_000_000 });
    expect(JSON.parse(secondRow.after!)).toEqual({ defaultQuotaBytes: 500_000_000_000, note: null });
    expect(secondRow.actor).toBe('admin');
    expect(secondRow.actorRole).toBe('operator');
  });

  it('does NOT touch a member with an override — this module makes NO write to quota_policy at all, so an override is unaffected a fortiori', () => {
    insertMember('carol');
    insertQuotaPolicy('carol', 0, 'override'); // unlimited, operator's explicit decision

    setGlobalDefaultQuota(getDb(), { proposedBytes: 200_000_000_000, actor: 'admin', freeBytesOverride: 999_000_000_000_000 });

    const row = getDb().select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, 'carol')).get()!;
    expect(row.quotaBytes).toBe(0);
    expect(row.source).toBe('override');
  });

  it('warns (never rejects) when the proposed value exceeds free space', () => {
    const outcome = setGlobalDefaultQuota(getDb(), { proposedBytes: 10_000_000_000_000, actor: 'admin', freeBytesOverride: 1_000_000_000 });
    expect(outcome.kind).toBe('ok');
    expect(outcome.kind === 'ok' && outcome.warning).toBeDefined();
  });

  it('the audit detail names exactly who was pushed newly over, matching the preview', () => {
    insertMember('dana');
    insertMember('admin');
    insertQuotaPolicy('dana', null, 'default');
    insertQuotaPolicy('admin', null, 'default');
    insertClaim('dana', 1_040_000_000_000);
    insertClaim('admin', 580_000_000_000);

    setGlobalDefaultQuota(getDb(), { proposedBytes: 500_000_000_000, actor: 'admin', freeBytesOverride: 999_000_000_000_000 });

    const row = auditRowsFor('setting.changed', 'default_quota_bytes')[0];
    const detail = JSON.parse(row.detail!) as { affectedMemberCount: number; newlyOver: Array<{ ssoUsername: string }> };
    expect(detail.affectedMemberCount).toBe(2);
    expect(detail.newlyOver.map((m) => m.ssoUsername).sort()).toEqual(['admin', 'dana']);
  });
});

// ---------------------------------------------------------------------------
// setMemberOverride — FR-POL-2, FR-POL-3, FR-POL-5, FR-POL-9
// ---------------------------------------------------------------------------

describe('setMemberOverride', () => {
  it('rejects a negative override, writes nothing', () => {
    insertMember('frank');
    insertQuotaPolicy('frank', null, 'default');
    const outcome = setMemberOverride(getDb(), { ssoUsername: 'frank', proposedBytes: -5, actor: 'admin' });
    expect(outcome.kind).toBe('invalid');
    expect(auditRowsFor('quota.set', 'frank')).toHaveLength(0);
  });

  it('sets a positive override, flips source to override, writes one quota.set audit row with before/after', () => {
    insertMember('frank');
    insertQuotaPolicy('frank', null, 'default');

    const outcome = setMemberOverride(getDb(), { ssoUsername: 'frank', proposedBytes: 411_000_000_000, actor: 'admin', note: 'grandfathered + 100GB', freeBytesOverride: 999_000_000_000_000 });
    expect(outcome.kind).toBe('ok');

    const row = getDb().select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, 'frank')).get()!;
    expect(row.quotaBytes).toBe(411_000_000_000);
    expect(row.source).toBe('override');
    expect(row.note).toBe('grandfathered + 100GB');

    const rows = auditRowsFor('quota.set', 'frank');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].before!)).toEqual({ quotaBytes: null, source: 'default' });
    expect(JSON.parse(rows[0].after!)).toEqual({ quotaBytes: 411_000_000_000, source: 'override', note: 'grandfathered + 100GB' });
  });

  it('0 means unlimited — a real decision, stored and audited like any other value', () => {
    insertMember('carol');
    insertQuotaPolicy('carol', null, 'default');
    const outcome = setMemberOverride(getDb(), { ssoUsername: 'carol', proposedBytes: 0, actor: 'admin', freeBytesOverride: 999_000_000_000_000 });
    expect(outcome.kind).toBe('ok');
    const row = getDb().select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, 'carol')).get()!;
    expect(row.quotaBytes).toBe(0);
    expect(row.source).toBe('override');
  });

  it('FR-POL-5: an override below current usage returns the exact overage and a requiresConfirmation flag, and records it in the audit detail', () => {
    insertMember('dana');
    insertQuotaPolicy('dana', null, 'default');
    insertClaim('dana', 1_040_000_000_000);

    const outcome = setMemberOverride(getDb(), { ssoUsername: 'dana', proposedBytes: 900_000_000_000, actor: 'admin', freeBytesOverride: 999_000_000_000_000 });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') throw new Error('unreachable');
    expect(outcome.result.effect.requiresConfirmation).toBe(true);
    expect(outcome.result.effect.overageAfterBytes).toBe(1_040_000_000_000 - 900_000_000_000);

    const row = auditRowsFor('quota.set', 'dana')[0];
    const detail = JSON.parse(row.detail!);
    expect(detail.requiresConfirmation).toBe(true);
    expect(detail.overageAfterBytes).toBe(1_040_000_000_000 - 900_000_000_000);
    expect(detail.usageBytes).toBe(1_040_000_000_000);
  });
});

// ---------------------------------------------------------------------------
// clearMemberOverride — FR-POL-2, FR-POL-3
// ---------------------------------------------------------------------------

describe('clearMemberOverride', () => {
  it('clearing when a default IS configured writes quotaBytes: null (never a resolved value) — "inherits default (X GB)" comes from resolving null against the CURRENT default at read time, not a frozen copy', () => {
    getDb().insert(appSetting).values({ key: 'default_quota_bytes', value: JSON.stringify(300_000_000_000), updatedAt: NOW, updatedBy: 'admin' }).run();
    insertMember('frank');
    insertQuotaPolicy('frank', 411_000_000_000, 'override', 'was custom');

    const result = clearMemberOverride(getDb(), { ssoUsername: 'frank', actor: 'admin' });
    expect(result.before).toEqual({ kind: 'limited', bytes: 411_000_000_000 });
    expect(result.after).toEqual({ kind: 'limited', bytes: 300_000_000_000 }); // resolved from the current default, not stored

    const row = getDb().select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, 'frank')).get()!;
    expect(row.quotaBytes).toBeNull(); // null, NOT 300_000_000_000 — inheritance resolved at read time, never materialised (FR-POL-2a)
    expect(row.source).toBe('default');

    const rows = auditRowsFor('quota.cleared', 'frank');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].before!)).toEqual({ quotaBytes: 411_000_000_000, source: 'override' });
    expect(JSON.parse(rows[0].after!)).toEqual({ quotaBytes: null, source: 'default' });

    // Proof this is genuinely resolved at read time, not frozen: raise the
    // default afterward and re-read — the row stays untouched but the
    // effective quota rises again, with no second clearMemberOverride call.
    getDb().update(appSetting).set({ value: JSON.stringify(500_000_000_000) }).where(eq(appSetting.key, 'default_quota_bytes')).run();
    const rowAfterDefaultRaise = getDb().select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, 'frank')).get()!;
    expect(rowAfterDefaultRaise.quotaBytes).toBeNull(); // still untouched
    expect(resolveEffectiveQuota(rowAfterDefaultRaise.quotaBytes, getGlobalDefaultQuotaBytes(getDb()))).toEqual({ kind: 'limited', bytes: 500_000_000_000 });
  });

  it('clearing when NO default has ever been set resolves to unconfigured (null), matching FR-POL-2a — never silently promoted to 0', () => {
    insertMember('dana');
    insertQuotaPolicy('dana', 1_150_000_000_000, 'override');

    const result = clearMemberOverride(getDb(), { ssoUsername: 'dana', actor: 'admin' });
    expect(result.after).toEqual({ kind: 'unconfigured' });

    const row = getDb().select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, 'dana')).get()!;
    expect(row.quotaBytes).toBeNull();
    expect(row.source).toBe('default');
  });
});

// ---------------------------------------------------------------------------
// FR-POL-6 — member self-view, gated in the accessor itself
// ---------------------------------------------------------------------------

describe('getMemberQuotaPolicy / listMemberQuotaPolicies — FR-POL-6', () => {
  it('a member can read their own record', () => {
    insertMember('erin');
    insertQuotaPolicy('erin', 469_000_000_000, 'override', 'grandfathered');
    insertClaim('erin', 450_000_000_000);

    const result = getMemberQuotaPolicy(getDb(), { ssoUsername: 'erin', isOperator: false }, 'erin');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.record.effective).toEqual({ kind: 'limited', bytes: 469_000_000_000 });
    expect(result.record.usageBytes).toBe(450_000_000_000);
    expect(result.record.note).toBe('grandfathered');
  });

  it('a member CANNOT read another member\'s record — forbidden, not a redacted/partial view', () => {
    insertMember('erin');
    insertMember('dana');
    insertQuotaPolicy('dana', 1_150_000_000_000, 'override');

    const result = getMemberQuotaPolicy(getDb(), { ssoUsername: 'erin', isOperator: false }, 'dana');
    expect(result).toEqual({ kind: 'forbidden' });
  });

  it('an operator can read anyone\'s record', () => {
    insertMember('dana');
    insertQuotaPolicy('dana', 1_150_000_000_000, 'override');
    const result = getMemberQuotaPolicy(getDb(), { ssoUsername: 'admin', isOperator: true }, 'dana');
    expect(result.kind).toBe('ok');
  });

  it('not_found for a member with no quota_policy row', () => {
    insertMember('orphan');
    const result = getMemberQuotaPolicy(getDb(), { ssoUsername: 'orphan', isOperator: false }, 'orphan');
    expect(result).toEqual({ kind: 'not_found' });
  });

  it('listMemberQuotaPolicies is forbidden for a non-operator, regardless of whose data they ask about', () => {
    expect(listMemberQuotaPolicies(getDb(), { ssoUsername: 'erin', isOperator: false })).toBe('forbidden');
  });

  it('listMemberQuotaPolicies returns every member, with usage, for an operator', () => {
    insertMember('dana');
    insertMember('erin');
    insertQuotaPolicy('dana', null, 'default');
    insertQuotaPolicy('erin', 469_000_000_000, 'override');
    insertClaim('dana', 1_040_000_000_000);
    insertClaim('erin', 450_000_000_000);

    const result = listMemberQuotaPolicies(getDb(), { ssoUsername: 'admin', isOperator: true });
    expect(result).not.toBe('forbidden');
    if (result === 'forbidden') throw new Error('unreachable');
    expect(result).toHaveLength(2);
    const danaView = result.find((r) => r.ssoUsername === 'dana')!;
    expect(danaView.effective).toEqual({ kind: 'unconfigured' });
    expect(danaView.usageBytes).toBe(1_040_000_000_000);
    const erinView = result.find((r) => r.ssoUsername === 'erin')!;
    expect(erinView.effective).toEqual({ kind: 'limited', bytes: 469_000_000_000 });
  });
});

// ---------------------------------------------------------------------------
// Read-only preview wrappers — never write anything
// ---------------------------------------------------------------------------

describe('preview* functions never write to the DB', () => {
  it('previewGlobalDefaultChange writes no app_setting/quota_policy/audit rows', () => {
    insertMember('dana');
    insertQuotaPolicy('dana', null, 'default');
    insertClaim('dana', 1_040_000_000_000);

    previewGlobalDefaultChange(getDb(), 500_000_000_000);

    expect(getDb().select().from(appSetting).all()).toHaveLength(0);
    expect(getDb().select().from(audit).all()).toHaveLength(0);
    const row = getDb().select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, 'dana')).get()!;
    expect(row.quotaBytes).toBeNull(); // untouched
  });

  it('previewMemberOverrideChange / previewMemberClearOverride write nothing', () => {
    insertMember('erin');
    insertQuotaPolicy('erin', null, 'default');
    insertClaim('erin', 450_000_000_000);

    previewMemberOverrideChange(getDb(), 'erin', 300_000_000_000);
    previewMemberClearOverride(getDb(), 'erin');

    expect(getDb().select().from(audit).all()).toHaveLength(0);
    const row = getDb().select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, 'erin')).get()!;
    expect(row.quotaBytes).toBeNull();
  });

  it('previewMemberOverrideChange returns undefined for a member with no quota_policy row', () => {
    insertMember('orphan');
    expect(previewMemberOverrideChange(getDb(), 'orphan', 100)).toBeUndefined();
  });
});
