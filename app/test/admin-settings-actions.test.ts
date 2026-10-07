import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

// Isolated throwaway DB file — same pattern as test/quota-policy.test.ts /
// test/admin-dashboard-data.test.ts.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-settings-actions-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const { getDb, _resetDbForTests } = await import('@/lib/db');
const { appSetting, audit, claim, member, quotaPolicy, syncRun, title } = await import('@/lib/db/schema');
const { _resetConfigCacheForTests } = await import('@/lib/config');
const { previewEnforcementToggle, setEnforcementEnabled, setNumericSetting } = await import('@/app/admin/_actions/settingsActions');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  _resetDbForTests();
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(`${tmpDbPath}-wal`, { force: true });
  fs.rmSync(`${tmpDbPath}-shm`, { force: true });
  _resetConfigCacheForTests();
});

const NOW = 1_800_000_000;

function setDefaultQuota(bytes: number): void {
  getDb().insert(appSetting).values({ key: 'default_quota_bytes', value: JSON.stringify(bytes), updatedAt: NOW, updatedBy: 'admin' }).run();
}

function auditRowsFor(action: string, targetId: string) {
  return getDb()
    .select()
    .from(audit)
    .where(and(eq(audit.action, action as never), eq(audit.targetId, targetId)))
    .all();
}

let nextArrId = 1;
function insertMemberWithUsage(ssoUsername: string, quotaBytes: number | null, source: 'default' | 'override', usageBytes: number): void {
  getDb().insert(member).values({ ssoUsername, entitled: true, isOperator: false, syncStatus: 'matched', firstSeenAt: NOW, lastSyncedAt: NOW }).run();
  getDb().insert(quotaPolicy).values({ ssoUsername, quotaBytes, source, updatedAt: NOW, updatedBy: 'system' }).run();
  const titleId = `movie:${nextArrId}`;
  getDb().insert(title).values({ id: titleId, mediaType: 'movie', arrInstance: 'radarr', arrId: nextArrId++, title: titleId, sizeBytes: usageBytes, path: `/data/${titleId}`, addedAt: NOW, lastSyncedAt: NOW }).run();
  getDb().insert(claim).values({ titleId, ssoUsername, chargedBytes: usageBytes, active: true, createdAt: NOW }).run();
}

function markAttributionRan(): void {
  getDb()
    .insert(syncRun)
    .values({ startedAt: NOW - 10, finishedAt: NOW, steps: JSON.stringify({ requests: { ok: true, count: 0, ms: 1 }, attribution: { ok: true, count: 0, ms: 1 } }), ok: true })
    .run();
}

// ---------------------------------------------------------------------------
// setNumericSetting — FR-ADM-11
// ---------------------------------------------------------------------------

describe('setNumericSetting', () => {
  it('rejects a negative value for a plain-count setting, writes nothing', () => {
    const outcome = setNumericSetting(getDb(), { key: 'hold_max_days', value: -1, actor: 'admin' });
    expect(outcome.kind).toBe('invalid');
    expect(auditRowsFor('setting.changed', 'hold_max_days')).toHaveLength(0);
  });

  it('rejects a non-integer value', () => {
    const outcome = setNumericSetting(getDb(), { key: 'delete_max_per_hour', value: 2.5, actor: 'admin' });
    expect(outcome.kind).toBe('invalid');
  });

  it('writes the value and a setting.changed audit row with before/after', () => {
    const outcome = setNumericSetting(getDb(), { key: 'notify_cooldown_s', value: 3600, actor: 'admin' });
    expect(outcome).toEqual({ kind: 'ok', before: 86_400, after: 3600 }); // 86400 = config default seed

    const row = getDb().select().from(appSetting).where(eq(appSetting.key, 'notify_cooldown_s')).get()!;
    expect(JSON.parse(row.value)).toBe(3600);

    const rows = auditRowsFor('setting.changed', 'notify_cooldown_s');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].before!)).toEqual({ value: 86_400 });
    expect(JSON.parse(rows[0].after!)).toEqual({ value: 3600 });
    expect(rows[0].actorRole).toBe('operator');
  });

  it('grace_bytes reuses @/lib/quota validateGraceBytes — rejects exceeding the current default', () => {
    setDefaultQuota(10_000_000_000);
    const outcome = setNumericSetting(getDb(), { key: 'grace_bytes', value: 20_000_000_000, actor: 'admin' });
    expect(outcome.kind).toBe('invalid');
    expect(auditRowsFor('setting.changed', 'grace_bytes')).toHaveLength(0);
  });

  it('grace_bytes allows exceeding when no default is configured yet', () => {
    const outcome = setNumericSetting(getDb(), { key: 'grace_bytes', value: 20_000_000_000, actor: 'admin' });
    expect(outcome.kind).toBe('ok');
  });

  it('a second write reads the FIRST write as its "before" (DB wins over config seed on the next call)', () => {
    setNumericSetting(getDb(), { key: 'hold_max_days', value: 10, actor: 'admin' });
    const second = setNumericSetting(getDb(), { key: 'hold_max_days', value: 20, actor: 'admin' });
    expect(second).toEqual({ kind: 'ok', before: 10, after: 20 });
  });
});

