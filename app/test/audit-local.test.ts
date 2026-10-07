import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-audit-local-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const { getDb } = await import('@/lib/db');
const { audit, appSetting } = await import('@/lib/db/schema');
const { withAudit } = await import('@/lib/audit/local');
const { eq } = await import('drizzle-orm');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('withAudit — local state change + its audit row commit together (FR-AUD-8, local half)', () => {
  it('a state change plus one audit() call both commit', () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);

    withAudit(db, ({ tx, audit: record, correlationId }) => {
      tx.insert(appSetting)
        .values({ key: 'grace_bytes', value: JSON.stringify(0), updatedAt: now, updatedBy: 'admin' })
        .run();
      record({
        actor: 'admin',
        actorRole: 'operator',
        action: 'setting.changed',
        targetType: 'setting',
        targetId: 'grace_bytes',
        outcome: 'ok',
        source: 'ui',
        before: { value: null },
        after: { value: 0 },
      });
      return correlationId;
    });

    const settingRows = db.select().from(appSetting).where(eq(appSetting.key, 'grace_bytes')).all();
    expect(settingRows).toHaveLength(1);

    const auditRows = db.select().from(audit).where(eq(audit.action, 'setting.changed')).all();
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].targetId).toBe('grace_bytes');
  });

  it('a local change WITHOUT calling audit() throws, and the state change is rolled back (nothing commits, not even partially)', () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);

    expect(() =>
      withAudit(db, ({ tx }) => {
        // Forgets to call audit() — this must not be allowed to commit.
        tx.insert(appSetting)
          .values({ key: 'stale_snapshot_max_age_s', value: JSON.stringify(3600), updatedAt: now, updatedBy: 'admin' })
          .run();
      }),
    ).toThrow(/without calling audit\(\)/);

    // The appSetting insert must have been rolled back along with the (missing) audit row.
    const rows = db.select().from(appSetting).where(eq(appSetting.key, 'stale_snapshot_max_age_s')).all();
    expect(rows).toHaveLength(0);
  });

  it('multiple audit() calls inside one withAudit share the same correlationId (a batched local operation)', () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);

    const correlationId = withAudit(db, ({ tx, audit: record, correlationId: cid }) => {
      for (const key of ['delete_recent_play_days', 'delete_max_per_hour']) {
        tx.insert(appSetting).values({ key, value: JSON.stringify(1), updatedAt: now, updatedBy: 'admin' }).run();
        record({
          actor: 'admin',
          actorRole: 'operator',
          action: 'setting.changed',
          targetType: 'setting',
          targetId: key,
          outcome: 'ok',
          source: 'ui',
        });
      }
      return cid;
    });

    const rows = db.select().from(audit).where(eq(audit.correlationId, correlationId)).all();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.targetId).sort()).toEqual(['delete_max_per_hour', 'delete_recent_play_days']);
  });

  it('a thrown error from fn (after audit() was already called) rolls back BOTH the state change and its audit row', () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const beforeCount = db.select().from(audit).all().length;

    expect(() =>
      withAudit(db, ({ tx, audit: record }) => {
        tx.insert(appSetting).values({ key: 'notify_cooldown_s', value: JSON.stringify(1), updatedAt: now, updatedBy: 'x' }).run();
        record({
          actor: 'admin',
          actorRole: 'operator',
          action: 'setting.changed',
          targetType: 'setting',
          targetId: 'notify_cooldown_s',
          outcome: 'ok',
          source: 'ui',
        });
        throw new Error('simulated failure after audit() was called');
      }),
    ).toThrow(/simulated failure/);

    const settingRows = db.select().from(appSetting).where(eq(appSetting.key, 'notify_cooldown_s')).all();
    expect(settingRows).toHaveLength(0);
    const afterCount = db.select().from(audit).all().length;
    expect(afterCount).toBe(beforeCount); // the audit row from the aborted transaction did NOT survive
  });
});
