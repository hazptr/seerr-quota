import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import type { RadarrClient, RadarrMovie } from '@/lib/library/radarr';
import type { SonarrClient, SonarrSeries } from '@/lib/library/sonarr';
import type { SonarrEpisodeFile, SonarrEpisodeFileClient } from '@/lib/library/sonarrEpisodeFiles';

// Isolated throwaway DB file — same pattern as app/test/db.test.ts and
// a comparable project's roster-refresh test. Must be set BEFORE `@/lib/db`
// (transitively imported by `@/lib/library/sync`) is imported.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-library-sync-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const { getDb } = await import('@/lib/db');
const { title } = await import('@/lib/db/schema');
const { syncLibrary } = await import('@/lib/library/sync');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function radarrWith(movies: RadarrMovie[]): RadarrClient {
  return { listMovies: async () => movies } as unknown as RadarrClient;
}

function sonarrWith(series: SonarrSeries[]): SonarrClient {
  return { listSeries: async () => series } as unknown as SonarrClient;
}

function radarrThatFails(message: string): RadarrClient {
  return {
    listMovies: async () => {
      throw new Error(message);
    },
  } as unknown as RadarrClient;
}

function sonarrThatFails(message: string): SonarrClient {
  return {
    listSeries: async () => {
      throw new Error(message);
    },
  } as unknown as SonarrClient;
}

/**
 * Every series in this file is unsplit (`split_into_seasons` defaults
 * `false`) unless a test explicitly flips it — so this stub, used
 * throughout the existing (regression) test cases below, doubles as an
 * explicit assertion that Wave 1 makes ZERO extra Sonarr calls for the
 * unsplit case: if `syncLibrary` ever called `listEpisodeFiles` for an
 * unsplit series, every pre-existing test in this file would fail loudly
 * here instead of silently passing.
 */
function sonarrEpisodeFilesThatThrowsIfCalled(): SonarrEpisodeFileClient {
  return {
    listEpisodeFiles: async () => {
      throw new Error('listEpisodeFiles must not be called for an unsplit series (P4-1 Wave 1 regression)');
    },
  } as unknown as SonarrEpisodeFileClient;
}

function sonarrEpisodeFilesWith(files: SonarrEpisodeFile[]): SonarrEpisodeFileClient {
  return { listEpisodeFiles: async () => files } as unknown as SonarrEpisodeFileClient;
}

