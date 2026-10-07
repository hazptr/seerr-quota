import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { SeerrClient } from '@/lib/seerr/client';
import { MediaRequestStatus } from '@/lib/seerr/types';
import type { EnforcementSeerrActions } from '@/lib/enforcement/seerrActions';

// Isolated throwaway DB file — same pattern as the other enforcement tests.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-enforcement-poller-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const { getDb, _resetDbForTests } = await import('@/lib/db');
const { member, quotaPolicy, syncRun } = await import('@/lib/db/schema');
const { _resetConfigCacheForTests } = await import('@/lib/config');
const { runPendingSweep } = await import('@/lib/enforcement/poller');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const NOW = 1_800_000_000;

beforeEach(() => {
  _resetDbForTests();
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(`${tmpDbPath}-wal`, { force: true });
  fs.rmSync(`${tmpDbPath}-shm`, { force: true });
  process.env.ENFORCEMENT_ENABLED = 'true';
  _resetConfigCacheForTests();
});

function seedMember(ssoUsername: string, seerrUserId: number, quotaBytes: number): void {
  const db = getDb();
  db.insert(member)
    .values({
      ssoUsername,
      authentikUuid: null,
      displayName: ssoUsername,
      email: `${ssoUsername}@example.com`,
      entitled: true,
      isOperator: false,
      seerrUserId,
      jellyfinUserId: null,
      syncStatus: 'matched',
      syncNote: null,
      firstSeenAt: NOW - 1000,
      lastSyncedAt: NOW - 10,
    })
    .run();
  db.insert(quotaPolicy)
    .values({ ssoUsername, quotaBytes, source: 'default', note: null, updatedAt: NOW - 10, updatedBy: 'system' })
    .run();
}

function seedFreshSnapshot(): void {
  getDb()
    .insert(syncRun)
    .values({ startedAt: NOW - 35, finishedAt: NOW - 30, steps: JSON.stringify({ attribution: { ok: true, count: 0, ms: 5 } }), ok: true })
    .run();
}

interface PendingRow {
  id: number;
  requestedBySeerrUserId: number;
}

/** A fake `SeerrClient` satisfying only `listRequestsPage` — mirrors `test/library-sync.test.ts`'s `as unknown as` fake-client pattern. */
function fakeSeerrList(pages: PendingRow[][]): { client: SeerrClient; calls: number } {
  let callIndex = 0;
  const client = {
    async listRequestsPage(opts: { take: number; skip: number }) {
      const page = pages[callIndex] ?? [];
      callIndex += 1;
      const totalResults = pages.flat().length;
      return {
        pageInfo: { pages: pages.length, pageSize: opts.take, results: totalResults, page: callIndex },
        results: page.map((p) => ({
          id: p.id,
          status: MediaRequestStatus.PENDING,
          createdAt: '2026-08-24T00:00:00.000Z',
          updatedAt: '2026-08-24T00:00:00.000Z',
          type: 'movie' as const,
          is4k: false,
          isAutoRequest: false,
          media: { id: 1, mediaType: 'movie' as const, tmdbId: 1, tvdbId: null, status: 2, status4k: null, jellyfinMediaId: null },
          seasons: [],
          requestedBy: { id: p.requestedBySeerrUserId, email: null, jellyfinUsername: null, jellyfinUserId: null, displayName: null },
        })),
      };
    },
  };
  return { client: client as unknown as SeerrClient, calls: callIndex };
}

function fakeSeerrThatFails(message: string): SeerrClient {
  return {
    async listRequestsPage() {
      throw new Error(message);
    },
  } as unknown as SeerrClient;
}

function fakeSeerrActionsFor(pending: PendingRow[]): EnforcementSeerrActions {
  const calls = { approveRequest: 0 };
  const client = {
    async getRequestById(id: number) {
      const row = pending.find((p) => p.id === id);
      if (!row) throw new Error(`no fixture for request ${id}`);
      return { id: row.id, status: MediaRequestStatus.PENDING, requestedBySeerrUserId: row.requestedBySeerrUserId };
    },
    async approveRequest() {
      calls.approveRequest += 1;
    },
    async declineRequest() {
      /* not exercised in these tests */
    },
  };
  return client as unknown as EnforcementSeerrActions;
}

describe('runPendingSweep — reconciler step 6, "Pending sweep"', () => {
  it('fetches every pending request across pages and decides each one, recording a sync_run row', async () => {
    seedMember('frank', 8, 500);
    seedMember('erin', 9, 500);
    seedFreshSnapshot();
    const pending: PendingRow[] = [
      { id: 401, requestedBySeerrUserId: 8 },
      { id: 402, requestedBySeerrUserId: 9 },
    ];
    const { client: seerr } = fakeSeerrList([pending]);
    const seerrActions = fakeSeerrActionsFor(pending);

    const result = await runPendingSweep({ seerr, processDeps: { seerrActions } }, NOW);

    expect(result.sweep).toEqual({ ok: true, count: 2, ms: expect.any(Number) });
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes.every((o) => o.kind === 'decided')).toBe(true);

    const runRow = getDb().select().from(syncRun).where(eq(syncRun.id, result.syncRunId)).get();
    expect(runRow).toBeDefined();
    const steps = JSON.parse(runRow!.steps);
    expect(steps.pending_sweep).toEqual({ ok: true, count: 2, ms: expect.any(Number) });
    expect(runRow!.ok).toBe(true);
  });

  it('Seerr down during the sweep: sweep step fails, nothing is decided, sync_run recorded ok=false (D-4a edge case: "poller fails in isolation, requests stay pending")', async () => {
    const result = await runPendingSweep({ seerr: fakeSeerrThatFails('ECONNREFUSED jellyseerr:5055') }, NOW);

    expect(result.sweep.ok).toBe(false);
    expect(result.sweep.error).toContain('ECONNREFUSED');
    expect(result.outcomes).toEqual([]);

    const runRow = getDb().select().from(syncRun).where(eq(syncRun.id, result.syncRunId)).get();
    expect(runRow!.ok).toBe(false);
  });

  it('paginates through multiple pages of pending requests', async () => {
    seedMember('frank', 8, 500);
    seedFreshSnapshot();
    const pageOne: PendingRow[] = [{ id: 501, requestedBySeerrUserId: 8 }];
    const pageTwo: PendingRow[] = [{ id: 502, requestedBySeerrUserId: 8 }];
    const { client: seerr } = fakeSeerrList([pageOne, pageTwo]);
    const seerrActions = fakeSeerrActionsFor([...pageOne, ...pageTwo]);

    const result = await runPendingSweep({ seerr, processDeps: { seerrActions } }, NOW);

    expect(result.sweep.count).toBe(2);
    expect(result.outcomes.map((o) => o.seerrRequestId).sort()).toEqual([501, 502]);
  });
});
