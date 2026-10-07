import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import type { JellyfinEpisodeItem, JellyfinMovieItem, JellyfinPlaybackSource, JellyfinSeriesItem, JellyfinUserPlayback } from '@/lib/jellyfin/types';

/**
 * `syncPlayback`/`runPlaybackSync` tests — against fixture data only (an
 * injected fake `JellyfinPlaybackSource`), never a live service, per this
 * task's instructions. Covers:
 *   - the core FR-ACCT-6 rule ("a series counts as played if ANY episode has
 *     been played by that user"),
 *   - the join being on tmdb/tvdb ids (not `jellyfinMediaId`),
 *   - and — the correctness bar this task calls out explicitly — that a
 *     Jellyfin outage (or a title simply not matching this run) leaves
 *     playback data STALE, never zeroed, and never flips `watched_by_anyone`
 *     from true to false.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-playback-sync-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const { getDb } = await import('@/lib/db');
const { playback, syncRun, title } = await import('@/lib/db/schema');
const { runPlaybackSync, syncPlayback } = await import('@/lib/playback/sync');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Builds a `JellyfinUserPlayback` with `played`/`positionTicks` defaults (`false`/`0`) so existing fixtures only need to name what they're actually testing — override either field explicitly for a played/in-progress test. */
function play(
  overrides: Pick<JellyfinUserPlayback, 'jellyfinUserId' | 'playCount' | 'lastPlayedAt'> & Partial<Pick<JellyfinUserPlayback, 'played' | 'positionTicks'>>,
): JellyfinUserPlayback {
  return { played: false, positionTicks: 0, ...overrides };
}

function fakeSource(opts: {
  movies?: JellyfinMovieItem[];
  series?: JellyfinSeriesItem[];
  episodes?: JellyfinEpisodeItem[];
  playedByItem?: Map<string, JellyfinUserPlayback[]>;
}): JellyfinPlaybackSource {
  return {
    listMovies: async () => opts.movies ?? [],
    listSeries: async () => opts.series ?? [],
    listEpisodes: async () => opts.episodes ?? [],
    listPlayedUserData: async () => opts.playedByItem ?? new Map(),
  };
}

function failingSource(message: string): JellyfinPlaybackSource {
  return {
    listMovies: async () => {
      throw new Error(message);
    },
    listSeries: async () => [],
    listEpisodes: async () => [],
    listPlayedUserData: async () => new Map(),
  };
}

let nextArrId = 1;

function insertMovieTitle(id: string, tmdbId: number | null, nowSeconds: number): void {
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
      sizeBytes: 1_000_000,
      path: `/data/media/movies/${id}`,
      addedAt: nowSeconds,
      lastSyncedAt: nowSeconds,
    })
    .run();
}

/**
 * `splitIntoSeasons` defaults `false` (the schema default, and every series
 * in production today) so every EXISTING call site below is unaffected —
 * only the new P4-1 Wave 2 tests pass `{ splitIntoSeasons: true }`
 * explicitly. Also doubles as the season-title-row inserter (`series:{id}:
 * s{n}` is just another `tv`-typed `title` row with the same shape, per Wave
 * 1's `src/lib/library/sync.ts`).
 */
function insertSeriesTitle(id: string, tvdbId: number | null, nowSeconds: number, opts: { splitIntoSeasons?: boolean } = {}): void {
  getDb()
    .insert(title)
    .values({
      id,
      mediaType: 'tv',
      arrInstance: 'sonarr',
      arrId: nextArrId++,
      tmdbId: null,
      tvdbId,
      title: id,
      year: 2020,
      sizeBytes: 2_000_000,
      path: `/data/media/tv/${id}`,
      addedAt: nowSeconds,
      splitIntoSeasons: opts.splitIntoSeasons ?? false,
      lastSyncedAt: nowSeconds,
    })
    .run();
}

