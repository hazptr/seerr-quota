import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// DB_PATH must be set BEFORE `@/lib/db` is imported — same pattern as
// test/db.test.ts: an isolated, throwaway file rather than the default
// `/db/seerr-quota.db`.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-audit-write-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const { getDb } = await import('@/lib/db');
const { audit } = await import('@/lib/db/schema');
const { writeAuditRow, newCorrelationId, readAuditRowsByCorrelationId } = await import('@/lib/audit/write');
const { getAuditWriteFailures, _resetAuditWriteFailuresForTests } = await import('@/lib/audit/failures');
const { _resetConfigCacheForTests } = await import('@/lib/config');
const { eq } = await import('drizzle-orm');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  _resetAuditWriteFailuresForTests();
  _resetConfigCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetConfigCacheForTests();
});

describe('writeAuditRow — basic persistence + validation', () => {
  it('inserts a row with the given fields, defaulting ts to ~now (Unix ms, FR-AUD-12)', () => {
    const db = getDb();
    const before = Date.now();
    writeAuditRow(db, {
      actor: 'admin',
      actorRole: 'operator',
      action: 'quota.set',
      targetType: 'member',
      targetId: 'dana',
      outcome: 'ok',
      source: 'ui',
      correlationId: newCorrelationId(),
      before: { quotaBytes: 500_000_000_000 },
      after: { quotaBytes: 300_000_000_000 },
    });
    const after = Date.now();
    const rows = db.select().from(audit).all();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.ts).toBeGreaterThanOrEqual(before);
    expect(row.ts).toBeLessThanOrEqual(after);
    expect(row.ts).toBeGreaterThan(1_700_000_000_000); // sanity: ms, not s
    expect(row.action).toBe('quota.set');
    expect(row.outcome).toBe('ok');
    expect(JSON.parse(row.before!)).toEqual({ quotaBytes: 500_000_000_000 });
    expect(JSON.parse(row.after!)).toEqual({ quotaBytes: 300_000_000_000 });
  });

  it('throws when a targeted action (per the vocabulary table) is missing targetId (FR-AUD-3)', () => {
    const db = getDb();
    expect(() =>
      writeAuditRow(db, {
        actor: 'admin',
        actorRole: 'operator',
        action: 'quota.set', // Target: member — required
        outcome: 'ok',
        source: 'ui',
        correlationId: newCorrelationId(),
      }),
    ).toThrow(/requires a targetId/);
  });

  it('does NOT require targetId for the two "Target: —" actions', () => {
    const db = getDb();
    expect(() =>
      writeAuditRow(db, {
        actor: 'system',
        actorRole: 'system',
        action: 'webhook.rejected',
        outcome: 'denied',
        source: 'webhook',
        correlationId: newCorrelationId(),
        detail: { reason: 'bad secret header' },
      }),
    ).not.toThrow();
    expect(() =>
      writeAuditRow(db, {
        actor: 'system',
        actorRole: 'system',
        action: 'sync.failed',
        outcome: 'error',
        source: 'cron',
        correlationId: newCorrelationId(),
        detail: { step: 'radarr' },
      }),
    ).not.toThrow();
  });
});

describe('writeAuditRow — denials are logged (FR-AUD-4)', () => {
  it('a denied action produces a row with outcome = denied and enough detail to identify what was attempted', () => {
    const db = getDb();
    writeAuditRow(db, {
      actor: 'jack',
      actorRole: 'member',
      action: 'access.denied',
      targetType: 'title',
      targetId: 'movie:99',
      outcome: 'denied',
      source: 'ui',
      correlationId: newCorrelationId(),
      detail: { attempted: 'delete.requested', reason: 'not_claimant' },
    });
    // NOT `[row] = ...all()` — earlier tests in this file share the same DB
    // handle and have already inserted other rows, so pick this one out by
    // its target rather than assuming it's first.
    const rows = db.select().from(audit).where(eq(audit.targetId, 'movie:99')).all();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.outcome).toBe('denied');
    expect(JSON.parse(row.detail!)).toEqual({ attempted: 'delete.requested', reason: 'not_claimant' });
  });
});

