import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import type { SeerrClient } from '@/lib/seerr/client';
import { MediaRequestStatus, MediaStatus, type SeerrRequest } from '@/lib/seerr/types';

/**
 * `runAttributionSync` (`@/lib/attribution/sync.ts`) — the impure shell
 * around the pure core (`test/attribution-compute.test.ts`). Covers the
 * DB-touching contract: claim persistence, `sync_run` bookkeeping, and —
 * the correctness bar this task calls out explicitly — `FR-ACCT-10`'s
 * "a stale source must never silently reduce someone's usage to zero."
 * Fixtures only, never a live service.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-attribution-sync-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const { getDb } = await import('@/lib/db');
const { audit, claim, member, syncRun, title } = await import('@/lib/db/schema');
const { runAttributionSync } = await import('@/lib/attribution/sync');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seerrWith(requests: SeerrRequest[]): SeerrClient {
  return { listAllRequests: async () => requests } as unknown as SeerrClient;
}

function seerrThatFails(message: string): SeerrClient {
  return {
    listAllRequests: async () => {
      throw new Error(message);
    },
  } as unknown as SeerrClient;
}

function fakeRequest(overrides: Partial<SeerrRequest> & { id: number; requestedById: number }): SeerrRequest {
  const { requestedById, ...rest } = overrides;
  return {
    status: MediaRequestStatus.COMPLETED,
    createdAt: '2026-08-24T12:00:00.000Z',
    updatedAt: '2026-08-24T12:00:00.000Z',
    type: 'movie',
    is4k: false,
    isAutoRequest: false,
    media: { id: 1, mediaType: 'movie', tmdbId: 100, tvdbId: null, status: MediaStatus.AVAILABLE, status4k: null, jellyfinMediaId: null },
    seasons: [],
    requestedBy: { id: requestedById, email: null, jellyfinUsername: null, jellyfinUserId: null, displayName: null },
    ...rest,
  };
}

let nextArrId = 1;

function insertMovieTitle(id: string, tmdbId: number, sizeBytes: number, nowSeconds: number): void {
  getDb()
    .insert(title)
    .values({
      id,
      mediaType: 'movie',
      arrInstance: 'radarr',
      arrId: nextArrId++,
      tmdbId,
      tvdbId: null,
      title: id,
      year: 2020,
      sizeBytes,
      path: `/data/media/movies/${id}`,
      addedAt: nowSeconds,
      lastSyncedAt: nowSeconds,
    })
    .run();
}

function insertMember(ssoUsername: string, seerrUserId: number, nowSeconds: number): void {
  getDb()
    .insert(member)
    .values({ ssoUsername, seerrUserId, entitled: true, isOperator: false, syncStatus: 'matched', firstSeenAt: nowSeconds, lastSyncedAt: nowSeconds })
    .run();
}

describe('runAttributionSync — claim persistence (FR-ACCT-2)', () => {
  it('writes an active claim charged the title\'s full size_bytes', async () => {
    insertMovieTitle('movie:1', 900001, 12_000_000_000, 1_000_000);
    insertMember('frank', 8, 1_000_000);
    const seerr = seerrWith([fakeRequest({ id: 1, requestedById: 8, media: { id: 1, mediaType: 'movie', tmdbId: 900001, tvdbId: null, status: MediaStatus.AVAILABLE, status4k: null, jellyfinMediaId: null } })]);

    const result = await runAttributionSync({ seerr }, 2_000_000);
    expect(result.attribution).toEqual({ ok: true, count: 1, ms: expect.any(Number) });
    expect(result.fleetDistinctTitleBytes).toBe(12_000_000_000);
    expect(result.unresolved).toEqual([]);

    const row = getDb().select().from(claim).where(and(eq(claim.titleId, 'movie:1'), eq(claim.ssoUsername, 'frank'))).get();
    expect(row).toMatchObject({ titleId: 'movie:1', ssoUsername: 'frank', chargedBytes: 12_000_000_000, active: true, seerrRequestId: 1 });
  });

  it('a second co-requester of the same title gets their OWN claim at the SAME full size — frank\'s claim is untouched (FR-ACCT-7)', async () => {
    insertMovieTitle('movie:2', 248837, 156_440_000_000, 1_000_000);
    insertMember('frank2', 81, 1_000_000);
    insertMember('erin2', 82, 1_000_000);
    const seerr1 = seerrWith([fakeRequest({ id: 10, requestedById: 81, media: { id: 2, mediaType: 'movie', tmdbId: 248837, tvdbId: null, status: MediaStatus.AVAILABLE, status4k: null, jellyfinMediaId: null } })]);
    await runAttributionSync({ seerr: seerr1 }, 2_000_000);
    const frankBefore = getDb().select().from(claim).where(and(eq(claim.titleId, 'movie:2'), eq(claim.ssoUsername, 'frank2'))).get();

    const seerr2 = seerrWith([
      fakeRequest({ id: 10, requestedById: 81, media: { id: 2, mediaType: 'movie', tmdbId: 248837, tvdbId: null, status: MediaStatus.AVAILABLE, status4k: null, jellyfinMediaId: null } }),
      fakeRequest({ id: 11, requestedById: 82, media: { id: 2, mediaType: 'movie', tmdbId: 248837, tvdbId: null, status: MediaStatus.AVAILABLE, status4k: null, jellyfinMediaId: null } }),
    ]);
    await runAttributionSync({ seerr: seerr2 }, 3_000_000);

    const frankAfter = getDb().select().from(claim).where(and(eq(claim.titleId, 'movie:2'), eq(claim.ssoUsername, 'frank2'))).get();
    const erinAfter = getDb().select().from(claim).where(and(eq(claim.titleId, 'movie:2'), eq(claim.ssoUsername, 'erin2'))).get();
    expect(frankAfter?.chargedBytes).toBe(frankBefore?.chargedBytes);
    expect(frankAfter?.chargedBytes).toBe(156_440_000_000);
    expect(erinAfter?.chargedBytes).toBe(156_440_000_000);
  });

  it('a claim whose backing request no longer resolves (e.g. request removed) is deactivated, not deleted', async () => {
    insertMovieTitle('movie:3', 300, 1_000_000, 1_000_000);
    insertMember('carol2', 83, 1_000_000);
    const seerrWithReq = seerrWith([fakeRequest({ id: 20, requestedById: 83, media: { id: 3, mediaType: 'movie', tmdbId: 300, tvdbId: null, status: MediaStatus.AVAILABLE, status4k: null, jellyfinMediaId: null } })]);
    await runAttributionSync({ seerr: seerrWithReq }, 2_000_000);
    const before = getDb().select().from(claim).where(and(eq(claim.titleId, 'movie:3'), eq(claim.ssoUsername, 'carol2'))).get();
    expect(before?.active).toBe(true);

    await runAttributionSync({ seerr: seerrWith([]) }, 3_000_000);
    const after = getDb().select().from(claim).where(and(eq(claim.titleId, 'movie:3'), eq(claim.ssoUsername, 'carol2'))).get();
    expect(after?.active).toBe(false);
    expect(after?.releasedAt).toBeNull(); // a system deactivation, never a member "release" (D-6)
  });
});

describe('runAttributionSync — FR-ACCT-4: unresolved requests', () => {
  it('a request whose tmdbId matches no title is surfaced in `unresolved`, contributes zero, and never blocks the resolvable ones', async () => {
    insertMovieTitle('movie:4', 400, 1_000_000, 1_000_000);
    insertMember('erin3', 84, 1_000_000);
    const seerr = seerrWith([
      fakeRequest({ id: 30, requestedById: 84, media: { id: 4, mediaType: 'movie', tmdbId: 400, tvdbId: null, status: MediaStatus.AVAILABLE, status4k: null, jellyfinMediaId: null } }),
      fakeRequest({ id: 31, requestedById: 84, media: { id: 5, mediaType: 'movie', tmdbId: 999, tvdbId: null, status: MediaStatus.AVAILABLE, status4k: null, jellyfinMediaId: null } }),
    ]);
    const result = await runAttributionSync({ seerr }, 2_000_000);
    expect(result.unresolved).toEqual([{ seerrRequestId: 31, ssoUsername: 'erin3', mediaType: 'movie', tmdbId: 999, tvdbId: null, reason: 'no_matching_title' }]);
    const row = getDb().select().from(claim).where(and(eq(claim.titleId, 'movie:4'), eq(claim.ssoUsername, 'erin3'))).get();
    expect(row).toBeDefined();
  });

  it('persists unresolvedCount/unmatchedRequesterCount onto the `attribution` sync_run.steps entry (FR-ACCT-4: "visible to the operator", durably) — matching the shape src/components/admin/logic.ts\'s readAttributionStepExtras reads', async () => {
    insertMovieTitle('movie:4b', 401, 1_000_000, 1_000_000);
    insertMember('erin3b', 841, 1_000_000);
    const seerr = seerrWith([
      fakeRequest({ id: 32, requestedById: 841, media: { id: 4, mediaType: 'movie', tmdbId: 401, tvdbId: null, status: MediaStatus.AVAILABLE, status4k: null, jellyfinMediaId: null } }),
      fakeRequest({ id: 33, requestedById: 841, media: { id: 5, mediaType: 'movie', tmdbId: 998, tvdbId: null, status: MediaStatus.AVAILABLE, status4k: null, jellyfinMediaId: null } }),
      // requestedById 9999 matches no member row at all -> unmatchedRequesters.
      fakeRequest({ id: 34, requestedById: 9999, media: { id: 6, mediaType: 'movie', tmdbId: 401, tvdbId: null, status: MediaStatus.AVAILABLE, status4k: null, jellyfinMediaId: null } }),
    ]);
    const result = await runAttributionSync({ seerr }, 2_000_000);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unmatchedRequesters).toHaveLength(1);

    const runRow = getDb().select().from(syncRun).where(eq(syncRun.id, result.syncRunId)).get();
    const steps = JSON.parse(runRow!.steps) as { attribution: { unresolvedCount?: number; unmatchedRequesterCount?: number } };
    expect(steps.attribution.unresolvedCount).toBe(1);
    expect(steps.attribution.unmatchedRequesterCount).toBe(1);
  });

  it('does NOT write unresolvedCount/unmatchedRequesterCount when the attribution step was skipped (Seerr unreachable) — never a misleading 0', async () => {
    const result = await runAttributionSync({ seerr: seerrThatFails('ECONNREFUSED seerr:5055') }, 2_100_000);
    const runRow = getDb().select().from(syncRun).where(eq(syncRun.id, result.syncRunId)).get();
    const steps = JSON.parse(runRow!.steps) as { attribution: { unresolvedCount?: number; unmatchedRequesterCount?: number } };
    expect(steps.attribution.unresolvedCount).toBeUndefined();
    expect(steps.attribution.unmatchedRequesterCount).toBeUndefined();
  });
});

describe('runAttributionSync — FR-ACCT-10: partial upstream tolerance', () => {
  it('Seerr unreachable: attribution is skipped entirely — existing claims are left COMPLETELY untouched, never zeroed or deactivated', async () => {
    insertMovieTitle('movie:5', 500, 20_000_000_000, 1_000_000);
    insertMember('dana2', 85, 1_000_000);
    const good = seerrWith([fakeRequest({ id: 40, requestedById: 85, media: { id: 6, mediaType: 'movie', tmdbId: 500, tvdbId: null, status: MediaStatus.AVAILABLE, status4k: null, jellyfinMediaId: null } })]);
    await runAttributionSync({ seerr: good }, 2_000_000);
    const before = getDb().select().from(claim).where(and(eq(claim.titleId, 'movie:5'), eq(claim.ssoUsername, 'dana2'))).get();
    expect(before?.active).toBe(true);
    expect(before?.chargedBytes).toBe(20_000_000_000);

    const result = await runAttributionSync({ seerr: seerrThatFails('ECONNREFUSED seerr:5055') }, 3_000_000);
    expect(result.requests.ok).toBe(false);
    expect(result.attribution.ok).toBe(false);

    // The exact failure the project's design warns about: usage must NEVER drop to 0 on a stale source.
    const after = getDb().select().from(claim).where(and(eq(claim.titleId, 'movie:5'), eq(claim.ssoUsername, 'dana2'))).get();
    expect(after?.active).toBe(true);
    expect(after?.chargedBytes).toBe(20_000_000_000);

    // sync.failed audit row recorded.
    const auditRows = getDb().select().from(audit).where(eq(audit.action, 'sync.failed')).all();
    expect(auditRows.length).toBeGreaterThan(0);
  });

  it('a title whose SIZE went stale from an earlier Sonarr outage (last_synced_at old, size_bytes unchanged, never zeroed) is still charged at its last-known size — no special-casing needed here, because this step only ever reads the CURRENT title row', async () => {
    // Simulates library/sync.ts's own documented behaviour on a Sonarr outage:
    // the title row is simply never touched (size_bytes stays whatever it
    // was, last_synced_at does not advance) — attribution just reads it.
    getDb()
      .insert(title)
      .values({
        id: 'series:99',
        mediaType: 'tv',
        arrInstance: 'sonarr',
        arrId: nextArrId++,
        tmdbId: null,
        tvdbId: 900101,
        title: 'Example Series A',
        year: 2006,
        sizeBytes: 176_321_392_504,
        path: '/data/media/tv/Example Series A',
        addedAt: 1_000_000,
        lastSyncedAt: 1_000_000, // STALE — far older than this run's nowSeconds
      })
      .run();
    insertMember('erin4', 86, 1_000_000);
    const seerr = seerrWith([
      fakeRequest({
        id: 50,
        requestedById: 86,
        type: 'tv',
        media: { id: 99, mediaType: 'tv', tmdbId: null, tvdbId: 900101, status: MediaStatus.AVAILABLE, status4k: null, jellyfinMediaId: null },
      }),
    ]);
    const result = await runAttributionSync({ seerr }, 9_000_000);
    const row = getDb().select().from(claim).where(and(eq(claim.titleId, 'series:99'), eq(claim.ssoUsername, 'erin4'))).get();
    expect(row?.chargedBytes).toBe(176_321_392_504); // last-known size, NOT zero
    expect(result.fleetDistinctTitleBytes).toBeGreaterThanOrEqual(176_321_392_504);
  });
});

describe('runAttributionSync — no false invariant.violated rows on a normal run', () => {
  it('a healthy run writes zero invariant.violated audit rows', async () => {
    insertMovieTitle('movie:6', 600, 1_000_000, 1_000_000);
    insertMember('jack2', 87, 1_000_000);
    const seerr = seerrWith([fakeRequest({ id: 60, requestedById: 87, media: { id: 6, mediaType: 'movie', tmdbId: 600, tvdbId: null, status: MediaStatus.AVAILABLE, status4k: null, jellyfinMediaId: null } })]);
    await runAttributionSync({ seerr }, 2_000_000);
    const rows = getDb().select().from(audit).where(eq(audit.action, 'invariant.violated')).all();
    expect(rows).toEqual([]);
  });
});

describe('runAttributionSync — sync_run bookkeeping', () => {
  it('writes one sync_run row with both "requests" and "attribution" step keys', async () => {
    insertMovieTitle('movie:7', 700, 1_000_000, 1_000_000);
    insertMember('frank3', 88, 1_000_000);
    const seerr = seerrWith([fakeRequest({ id: 70, requestedById: 88, media: { id: 7, mediaType: 'movie', tmdbId: 700, tvdbId: null, status: MediaStatus.AVAILABLE, status4k: null, jellyfinMediaId: null } })]);
    const result = await runAttributionSync({ seerr }, 2_000_000);
    const runRow = getDb().select().from(syncRun).where(eq(syncRun.id, result.syncRunId)).get();
    expect(runRow?.ok).toBe(true);
    const steps = JSON.parse(runRow!.steps) as Record<string, { ok: boolean }>;
    expect(Object.keys(steps).sort()).toEqual(['attribution', 'requests']);
  });
});