describe('syncPlayback — movies (FR-ACCT-6 join on tmdbId, not jellyfinMediaId)', () => {
  it('a movie watched by one user: playback row written, title.watched_by_anyone true, last_played_any_at set', async () => {
    insertMovieTitle('movie:100', 569094, 1_000_000);
    const source = fakeSource({
      movies: [{ itemId: 'itemmovie1', tmdbId: 569094 }],
      playedByItem: new Map([['itemmovie1', [play({ jellyfinUserId: 'user1', playCount: 3, lastPlayedAt: 1_500_000 })]]]),
    });

    const result = await syncPlayback(source, 2_000_000);
    expect(result).toEqual({ ok: true, count: 1, ms: expect.any(Number) });

    const titleRow = getDb().select().from(title).where(eq(title.id, 'movie:100')).get();
    expect(titleRow?.watchedByAnyone).toBe(true);
    expect(titleRow?.lastPlayedAnyAt).toBe(1_500_000);

    const playbackRow = getDb().select().from(playback).where(eq(playback.titleId, 'movie:100')).get();
    expect(playbackRow).toMatchObject({
      titleId: 'movie:100',
      jellyfinUserId: 'user1',
      playCount: 3,
      lastPlayedAt: 1_500_000,
      lastSyncedAt: 2_000_000,
    });
  });

  it('a movie that matches a Jellyfin item but has zero plays: watched_by_anyone is a real, fresh false', async () => {
    insertMovieTitle('movie:101', 111, 1_000_000);
    const source = fakeSource({ movies: [{ itemId: 'itemmovie101', tmdbId: 111 }], playedByItem: new Map() });

    await syncPlayback(source, 2_000_000);

    const titleRow = getDb().select().from(title).where(eq(title.id, 'movie:101')).get();
    expect(titleRow?.watchedByAnyone).toBe(false);
    expect(titleRow?.lastPlayedAnyAt).toBeNull();
  });

  it('a title with no tmdb_id is skipped without error', async () => {
    insertMovieTitle('movie:102', null, 1_000_000);
    const source = fakeSource({ movies: [{ itemId: 'x', tmdbId: 999 }] });
    const result = await syncPlayback(source, 2_000_000);
    expect(result.ok).toBe(true);
    const titleRow = getDb().select().from(title).where(eq(title.id, 'movie:102')).get();
    expect(titleRow?.watchedByAnyone).toBe(false); // untouched, still the schema default
  });
});

describe('syncPlayback — TV series: watched if ANY episode has been played (FR-ACCT-6)', () => {
  it('two episodes, only one watched by one user: series counts as watched', async () => {
    insertSeriesTitle('series:200', 79335, 1_000_000);
    const source = fakeSource({
      series: [{ itemId: 'itemseries200', tvdbId: 79335 }],
      episodes: [
        { itemId: 'ep1', seriesId: 'itemseries200', seasonNumber: null },
        { itemId: 'ep2', seriesId: 'itemseries200', seasonNumber: null },
      ],
      playedByItem: new Map([['ep1', [play({ jellyfinUserId: 'frank', playCount: 1, lastPlayedAt: 1_100_000 })]]]),
    });

    await syncPlayback(source, 2_000_000);

    const titleRow = getDb().select().from(title).where(eq(title.id, 'series:200')).get();
    expect(titleRow?.watchedByAnyone).toBe(true);
    expect(titleRow?.lastPlayedAnyAt).toBe(1_100_000);
  });

  it('a user who watched multiple episodes gets one playback row with play_count summed and last_played_at maxed across episodes', async () => {
    insertSeriesTitle('series:201', 500, 1_000_000);
    const source = fakeSource({
      series: [{ itemId: 'itemseries201', tvdbId: 500 }],
      episodes: [
        { itemId: 'ep1', seriesId: 'itemseries201', seasonNumber: null },
        { itemId: 'ep2', seriesId: 'itemseries201', seasonNumber: null },
        { itemId: 'ep3', seriesId: 'itemseries201', seasonNumber: null },
      ],
      playedByItem: new Map([
        ['ep1', [play({ jellyfinUserId: 'dana', playCount: 2, lastPlayedAt: 1_100_000 })]],
        ['ep2', [play({ jellyfinUserId: 'dana', playCount: 1, lastPlayedAt: 1_300_000 })]],
        // ep3 not in the map at all — never played by anyone, must not error
      ]),
    });

    await syncPlayback(source, 2_000_000);

    const playbackRow = getDb().select().from(playback).where(eq(playback.titleId, 'series:201')).get();
    expect(playbackRow).toMatchObject({ jellyfinUserId: 'dana', playCount: 3, lastPlayedAt: 1_300_000 });
  });

  it('no episode watched by anyone: watched_by_anyone is a real, fresh false', async () => {
    insertSeriesTitle('series:202', 600, 1_000_000);
    const source = fakeSource({
      series: [{ itemId: 'itemseries202', tvdbId: 600 }],
      episodes: [{ itemId: 'ep1', seriesId: 'itemseries202', seasonNumber: null }],
      playedByItem: new Map(),
    });

    await syncPlayback(source, 2_000_000);
    const titleRow = getDb().select().from(title).where(eq(title.id, 'series:202')).get();
    expect(titleRow?.watchedByAnyone).toBe(false);
  });
});