describe('writeAuditRow — correlation ids group multi-step operations (FR-AUD-5)', () => {
  it('rows sharing a correlationId are retrievable together, in order', () => {
    const db = getDb();
    const correlationId = newCorrelationId();
    writeAuditRow(db, {
      actor: 'dana',
      actorRole: 'member',
      action: 'delete.requested',
      targetType: 'title',
      targetId: 'movie:1',
      outcome: 'ok',
      source: 'ui',
      correlationId,
    });
    writeAuditRow(db, {
      actor: 'dana',
      actorRole: 'member',
      action: 'delete.requested',
      targetType: 'title',
      targetId: 'movie:2',
      outcome: 'ok',
      source: 'ui',
      correlationId,
    });
    writeAuditRow(db, {
      actor: 'someone-else',
      actorRole: 'member',
      action: 'delete.requested',
      targetType: 'title',
      targetId: 'movie:3',
      outcome: 'ok',
      source: 'ui',
      correlationId: newCorrelationId(), // different operation
    });

    const grouped = readAuditRowsByCorrelationId(db, correlationId);
    expect(grouped).toHaveLength(2);
    expect(grouped.every((r) => r.correlationId === correlationId)).toBe(true);
  });
});

describe('writeAuditRow — written twice (FR-AUD-6)', () => {
  it('emits a stdout JSON line matching the persisted row for every write', () => {
    const db = getDb();
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const correlationId = newCorrelationId();
    writeAuditRow(db, {
      actor: 'system',
      actorRole: 'system',
      action: 'sync.failed',
      outcome: 'error',
      source: 'cron',
      correlationId,
      detail: { step: 'jellyfin' },
    });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [line] = writeSpy.mock.calls[0] as [string];
    const parsed = JSON.parse(line.trim());
    expect(parsed.action).toBe('sync.failed');
    expect(parsed.outcome).toBe('error');
    expect(parsed.correlationId).toBe(correlationId);
    expect(JSON.parse(parsed.detail)).toEqual({ step: 'jellyfin' });

    const allRows = db.select().from(audit).all();
    const dbRow = allRows[allRows.length - 1]; // last inserted row
    expect(dbRow.action).toBe(parsed.action);
    expect(dbRow.correlationId).toBe(parsed.correlationId);
  });
});

describe('writeAuditRow — failures are loud, never silent (FR-AUD-7)', () => {
  it('rethrows when the DB insert throws, logs at error level, and surfaces the failure via getAuditWriteFailures()', () => {
    const dbInsertFails = {
      insert: () => ({
        values: () => ({
          run: () => {
            throw new Error('SQLITE_BUSY: simulated DB failure');
          },
        }),
      }),
    } as any;

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    expect(() =>
      writeAuditRow(dbInsertFails, {
        actor: 'system',
        actorRole: 'system',
        action: 'sync.failed',
        outcome: 'error',
        source: 'cron',
        correlationId: newCorrelationId(),
      }),
    ).toThrow(/simulated DB failure/);

    // The stdout copy still went out (FR-AUD-6's "independent copy" survives a DB failure).
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    // The failure was logged at error level...
    expect(errorSpy).toHaveBeenCalled();
    // ...and is surfaceable (future admin dashboard attention panel).
    const failures = getAuditWriteFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0].message).toMatch(/simulated DB failure/);
  });
});

describe('writeAuditRow — never logs secrets, even smuggled in via detail (FR-AUD-11)', () => {
  it('a real-looking secret from config.secrets never appears in the persisted row or the stdout line', async () => {
    const secretValue = 'REAL-RADARR-API-KEY-should-never-leak-9f8e7d';
    process.env.RADARR_API_KEY = secretValue;
    _resetConfigCacheForTests();

    const db = getDb();
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    writeAuditRow(db, {
      actor: 'system',
      actorRole: 'system',
      action: 'delete.failed',
      targetType: 'title',
      targetId: 'movie:7',
      outcome: 'error',
      source: 'ui',
      correlationId: newCorrelationId(),
      // Simulates an upstream error body that happens to echo the API key back —
      // exactly the "smuggled secret" scenario FR-AUD-11 exists for.
      detail: { arrStatus: 401, arrBody: `Unauthorized: key ${secretValue} rejected` },
    });

    const [line] = stdoutSpy.mock.calls[0] as [string];
    expect(line).not.toContain(secretValue);

    const rows = db.select().from(audit).all();
    const persisted = rows[rows.length - 1];
    expect(persisted.detail).not.toContain(secretValue);
    expect(JSON.stringify(persisted)).not.toContain(secretValue);

    delete process.env.RADARR_API_KEY;
    _resetConfigCacheForTests();
  });
});