// ---------------------------------------------------------------------------
// previewEnforcementToggle / setEnforcementEnabled — FR-ADM-11
// ---------------------------------------------------------------------------

describe('previewEnforcementToggle', () => {
  it('reports defaultQuotaConfigured: false and zero affected when nothing is set up', async () => {
    const preview = await previewEnforcementToggle(getDb());
    expect(preview.currentlyEnabled).toBe(false);
    expect(preview.defaultQuotaConfigured).toBe(false);
    expect(preview.affectedCount).toBe(0);
  });

  it('counts members currently over quota, right now, from the real member table', async () => {
    setDefaultQuota(500_000_000_000);
    markAttributionRan();
    insertMemberWithUsage('dana', null, 'default', 1_040_000_000_000); // over the 500GB default
    insertMemberWithUsage('erin', null, 'default', 100_000_000_000); // under
    insertMemberWithUsage('carol', 0, 'override', 999_000_000_000_000); // unlimited override — never over

    const preview = await previewEnforcementToggle(getDb());
    expect(preview.defaultQuotaConfigured).toBe(true);
    expect(preview.affectedCount).toBe(1);
    expect(preview.affectedUsernames).toEqual(['dana']);
  });
});

describe('setEnforcementEnabled', () => {
  it('refuses to enable when default_quota_bytes is unset — the same rule boot validation enforces', async () => {
    const outcome = await setEnforcementEnabled(getDb(), { enabled: true, actor: 'admin' });
    expect(outcome.kind).toBe('invalid');
    const row = getDb().select().from(appSetting).where(eq(appSetting.key, 'enforcement_enabled')).get();
    expect(row).toBeUndefined(); // nothing written
    expect(auditRowsFor('enforcement.toggled', 'enforcement_enabled')).toHaveLength(0);
  });

  it('enables when a default IS configured, writes an enforcement.toggled audit row with the affected-count detail', async () => {
    setDefaultQuota(500_000_000_000);
    markAttributionRan();
    insertMemberWithUsage('dana', null, 'default', 1_040_000_000_000);

    const outcome = await setEnforcementEnabled(getDb(), { enabled: true, actor: 'admin' });
    expect(outcome).toEqual({ kind: 'ok', before: false, after: true, affectedCount: 1, affectedUsernames: ['dana'] });

    const row = getDb().select().from(appSetting).where(eq(appSetting.key, 'enforcement_enabled')).get()!;
    expect(JSON.parse(row.value)).toBe(true);

    const rows = auditRowsFor('enforcement.toggled', 'enforcement_enabled');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].before!)).toEqual({ enabled: false });
    expect(JSON.parse(rows[0].after!)).toEqual({ enabled: true });
    expect(JSON.parse(rows[0].detail!)).toEqual({ affectedCount: 1, affectedUsernames: ['dana'] });
  });

  it('disabling never requires a default quota', async () => {
    setDefaultQuota(500_000_000_000);
    await setEnforcementEnabled(getDb(), { enabled: true, actor: 'admin' });
    _resetConfigCacheForTests();

    const outcome = await setEnforcementEnabled(getDb(), { enabled: false, actor: 'admin' });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') throw new Error('unreachable');
    expect(outcome.before).toBe(true);
    expect(outcome.after).toBe(false);
  });
});