describe('syncPlayback — played/positionTicks/episodesPlayed/episodesTotal (FR-ACCT-6, revised)', () => {
  it('a movie: played/positionTicks pass through directly from the source, episodesPlayed/episodesTotal stay null', async () => {
    insertMovieTitle('movie:500', 500, 1_000_000);
    const source = fakeSource({
      movies: [{ itemId: 'im500', tmdbId: 500 }],
      playedByItem: new Map([['im500', [play({ jellyfinUserId: 'frank', playCount: 1, lastPlayedAt: 1_100_000, played: false, positionTicks: 4_200_000 })]]]),
    });

    await syncPlayback(source, 2_000_000);

    const playbackRow = getDb().select().from(playback).where(eq(playback.titleId, 'movie:500')).get();
    expect(playbackRow).toMatchObject({ played: false, positionTicks: 4_200_000, episodesPlayed: null, episodesTotal: null });
  });

  it('a movie fully watched: played true, positionTicks 0 (no resume position)', async () => {
    insertMovieTitle('movie:501', 501, 1_000_000);
    const source = fakeSource({
      movies: [{ itemId: 'im501', tmdbId: 501 }],
      playedByItem: new Map([['im501', [play({ jellyfinUserId: 'frank', playCount: 1, lastPlayedAt: 1_100_000, played: true, positionTicks: 0 })]]]),
    });

    await syncPlayback(source, 2_000_000);

    const playbackRow = getDb().select().from(playback).where(eq(playback.titleId, 'movie:501')).get();
    expect(playbackRow).toMatchObject({ played: true, positionTicks: 0 });
  });

  it('a series: episodesPlayed counts the DISTINCT episodes a user has any play on, episodesTotal is the series episode count, played is true (FR-ACCT-6: any episode played)', async () => {
    insertSeriesTitle('series:502', 502, 1_000_000);
    const source = fakeSource({
      series: [{ itemId: 'itemseries502', tvdbId: 502 }],
      episodes: [
        { itemId: 'ep1', seriesId: 'itemseries502', seasonNumber: null },
        { itemId: 'ep2', seriesId: 'itemseries502', seasonNumber: null },
        { itemId: 'ep3', seriesId: 'itemseries502', seasonNumber: null },
        { itemId: 'ep4', seriesId: 'itemseries502', seasonNumber: null },
      ],
      playedByItem: new Map([
        ['ep1', [play({ jellyfinUserId: 'frank', playCount: 1, lastPlayedAt: 1_100_000, played: true })]],
        ['ep2', [play({ jellyfinUserId: 'frank', playCount: 1, lastPlayedAt: 1_200_000, played: true, positionTicks: 900 })]],
        // ep3/ep4 not played by frank at all — only 2 of 4 episodes.
      ]),
    });

    await syncPlayback(source, 2_000_000);

    const playbackRow = getDb().select().from(playback).where(eq(playback.titleId, 'series:502')).get();
    expect(playbackRow).toMatchObject({
      jellyfinUserId: 'frank',
      played: true, // ANY episode played (FR-ACCT-6)
      episodesPlayed: 2,
      episodesTotal: 4,
      positionTicks: 900, // MAX across the user's episodes
      playCount: 2, // summed (pre-existing behaviour, unchanged)
    });
  });

  it('a series watched by two users independently: each gets their OWN episodesPlayed/episodesTotal row, episodesTotal identical for both', async () => {
    insertSeriesTitle('series:503', 503, 1_000_000);
    const source = fakeSource({
      series: [{ itemId: 'itemseries503', tvdbId: 503 }],
      episodes: [
        { itemId: 'ep1', seriesId: 'itemseries503', seasonNumber: null },
        { itemId: 'ep2', seriesId: 'itemseries503', seasonNumber: null },
      ],
      playedByItem: new Map([
        ['ep1', [play({ jellyfinUserId: 'frank', playCount: 1, lastPlayedAt: 1_100_000 }), play({ jellyfinUserId: 'dana', playCount: 1, lastPlayedAt: 1_150_000 })]],
        ['ep2', [play({ jellyfinUserId: 'dana', playCount: 1, lastPlayedAt: 1_250_000 })]],
      ]),
    });

    await syncPlayback(source, 2_000_000);

    const rows = getDb().select().from(playback).where(eq(playback.titleId, 'series:503')).all();
    const frankRow = rows.find((r) => r.jellyfinUserId === 'frank');
    const danaRow = rows.find((r) => r.jellyfinUserId === 'dana');
    expect(frankRow).toMatchObject({ episodesPlayed: 1, episodesTotal: 2 });
    expect(danaRow).toMatchObject({ episodesPlayed: 2, episodesTotal: 2 }); // watched both — "watched all" is representable too
  });
});