/** Records every `seriesId` `listEpisodeFiles` was actually called with — for asserting it's NOT called for a still-unsplit series sharing a sync run with a split one. */
function sonarrEpisodeFilesRecording(filesBySeriesId: Record<number, SonarrEpisodeFile[]>): {
  client: SonarrEpisodeFileClient;
  calledWith: number[];
} {
  const calledWith: number[] = [];
  const client = {
    listEpisodeFiles: async (seriesId: number) => {
      calledWith.push(seriesId);
      return filesBySeriesId[seriesId] ?? [];
    },
  } as unknown as SonarrEpisodeFileClient;
  return { client, calledWith };
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

describe('syncLibrary — upserts into `title`', () => {
  it('writes a movie row keyed movie:{radarrId}, arr_instance radarr', async () => {
    const result = await syncLibrary(radarrWith([MOVIE_A]), sonarrWith([]), sonarrEpisodeFilesThatThrowsIfCalled(), 1_000_000);
    expect(result.movies).toEqual({ ok: true, count: 1, ms: expect.any(Number) });
    const row = getDb().select().from(title).where(eq(title.id, 'movie:5')).get();
    expect(row).toMatchObject({
      id: 'movie:5',
      mediaType: 'movie',
      arrInstance: 'radarr',
      arrId: 5,
      tmdbId: 900001,
      tvdbId: null,
      title: 'Example Movie A',
      sizeBytes: 15589124313,
      path: '/data/media/movies/Example Movie A (2023)',
      lastSyncedAt: 1_000_000,
    });
  });

  it('writes a series row keyed series:{sonarrId}, arr_instance sonarr, sizeBytes from statistics.sizeOnDisk', async () => {
    const result = await syncLibrary(radarrWith([]), sonarrWith([SERIES_A]), sonarrEpisodeFilesThatThrowsIfCalled(), 1_000_000);
    expect(result.series).toEqual({ ok: true, count: 1, ms: expect.any(Number) });
    const row = getDb().select().from(title).where(eq(title.id, 'series:3')).get();
    expect(row).toMatchObject({
      id: 'series:3',
      mediaType: 'tv',
      arrInstance: 'sonarr',
      arrId: 3,
      tmdbId: null,
      tvdbId: 900101,
      sizeBytes: 176321392504,
    });
  });

  it('re-running with an updated size_bytes updates the existing row without touching the operator protected pin', async () => {
    await syncLibrary(radarrWith([MOVIE_A]), sonarrWith([]), sonarrEpisodeFilesThatThrowsIfCalled(), 2_000_000);
    // Operator pins the title (D-6) — a later sync must never clobber this.
    getDb().update(title).set({ protected: true, protectedReason: 'operator keeps forever' }).where(eq(title.id, 'movie:5')).run();

    const grownMovie: RadarrMovie = { ...MOVIE_A, sizeOnDisk: MOVIE_A.sizeOnDisk + 1000 };
    await syncLibrary(radarrWith([grownMovie]), sonarrWith([]), sonarrEpisodeFilesThatThrowsIfCalled(), 3_000_000);

    const row = getDb().select().from(title).where(eq(title.id, 'movie:5')).get();
    expect(row?.sizeBytes).toBe(MOVIE_A.sizeOnDisk + 1000);
    expect(row?.lastSyncedAt).toBe(3_000_000);
    expect(row?.protected).toBe(true);
    expect(row?.protectedReason).toBe('operator keeps forever');
  });

  it('a title absent from the latest fetch is left completely untouched (not deleted, last_synced_at not advanced — the staleness signal)', async () => {
    await syncLibrary(radarrWith([MOVIE_A]), sonarrWith([SERIES_A]), sonarrEpisodeFilesThatThrowsIfCalled(), 4_000_000);
    // Next sync: MOVIE_A vanished from Radarr's response (e.g. deleted outside this app).
    await syncLibrary(radarrWith([]), sonarrWith([SERIES_A]), sonarrEpisodeFilesThatThrowsIfCalled(), 5_000_000);

    const row = getDb().select().from(title).where(eq(title.id, 'movie:5')).get();
    expect(row).toBeDefined(); // still present — not deleted
    expect(row?.lastSyncedAt).toBe(4_000_000); // unchanged — this IS the staleness signal
    expect(row?.sizeBytes).toBe(MOVIE_A.sizeOnDisk); // not zeroed
  });
});

describe('syncLibrary — failure isolation (FR-ACCT-10)', () => {
  it('Sonarr unreachable: movie sync still succeeds; series step reports ok:false with an error; no exception propagates', async () => {
    const result = await syncLibrary(radarrWith([MOVIE_A]), sonarrThatFails('connect ECONNREFUSED sonarr:8989'), sonarrEpisodeFilesThatThrowsIfCalled(), 6_000_000);
    expect(result.movies).toEqual({ ok: true, count: 1, ms: expect.any(Number) });
    expect(result.series.ok).toBe(false);
    expect(result.series.count).toBe(0);
    expect(result.series.error).toContain('ECONNREFUSED');

    const movieRow = getDb().select().from(title).where(eq(title.id, 'movie:5')).get();
    expect(movieRow).toBeDefined();
    expect(movieRow?.lastSyncedAt).toBe(6_000_000);
  });

  it('a pre-existing Sonarr-sourced title goes stale (untouched) rather than zeroed when Sonarr is down, while Radarr keeps updating', async () => {
    // Seed a previously-successful sync for both sources.
    await syncLibrary(radarrWith([MOVIE_A]), sonarrWith([SERIES_A]), sonarrEpisodeFilesThatThrowsIfCalled(), 7_000_000);

    // This run: Sonarr is down, but Radarr reports a size change.
    const grownMovie: RadarrMovie = { ...MOVIE_A, sizeOnDisk: MOVIE_A.sizeOnDisk + 42 };
    await syncLibrary(radarrWith([grownMovie]), sonarrThatFails('timeout'), sonarrEpisodeFilesThatThrowsIfCalled(), 8_000_000);

    const movieRow = getDb().select().from(title).where(eq(title.id, 'movie:5')).get();
    expect(movieRow?.sizeBytes).toBe(MOVIE_A.sizeOnDisk + 42);
    expect(movieRow?.lastSyncedAt).toBe(8_000_000);

    const seriesRow = getDb().select().from(title).where(eq(title.id, 'series:3')).get();
    expect(seriesRow).toBeDefined(); // still present, not deleted
    expect(seriesRow?.sizeBytes).toBe(SERIES_A.sizeOnDisk); // not zeroed
    expect(seriesRow?.lastSyncedAt).toBe(7_000_000); // stale — did not advance to 8_000_000
  });

  it('both Radarr and Sonarr unreachable: syncLibrary itself does not throw, and both steps report ok:false', async () => {
    const result = await syncLibrary(radarrThatFails('radarr down'), sonarrThatFails('sonarr down'), sonarrEpisodeFilesThatThrowsIfCalled(), 9_000_000);
    expect(result.movies.ok).toBe(false);
    expect(result.series.ok).toBe(false);
    expect(result.movies.error).toBe('radarr down');
    expect(result.series.error).toBe('sonarr down');
  });
});

// ---------------------------------------------------------------------------
// P4-1 Wave 1 — season title rows, additive and gated off by default.
// Every case above this point is the non-regression proof for the unsplit
// (today's real) case: each already uses `sonarrEpisodeFilesThatThrowsIfCalled()`,
// so if this wave's code ever called `listEpisodeFiles` for an unsplit
// series, every test above would fail loudly instead of silently passing.
// This block covers the split case itself — simulated by flipping
// `split_into_seasons` directly in the DB, since Wave 1 ships no trigger
// action for it (that's a later wave).
// ---------------------------------------------------------------------------
describe('syncLibrary — P4-1 Wave 1: season rows for a split series', () => {
  it('regression: an unsplit series (the default for every series today) writes no season rows and never calls listEpisodeFiles', async () => {
    await syncLibrary(radarrWith([]), sonarrWith([SERIES_A]), sonarrEpisodeFilesThatThrowsIfCalled(), 10_000_000);

    const wholeSeriesRow = getDb().select().from(title).where(eq(title.id, 'series:3')).get();
    expect(wholeSeriesRow?.splitIntoSeasons).toBe(false);
    const seasonRow = getDb().select().from(title).where(eq(title.id, 'series:3:s1')).get();
    expect(seasonRow).toBeUndefined();
  });

  it('a series with split_into_seasons=true additionally upserts one series:{id}:s{n} row per season, sized from real per-file bytes, while the whole-series row keeps syncing untouched', async () => {
    // First sync creates the whole-series row, unsplit (the only state
    // Wave 1 itself can produce).
    await syncLibrary(radarrWith([]), sonarrWith([SERIES_A]), sonarrEpisodeFilesThatThrowsIfCalled(), 11_000_000);

    // Simulates the state a later wave's operator-triggered split action
    // would produce — Wave 1 ships no such trigger.
    getDb().update(title).set({ splitIntoSeasons: true }).where(eq(title.id, 'series:3')).run();

    const files: SonarrEpisodeFile[] = [
      { id: 1, seriesId: 3, seasonNumber: 1, size: 60_000_000_000, dateAdded: null },
      { id: 2, seriesId: 3, seasonNumber: 1, size: 56_321_392_504, dateAdded: null },
      { id: 3, seriesId: 3, seasonNumber: 2, size: 60_000_000_000, dateAdded: null },
    ];
    // The whole-series number drifts slightly from the sum of these files on
    // this sync (a realistic re-sync) — proves season sizing comes from the
    // per-file aggregation, not derived from the whole-series total.
    const grownSeries: SonarrSeries = { ...SERIES_A, sizeOnDisk: SERIES_A.sizeOnDisk + 1 };

    const result = await syncLibrary(radarrWith([]), sonarrWith([grownSeries]), sonarrEpisodeFilesWith(files), 12_000_000);
    expect(result.series).toEqual({ ok: true, count: 1, ms: expect.any(Number) });

    const s1 = getDb().select().from(title).where(eq(title.id, 'series:3:s1')).get();
    expect(s1).toMatchObject({
      id: 'series:3:s1',
      mediaType: 'tv',
      arrInstance: 'sonarr',
      arrId: 3, // same Sonarr-side id as the parent — Wave 4 resolves the actual per-season delete target
      tmdbId: null,
      tvdbId: SERIES_A.tvdbId,
      title: 'Example Series A — Season 1',
      path: SERIES_A.path, // Sonarr gives no per-season path (P4-1a §Q2); reuse the parent's
      sizeBytes: 60_000_000_000 + 56_321_392_504, // hand-calculated sum of season 1's two files
      lastSyncedAt: 12_000_000,
    });

    const s2 = getDb().select().from(title).where(eq(title.id, 'series:3:s2')).get();
    expect(s2).toMatchObject({
      id: 'series:3:s2',
      title: 'Example Series A — Season 2',
      tvdbId: SERIES_A.tvdbId,
      sizeBytes: 60_000_000_000, // its one file
    });

    // The whole-series row is never deleted, and Wave 1 keeps syncing it
    // normally — exclusion from attribution/fleet totals is a later wave's
    // rule, not this column's job alone.
    const wholeSeriesRow = getDb().select().from(title).where(eq(title.id, 'series:3')).get();
    expect(wholeSeriesRow?.sizeBytes).toBe(grownSeries.sizeOnDisk);
    expect(wholeSeriesRow?.lastSyncedAt).toBe(12_000_000);
    expect(wholeSeriesRow?.splitIntoSeasons).toBe(true);
  });

  it('re-syncing a split series updates existing season rows in place rather than duplicating them', async () => {
    await syncLibrary(radarrWith([]), sonarrWith([SERIES_A]), sonarrEpisodeFilesThatThrowsIfCalled(), 13_000_000);
    getDb().update(title).set({ splitIntoSeasons: true }).where(eq(title.id, 'series:3')).run();

    await syncLibrary(
      radarrWith([]),
      sonarrWith([SERIES_A]),
      sonarrEpisodeFilesWith([{ id: 1, seriesId: 3, seasonNumber: 1, size: 1_000, dateAdded: null }]),
      14_000_000,
    );
    await syncLibrary(
      radarrWith([]),
      sonarrWith([SERIES_A]),
      sonarrEpisodeFilesWith([{ id: 1, seriesId: 3, seasonNumber: 1, size: 5_000, dateAdded: null }]),
      15_000_000,
    );

    const rows = getDb().select().from(title).where(eq(title.id, 'series:3:s1')).all();
    expect(rows).toHaveLength(1); // updated in place, not duplicated
    expect(rows[0]?.sizeBytes).toBe(5_000);
    expect(rows[0]?.lastSyncedAt).toBe(15_000_000);
  });

  it('splitting one series does not affect a second, still-unsplit series synced in the same run — listEpisodeFiles is called for the split series only', async () => {
    const SERIES_B: SonarrSeries = {
      id: 7,
      tvdbId: 12345,
      title: 'Example Series B',
      year: 2011,
      path: '/data/media/tv/Example Series B',
      added: '2023-01-01T00:00:00Z',
      sizeOnDisk: 50_000_000_000,
      episodeFileCount: 80,
    };
    await syncLibrary(radarrWith([]), sonarrWith([SERIES_A, SERIES_B]), sonarrEpisodeFilesThatThrowsIfCalled(), 16_000_000);
    getDb().update(title).set({ splitIntoSeasons: true }).where(eq(title.id, 'series:3')).run();

    const { client, calledWith } = sonarrEpisodeFilesRecording({
      3: [{ id: 1, seriesId: 3, seasonNumber: 1, size: 999, dateAdded: null }],
    });
    await syncLibrary(radarrWith([]), sonarrWith([SERIES_A, SERIES_B]), client, 17_000_000);

    expect(calledWith).toEqual([3]); // only the split series (3) triggers a fetch — series 7 never does

    const seriesBRow = getDb().select().from(title).where(eq(title.id, 'series:7')).get();
    expect(seriesBRow?.splitIntoSeasons).toBe(false);
    expect(seriesBRow?.sizeBytes).toBe(SERIES_B.sizeOnDisk);
    const seriesBSeasonRow = getDb().select().from(title).where(eq(title.id, 'series:7:s1')).get();
    expect(seriesBSeasonRow).toBeUndefined();
  });
});
