import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * `src/lib/audit/browse.ts` — `FR-AUD-9`'s filtered/paginated read and
 * `FR-AUD-10`'s own-scope read, plus the batched export primitive
 * (`forEachAuditRowBatch`) the project's design requires: "never build an
 * export that materialises the whole table in memory."
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-audit-browse-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const { getDb, _resetDbForTests } = await import('@/lib/db');
const { audit } = await import('@/lib/db/schema');
const { countAuditRows, countOwnAuditRows, forEachAuditRowBatch, queryAuditRowsPage, queryOwnAuditRowsPage } = await import('@/lib/audit/browse');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  _resetDbForTests();
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(`${tmpDbPath}-wal`, { force: true });
  fs.rmSync(`${tmpDbPath}-shm`, { force: true });
});

let nextId = 1;
function insertRow(overrides: Partial<{ ts: number; actor: string; actorRole: 'member' | 'operator' | 'system'; onBehalfOf: string | null; action: string; targetType: 'member' | 'title' | 'request' | 'setting' | 'route'; targetId: string; outcome: 'ok' | 'denied' | 'error'; source: 'ui' | 'webhook' | 'poller' | 'cron' | 'cli' }>): void {
  getDb()
    .insert(audit)
    .values({
      ts: overrides.ts ?? 1_800_000_000_000 + nextId,
      actor: overrides.actor ?? 'dana',
      actorRole: overrides.actorRole ?? 'member',
      onBehalfOf: overrides.onBehalfOf ?? null,
      action: overrides.action ?? 'access.denied',
      targetType: overrides.targetType ?? 'route',
      targetId: overrides.targetId ?? '/x',
      outcome: overrides.outcome ?? 'denied',
      source: overrides.source ?? 'ui',
      correlationId: `corr-${nextId}`,
    })
    .run();
  nextId += 1;
}

describe('countAuditRows / queryAuditRowsPage — FR-AUD-9 filters', () => {
  beforeEach(() => {
    insertRow({ actor: 'dana', action: 'access.denied', outcome: 'denied', targetType: 'route', targetId: '/admin' });
    insertRow({ actor: 'admin', actorRole: 'operator', action: 'quota.set', outcome: 'ok', targetType: 'member', targetId: 'dana' });
    insertRow({ actor: 'system', actorRole: 'system', action: 'sync.failed', outcome: 'error' });
  });

  it('with no filter, counts and returns every row', () => {
    expect(countAuditRows(getDb(), {})).toBe(3);
    expect(queryAuditRowsPage(getDb(), {}, 10, 0)).toHaveLength(3);
  });

  it('filters by actor', () => {
    expect(countAuditRows(getDb(), { actor: 'dana' })).toBe(1);
    const rows = queryAuditRowsPage(getDb(), { actor: 'dana' }, 10, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe('dana');
  });

  it('filters by action', () => {
    expect(countAuditRows(getDb(), { action: 'quota.set' })).toBe(1);
  });

  it('filters by outcome', () => {
    expect(countAuditRows(getDb(), { outcome: 'error' })).toBe(1);
  });

  it('filters by targetType + targetId', () => {
    expect(countAuditRows(getDb(), { targetType: 'member', targetId: 'dana' })).toBe(1);
  });

  it('filters by time range (fromTs/toTs)', () => {
    const all = queryAuditRowsPage(getDb(), {}, 10, 0);
    const midTs = Math.min(...all.map((r) => r.ts)) + 1;
    expect(countAuditRows(getDb(), { fromTs: midTs })).toBeLessThan(3);
  });

  it('combines filters with AND', () => {
    expect(countAuditRows(getDb(), { actor: 'admin', outcome: 'ok' })).toBe(1);
    expect(countAuditRows(getDb(), { actor: 'admin', outcome: 'denied' })).toBe(0);
  });
});

describe('queryAuditRowsPage — server-side pagination never returns more than one page', () => {
  beforeEach(() => {
    for (let i = 0; i < 45; i++) insertRow({ actor: 'dana', action: 'access.denied' });
  });

  it('a page never exceeds its limit, and paging through covers every row exactly once', () => {
    const pageSize = 20;
    const total = countAuditRows(getDb(), {});
    expect(total).toBe(45);

    const seenIds = new Set<number>();
    for (let offset = 0; offset < total; offset += pageSize) {
      const page = queryAuditRowsPage(getDb(), {}, pageSize, offset);
      expect(page.length).toBeLessThanOrEqual(pageSize);
      for (const row of page) {
        expect(seenIds.has(row.id)).toBe(false);
        seenIds.add(row.id);
      }
    }
    expect(seenIds.size).toBe(45);
  });
});

describe('forEachAuditRowBatch — bounded-memory export primitive', () => {
  beforeEach(() => {
    for (let i = 0; i < 23; i++) insertRow({ actor: 'dana', action: 'access.denied' });
  });

  it('never hands the callback more than batchSize rows at once, and covers every row exactly once', async () => {
    const batchSize = 10;
    const seenIds = new Set<number>();
    let maxBatchLength = 0;
    const total = await forEachAuditRowBatch(getDb(), {}, batchSize, (rows) => {
      maxBatchLength = Math.max(maxBatchLength, rows.length);
      for (const row of rows) seenIds.add(row.id);
    });
    expect(total).toBe(23);
    expect(seenIds.size).toBe(23);
    expect(maxBatchLength).toBeLessThanOrEqual(batchSize);
  });

  it('an empty filtered set calls onBatch zero times', async () => {
    let calls = 0;
    const total = await forEachAuditRowBatch(getDb(), { actor: 'nobody-like-this' }, 10, () => {
      calls += 1;
    });
    expect(total).toBe(0);
    expect(calls).toBe(0);
  });
});

describe('countOwnAuditRows / queryOwnAuditRowsPage — FR-AUD-10 scope (actor OR on_behalf_of)', () => {
  beforeEach(() => {
    insertRow({ actor: 'dana', action: 'delete.requested' });
    insertRow({ actor: 'admin', actorRole: 'operator', onBehalfOf: 'dana', action: 'delete.requested' });
    insertRow({ actor: 'frank', action: 'delete.requested' }); // a different member entirely
    insertRow({ actor: 'admin', actorRole: 'operator', onBehalfOf: 'frank', action: 'delete.requested' });
  });

  it('includes rows where the member is the actor', () => {
    expect(countOwnAuditRows(getDb(), 'dana')).toBeGreaterThanOrEqual(1);
    const rows = queryOwnAuditRowsPage(getDb(), 'dana', 10, 0);
    expect(rows.some((r) => r.actor === 'dana')).toBe(true);
  });

  it('includes rows where the member is the on_behalf_of target', () => {
    const rows = queryOwnAuditRowsPage(getDb(), 'dana', 10, 0);
    expect(rows.some((r) => r.onBehalfOf === 'dana')).toBe(true);
  });

  it('excludes another members rows entirely (neither actor nor on_behalf_of)', () => {
    const rows = queryOwnAuditRowsPage(getDb(), 'dana', 10, 0);
    expect(rows.some((r) => r.actor === 'frank' || r.onBehalfOf === 'frank')).toBe(false);
    expect(countOwnAuditRows(getDb(), 'dana')).toBe(2);
  });
});