// ---------------------------------------------------------------------------
// P4-1 Wave 2 — season-scoped watched state. A season counts as played using
// the EXACT SAME "any episode played" rule the whole series already uses
// (FR-ACCT-6), one level down. Fixture below is hand-calculated the same way
// the `mergeEpisodeUser`-adjacent tests above are: a small synthetic
// multi-season, multi-user dataset, worked out by hand, then asserted.
// ---------------------------------------------------------------------------
describe('syncPlayback — P4-1 Wave 2: season-scoped watched state for a split series', () => {
  /**
   * Every `it()` below shares one persistent test-file DB with no reset
   * between tests (same convention as every other fixture in this file —
   * e.g. `movie:100`, `series:200`, `series:502`, ... all use distinct
   * numeric ids), so each test gets its OWN tvdbId/title-id family here
   * rather than a fixed shared constant — reusing the same `title.id` (a
   * primary key) across two `it()` blocks would throw a unique-constraint
   * error on the second insert.
   */
  function seasonIds(n: number): { seriesId: string; season1Id: string; season2Id: string } {
    return { seriesId: `series:${n}`, season1Id: `series:${n}:s1`, season2Id: `series:${n}:s2` };
  }

  it('hand-calculated multi-season, multi-user, multi-episode fixture: each season gets its own watchedByAnyone/episodesPlayed/episodesTotal, independent of its siblings, while the whole-series row keeps its existing all-episodes aggregate', async () => {
    const { seriesId: SPLIT_SERIES_ID, season1Id: SEASON_1_ID, season2Id: SEASON_2_ID } = seasonIds(900);
    // Whole-series row, split (Wave 1's flag) — plus its two season rows,
    // exactly the shape `src/lib/library/sync.ts`'s Wave 1 code would have
    // already upserted before this sync runs.
    insertSeriesTitle(SPLIT_SERIES_ID, 900, 1_000_000, { splitIntoSeasons: true });
    insertSeriesTitle(SEASON_1_ID, 900, 1_000_000);
    insertSeriesTitle(SEASON_2_ID, 900, 1_000_000);

    const source = fakeSource({
      series: [{ itemId: 'itemseries900', tvdbId: 900 }],
      episodes: [
        // Season 1: two episodes, only frank has played ep1.
        { itemId: 'ep1', seriesId: 'itemseries900', seasonNumber: 1 },
        { itemId: 'ep2', seriesId: 'itemseries900', seasonNumber: 1 },
        // Season 2: two episodes, only dana has played ep3.
        { itemId: 'ep3', seriesId: 'itemseries900', seasonNumber: 2 },
        { itemId: 'ep4', seriesId: 'itemseries900', seasonNumber: 2 },
        // An episode with NO season number (a special Jellyfin didn't
        // assign one to) — erin has played it. Must count toward the
        // whole-series aggregate but be excluded from BOTH season buckets,
        // without crashing bucketing.
        { itemId: 'ep5', seriesId: 'itemseries900', seasonNumber: null },
      ],
      playedByItem: new Map([
        ['ep1', [play({ jellyfinUserId: 'frank', playCount: 1, lastPlayedAt: 1_100_000 })]],
        // ep2 never played by anyone.
        ['ep3', [play({ jellyfinUserId: 'dana', playCount: 2, lastPlayedAt: 1_300_000 })]],
        // ep4 never played by anyone.
        ['ep5', [play({ jellyfinUserId: 'erin', playCount: 1, lastPlayedAt: 1_050_000 })]],
      ]),
    });

    const result = await syncPlayback(source, 2_000_000);
    // 3 titles written this run: the whole series + both seasons.
    expect(result).toEqual({ ok: true, count: 3, ms: expect.any(Number) });

    // --- Season 1: only frank, only counting season 1's own 2 episodes ---
    const season1Title = getDb().select().from(title).where(eq(title.id, SEASON_1_ID)).get();
    expect(season1Title?.watchedByAnyone).toBe(true);
    expect(season1Title?.lastPlayedAnyAt).toBe(1_100_000);
    const season1Rows = getDb().select().from(playback).where(eq(playback.titleId, SEASON_1_ID)).all();
    expect(season1Rows).toHaveLength(1);
    expect(season1Rows[0]).toMatchObject({ jellyfinUserId: 'frank', episodesPlayed: 1, episodesTotal: 2, playCount: 1, lastPlayedAt: 1_100_000, played: true });

    // --- Season 2: only dana, only counting season 2's own 2 episodes ---
    const season2Title = getDb().select().from(title).where(eq(title.id, SEASON_2_ID)).get();
    expect(season2Title?.watchedByAnyone).toBe(true);
    expect(season2Title?.lastPlayedAnyAt).toBe(1_300_000);
    const season2Rows = getDb().select().from(playback).where(eq(playback.titleId, SEASON_2_ID)).all();
    expect(season2Rows).toHaveLength(1);
    expect(season2Rows[0]).toMatchObject({ jellyfinUserId: 'dana', episodesPlayed: 1, episodesTotal: 2, playCount: 2, lastPlayedAt: 1_300_000, played: true });

    // --- Whole-series row: unchanged rule, ALL 5 episodes (including the
    // seasonless ep5), all 3 users each get their own row, in ADDITION to
    // (not instead of) the season writes above.
    const wholeSeriesTitle = getDb().select().from(title).where(eq(title.id, SPLIT_SERIES_ID)).get();
    expect(wholeSeriesTitle?.watchedByAnyone).toBe(true);
    expect(wholeSeriesTitle?.lastPlayedAnyAt).toBe(1_300_000); // MAX across frank/dana/erin
    const wholeSeriesRows = getDb().select().from(playback).where(eq(playback.titleId, SPLIT_SERIES_ID)).all();
    expect(wholeSeriesRows).toHaveLength(3);
    const frankWhole = wholeSeriesRows.find((r) => r.jellyfinUserId === 'frank');
    const danaWhole = wholeSeriesRows.find((r) => r.jellyfinUserId === 'dana');
    const erinWhole = wholeSeriesRows.find((r) => r.jellyfinUserId === 'erin');
    expect(frankWhole).toMatchObject({ episodesPlayed: 1, episodesTotal: 5 });
    expect(danaWhole).toMatchObject({ episodesPlayed: 1, episodesTotal: 5 });
    expect(erinWhole).toMatchObject({ episodesPlayed: 1, episodesTotal: 5 }); // the seasonless episode counted here, nowhere else
  });

  it('a season with no plays from anyone: watchedByAnyone is a real, fresh false for that season alone, independent of its sibling season being watched', async () => {
    const { seriesId: SPLIT_SERIES_ID, season1Id: SEASON_1_ID, season2Id: SEASON_2_ID } = seasonIds(901);
    insertSeriesTitle(SPLIT_SERIES_ID, 901, 1_000_000, { splitIntoSeasons: true });
    insertSeriesTitle(SEASON_1_ID, 901, 1_000_000);
    insertSeriesTitle(SEASON_2_ID, 901, 1_000_000);

    const source = fakeSource({
      series: [{ itemId: 'itemseries901', tvdbId: 901 }],
      episodes: [
        { itemId: 'ep1', seriesId: 'itemseries901', seasonNumber: 1 },
        { itemId: 'ep2', seriesId: 'itemseries901', seasonNumber: 2 },
      ],
      playedByItem: new Map([['ep1', [play({ jellyfinUserId: 'frank', playCount: 1, lastPlayedAt: 1_100_000 })]]]),
    });

    await syncPlayback(source, 2_000_000);

    const season1Title = getDb().select().from(title).where(eq(title.id, SEASON_1_ID)).get();
    expect(season1Title?.watchedByAnyone).toBe(true);

    const season2Title = getDb().select().from(title).where(eq(title.id, SEASON_2_ID)).get();
    expect(season2Title?.watchedByAnyone).toBe(false);
    expect(season2Title?.lastPlayedAnyAt).toBeNull();
  });

  it('a season absent from Jellyfin this run (no episodes at all in that bucket) is simply not written — left stale, never a fabricated zero — while its sibling season and the whole-series row still write normally', async () => {
    const { seriesId: SPLIT_SERIES_ID, season1Id: SEASON_1_ID, season2Id: SEASON_2_ID } = seasonIds(902);
    insertSeriesTitle(SPLIT_SERIES_ID, 902, 1_000_000, { splitIntoSeasons: true });
    insertSeriesTitle(SEASON_1_ID, 902, 1_000_000);
    insertSeriesTitle(SEASON_2_ID, 902, 1_000_000); // season 2 exists as a title row, but Jellyfin reports no episodes for it this run

    const source = fakeSource({
      series: [{ itemId: 'itemseries902', tvdbId: 902 }],
      episodes: [{ itemId: 'ep1', seriesId: 'itemseries902', seasonNumber: 1 }],
      playedByItem: new Map([['ep1', [play({ jellyfinUserId: 'frank', playCount: 1, lastPlayedAt: 1_100_000 })]]]),
    });

    const result = await syncPlayback(source, 2_000_000);
    // Whole series + season 1 only — season 2 has no episode bucket this
    // run, so it is never even attempted.
    expect(result.count).toBe(2);

    const season1Title = getDb().select().from(title).where(eq(title.id, SEASON_1_ID)).get();
    expect(season1Title?.watchedByAnyone).toBe(true);
    // Season 2's title row is untouched — still the schema default, not a
    // freshly-written false — and NO playback row was ever inserted for it
    // (the real "never attempted" signal; `writeTitlePlayback` is simply
    // never called for a season with an empty/absent episode bucket).
    const season2Title = getDb().select().from(title).where(eq(title.id, SEASON_2_ID)).get();
    expect(season2Title?.watchedByAnyone).toBe(false);
    expect(season2Title?.lastPlayedAnyAt).toBeNull();
    expect(getDb().select().from(playback).where(eq(playback.titleId, SEASON_2_ID)).all()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// P4-1 Wave 2 — the hard non-regression requirement: a `split_into_seasons =
// false` series (every series in production as of this wave) MUST produce
// byte-for-byte identical playback/title writes to before this wave, even
// when its episodes carry real, non-null season numbers (proving the new
// season-bucketing code that now runs for EVERY series never influences the
// unsplit default path — the gate is `row.splitIntoSeasons`, checked, not
// "episodes happen to lack season numbers").
// ---------------------------------------------------------------------------
describe('syncPlayback — P4-1 Wave 2 regression: an unsplit series is completely unaffected', () => {
  it('an unsplit series whose episodes DO carry season numbers writes ONLY the whole-series title — no series:{id}:s{n} row is ever written, and the whole-series aggregate matches the pre-Wave-2 all-episodes rule exactly', async () => {
    insertSeriesTitle('series:910', 910, 1_000_000); // splitIntoSeasons defaults false — unchanged from every existing call site
    const source = fakeSource({
      series: [{ itemId: 'itemseries910', tvdbId: 910 }],
      episodes: [
        { itemId: 'ep1', seriesId: 'itemseries910', seasonNumber: 1 },
        { itemId: 'ep2', seriesId: 'itemseries910', seasonNumber: 1 },
        { itemId: 'ep3', seriesId: 'itemseries910', seasonNumber: 2 },
      ],
      playedByItem: new Map([
        ['ep1', [play({ jellyfinUserId: 'frank', playCount: 1, lastPlayedAt: 1_100_000 })]],
        ['ep3', [play({ jellyfinUserId: 'frank', playCount: 1, lastPlayedAt: 1_300_000 })]],
      ]),
    });

    const result = await syncPlayback(source, 2_000_000);
    // Exactly ONE title written — the whole series. If the split branch
    // ever ran for an unsplit series, this would be 2 or 3 instead.
    expect(result).toEqual({ ok: true, count: 1, ms: expect.any(Number) });

    // No season-title playback/title rows exist at all — never created,
    // never written to.
    expect(getDb().select().from(title).where(eq(title.id, 'series:910:s1')).get()).toBeUndefined();
    expect(getDb().select().from(title).where(eq(title.id, 'series:910:s2')).get()).toBeUndefined();
    expect(getDb().select().from(playback).where(eq(playback.titleId, 'series:910:s1')).all()).toHaveLength(0);
    expect(getDb().select().from(playback).where(eq(playback.titleId, 'series:910:s2')).all()).toHaveLength(0);

    // The whole-series row aggregates ALL 3 episodes exactly as it did
    // before this wave (FR-ACCT-6, unchanged): frank played 2 of 3.
    const wholeSeriesTitle = getDb().select().from(title).where(eq(title.id, 'series:910')).get();
    expect(wholeSeriesTitle?.watchedByAnyone).toBe(true);
    expect(wholeSeriesTitle?.lastPlayedAnyAt).toBe(1_300_000);
    const playbackRow = getDb().select().from(playback).where(eq(playback.titleId, 'series:910')).get();
    expect(playbackRow).toMatchObject({ jellyfinUserId: 'frank', episodesPlayed: 2, episodesTotal: 3, playCount: 2, lastPlayedAt: 1_300_000, played: true });
  });
});

describe('syncPlayback — failure isolation (FR-ACCT-10, and this task\'s correctness bar)', () => {
  it('a total fetch failure leaves playback ok:false and touches nothing in the DB', async () => {
    insertMovieTitle('movie:300', 300, 1_000_000);
    const good = fakeSource({
      movies: [{ itemId: 'im300', tmdbId: 300 }],
      playedByItem: new Map([['im300', [play({ jellyfinUserId: 'admin', playCount: 5, lastPlayedAt: 1_200_000 })]]]),
    });
    await syncPlayback(good, 1_500_000); // seed a known-good prior state

    const before = getDb().select().from(title).where(eq(title.id, 'movie:300')).get();
    expect(before?.watchedByAnyone).toBe(true);

    const result = await syncPlayback(failingSource('ECONNREFUSED / DB unreachable'), 2_000_000);
    expect(result.ok).toBe(false);
    expect(result.count).toBe(0);
    expect(result.error).toContain('unreachable');

    // Nothing changed: still watched, still the OLD last_synced_at on the playback row.
    const after = getDb().select().from(title).where(eq(title.id, 'movie:300')).get();
    expect(after?.watchedByAnyone).toBe(true);
    expect(after?.lastPlayedAnyAt).toBe(1_200_000);

    const playbackRow = getDb().select().from(playback).where(eq(playback.titleId, 'movie:300')).get();
    expect(playbackRow?.lastSyncedAt).toBe(1_500_000); // did NOT advance to 2_000_000 — the staleness signal
  });

  it('a previously-watched title that no longer matches ANY Jellyfin item this run is left untouched, never flipped to false', async () => {
    insertMovieTitle('movie:301', 301, 1_000_000);
    const good = fakeSource({
      movies: [{ itemId: 'im301', tmdbId: 301 }],
      playedByItem: new Map([['im301', [play({ jellyfinUserId: 'jack', playCount: 1, lastPlayedAt: 1_100_000 })]]]),
    });
    await syncPlayback(good, 1_500_000);
    const before = getDb().select().from(title).where(eq(title.id, 'movie:301')).get();
    expect(before?.watchedByAnyone).toBe(true);

    // This run succeeds overall, but the library no longer reports this
    // movie at all (e.g. a transient Jellyfin library-scan gap) — the movie
    // is simply absent from `movies`, not present with tmdbId: null.
    const nextRun = fakeSource({ movies: [], playedByItem: new Map() });
    const result = await syncPlayback(nextRun, 2_000_000);
    expect(result.ok).toBe(true); // the fetch itself succeeded

    const after = getDb().select().from(title).where(eq(title.id, 'movie:301')).get();
    expect(after?.watchedByAnyone).toBe(true); // NEVER flipped to false on missing match
    expect(after?.lastPlayedAnyAt).toBe(1_100_000);

    const playbackRow = getDb().select().from(playback).where(eq(playback.titleId, 'movie:301')).get();
    expect(playbackRow?.lastSyncedAt).toBe(1_500_000); // stale, not re-written
  });

  it('re-running syncPlayback never throws even when nothing matches at all', async () => {
    await expect(syncPlayback(fakeSource({}), 3_000_000)).resolves.toMatchObject({ ok: true });
  });
});

describe('runPlaybackSync — sync_run bookkeeping', () => {
  it('writes one sync_run row with a single "playback" step key', async () => {
    insertMovieTitle('movie:400', 400, 1_000_000);
    const source = fakeSource({ movies: [{ itemId: 'im400', tmdbId: 400 }], playedByItem: new Map() });

    const result = await runPlaybackSync({ source }, 2_000_000);
    expect(result.playback).toEqual({ ok: true, count: 1, ms: expect.any(Number) });

    const runRow = getDb().select().from(syncRun).where(eq(syncRun.id, result.syncRunId)).get();
    expect(runRow?.ok).toBe(true);
    const steps = JSON.parse(runRow!.steps) as Record<string, { ok: boolean; count: number }>;
    expect(steps).toEqual({ playback: { ok: true, count: 1, ms: expect.any(Number) } });
  });

  it('a failed fetch still records a sync_run row, with ok: false', async () => {
    const result = await runPlaybackSync({ source: failingSource('down') }, 2_000_000);
    expect(result.playback.ok).toBe(false);
    const runRow = getDb().select().from(syncRun).where(eq(syncRun.id, result.syncRunId)).get();
    expect(runRow?.ok).toBe(false);
  });
});
