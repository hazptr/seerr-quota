import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import type { RadarrClient, RadarrMovie } from '@/lib/library/radarr';
import type { SonarrClient, SonarrSeries } from '@/lib/library/sonarr';
import type { SeerrClient } from '@/lib/seerr/client';
import { MediaRequestStatus, MediaStatus, type SeerrRequest } from '@/lib/seerr/types';

/**
 * Dedicated regression test for `FR-ACCT-10` ("The reconciler MUST tolerate
 * a partial upstream failure: if Sonarr is unreachable, movie attribution
 * MUST still update, TV data MUST go stale rather than zero, and no claim
 * may be silently dropped because its source was briefly unavailable") —
 * exercised end-to-end through `runLibraryAndRequestSync`, the actual P1-5
 * entry point, with Sonarr genuinely failing and a real `sync_run` row
 * written at the end. `test/library-sync.test.ts` covers the same guarantee
 * at the `syncLibrary` unit level; this file proves the composed function
 * (the one a future scheduler will actually call) preserves it end to end,
 * including the `sync_run` bookkeeping.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-failure-isolation-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const { getDb } = await import('@/lib/db');
const { title, syncRun } = await import('@/lib/db/schema');
const { runLibraryAndRequestSync } = await import('@/lib/library/sync');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function radarrWith(movies: RadarrMovie[]): RadarrClient {
  return { listMovies: async () => movies } as unknown as RadarrClient;
}

function sonarrWith(series: SonarrSeries[]): SonarrClient {
  return { listSeries: async () => series } as unknown as SonarrClient;
}

function sonarrThatFails(message: string): SonarrClient {
  return {
    listSeries: async () => {
      throw new Error(message);
    },
  } as unknown as SonarrClient;
}

function seerrWith(requests: SeerrRequest[]): SeerrClient {
  return { listAllRequests: async () => requests } as unknown as SeerrClient;
}

const MOVIE_A: RadarrMovie = {
  id: 5,
  tmdbId: 900001,
  title: 'Example Movie A',
  year: 2023,
  hasFile: true,
  sizeOnDisk: 15589124313,
  added: '2023-09-06T15:52:33Z',
  path: '/data/media/movies/Example Movie A (2023)',
};

const SERIES_A: SonarrSeries = {
  id: 3,
  tvdbId: 900101,
  title: 'Example Series A',
  year: 2006,
  path: '/data/media/tv/Example Series A',
  added: '2023-09-07T00:57:14Z',
  sizeOnDisk: 176321392504,
  episodeFileCount: 124,
};

const REQUEST_A: SeerrRequest = {
  id: 97,
  status: MediaRequestStatus.APPROVED,
  createdAt: '2026-08-24T12:31:17.000Z',
  updatedAt: '2026-08-24T12:31:17.000Z',
  type: 'movie',
  is4k: false,
  isAutoRequest: false,
  media: { id: 195, mediaType: 'movie', tmdbId: 900001, tvdbId: null, status: MediaStatus.AVAILABLE, status4k: null, jellyfinMediaId: null },
  seasons: [],
  requestedBy: { id: 8, email: 'frank@example.com', jellyfinUsername: 'frank', jellyfinUserId: '7bbb', displayName: 'frank' },
};

describe('runLibraryAndRequestSync — FR-ACCT-10 end to end', () => {
  it('a working baseline run: all three steps ok, one sync_run row written with ok=true', async () => {
    const result = await runLibraryAndRequestSync(
      { radarr: radarrWith([MOVIE_A]), sonarr: sonarrWith([SERIES_A]), seerr: seerrWith([REQUEST_A]) },
      1_000_000,
    );
    expect(result.movies).toEqual({ ok: true, count: 1, ms: expect.any(Number) });
    expect(result.series).toEqual({ ok: true, count: 1, ms: expect.any(Number) });
    expect(result.requests).toEqual({ ok: true, count: 1, ms: expect.any(Number) });
    expect(result.requestList).toHaveLength(1);

    const runRow = getDb().select().from(syncRun).where(eq(syncRun.id, result.syncRunId)).get();
    expect(runRow?.ok).toBe(true);
    const steps = JSON.parse(runRow!.steps) as Record<string, { ok: boolean; count: number }>;
    expect(steps.movies).toMatchObject({ ok: true, count: 1 });
    expect(steps.series).toMatchObject({ ok: true, count: 1 });
    expect(steps.requests).toMatchObject({ ok: true, count: 1 });
  });

  it('Sonarr down: movie sync + request sync still succeed, series step fails, sync_run.ok is false, and TV data is left stale rather than zeroed or dropped', async () => {
    // Seed a prior good sync so there is existing TV data that could be wrongly zeroed/dropped.
    await runLibraryAndRequestSync(
      { radarr: radarrWith([MOVIE_A]), sonarr: sonarrWith([SERIES_A]), seerr: seerrWith([REQUEST_A]) },
      2_000_000,
    );

    const result = await runLibraryAndRequestSync(
      { radarr: radarrWith([MOVIE_A]), sonarr: sonarrThatFails('connect ECONNREFUSED sonarr:8989'), seerr: seerrWith([REQUEST_A]) },
      3_000_000,
    );

    // Failure isolation: movies + requests unaffected by the Sonarr outage.
    expect(result.movies.ok).toBe(true);
    expect(result.requests.ok).toBe(true);
    expect(result.series.ok).toBe(false);
    expect(result.series.error).toContain('ECONNREFUSED');

    // The overall run is honestly reported as not-fully-clean...
    const runRow = getDb().select().from(syncRun).where(eq(syncRun.id, result.syncRunId)).get();
    expect(runRow?.ok).toBe(false);

    // ...but no record was dropped: the series row from the PRIOR good run
    // is still present, with its old (now-stale) size and timestamp — never
    // deleted, never zeroed.
    const seriesRow = getDb().select().from(title).where(eq(title.id, 'series:3')).get();
    expect(seriesRow).toBeDefined();
    expect(seriesRow?.sizeBytes).toBe(SERIES_A.sizeOnDisk);
    expect(seriesRow?.lastSyncedAt).toBe(2_000_000); // stale: did not advance to 3_000_000

    // Movie attribution (the working source) DID update to the latest run.
    const movieRow = getDb().select().from(title).where(eq(title.id, 'movie:5')).get();
    expect(movieRow?.lastSyncedAt).toBe(3_000_000);
  });
});
