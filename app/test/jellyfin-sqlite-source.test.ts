import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { normalizeGuid, parseJellyfinTimestamp, SqliteJellyfinPlaybackSource } from '@/lib/jellyfin/sqliteSource';

/**
 * `SqliteJellyfinPlaybackSource` unit tests, against a HAND-BUILT fixture
 * `jellyfin.db` (never a live service — unit tests must run against
 * fixtures, not live services). The fixture's schema is trimmed to exactly
 * the columns `sqliteSource.ts` reads (`BaseItems`, `BaseItemProviders`,
 * `UserData`), matching Jellyfin's real schema (see `sqliteSource.ts`'s
 * header comment) — table/column names and the
 * `MediaBrowser.Controller.Entities.*` type strings are the real ones, not
 * invented.
 *
 * The duplicate-`CustomDataKey`-rows-with-identical-PlayCount case (movie
 * `MOVIE_A`, user `USER_A` below) is a real phenomenon (three rows differing
 * only in `CustomDataKey`, all carrying the same `PlayCount`/`LastPlayedDate`)
 * — reproduced here to prove `listPlayedUserData`'s `MAX`-based de-dup
 * collapses it to one entry without inflating `playCount`.
 */

const MOVIE_TYPE = 'MediaBrowser.Controller.Entities.Movies.Movie';
const SERIES_TYPE = 'MediaBrowser.Controller.Entities.TV.Series';
const EPISODE_TYPE = 'MediaBrowser.Controller.Entities.TV.Episode';

const MOVIE_A = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA';
const MOVIE_B_NO_PROVIDER = 'CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC';
const SERIES_A = 'BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB';
const EPISODE_A1 = 'D1D1D1D1-D1D1-D1D1-D1D1-D1D1D1D1D1D1';
const EPISODE_A2 = 'D2D2D2D2-D2D2-D2D2-D2D2-D2D2D2D2D2D2';
const SEASONLESS_EPISODE = 'D3D3D3D3-D3D3-D3D3-D3D3-D3D3D3D3D3D3'; // ParentIndexNumber NULL — a special/unassigned episode
const ORPHAN_EPISODE = 'EEEEEEEE-EEEE-EEEE-EEEE-EEEEEEEEEEEE'; // SeriesId NULL — must be excluded from every series' episode list
const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

function buildFixtureDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE BaseItems (
      Id TEXT NOT NULL PRIMARY KEY,
      Type TEXT NOT NULL,
      Name TEXT,
      SeriesId TEXT,
      ParentIndexNumber INTEGER
    );
    CREATE TABLE BaseItemProviders (
      ItemId TEXT NOT NULL,
      ProviderId TEXT NOT NULL,
      ProviderValue TEXT NOT NULL,
      PRIMARY KEY (ItemId, ProviderId)
    );
    CREATE TABLE UserData (
      ItemId TEXT NOT NULL,
      UserId TEXT NOT NULL,
      CustomDataKey TEXT NOT NULL,
      PlayCount INTEGER NOT NULL,
      LastPlayedDate TEXT,
      Played INTEGER NOT NULL,
      PlaybackPositionTicks INTEGER NOT NULL,
      PRIMARY KEY (ItemId, UserId, CustomDataKey)
    );
  `);

  const insertItem = db.prepare('INSERT INTO BaseItems (Id, Type, Name, SeriesId, ParentIndexNumber) VALUES (?, ?, ?, ?, ?)');
  insertItem.run(MOVIE_A, MOVIE_TYPE, 'Movie A', null, null);
  insertItem.run(MOVIE_B_NO_PROVIDER, MOVIE_TYPE, 'Movie B (no Tmdb id)', null, null);
  insertItem.run(SERIES_A, SERIES_TYPE, 'Series A', null, null);
  insertItem.run(EPISODE_A1, EPISODE_TYPE, 'Series A - Ep 1', SERIES_A, 1);
  insertItem.run(EPISODE_A2, EPISODE_TYPE, 'Series A - Ep 2', SERIES_A, 1);
  // P4-1 Wave 2: no ParentIndexNumber recorded at all — must come back
  // seasonNumber: null rather than throwing or defaulting to 0.
  insertItem.run(SEASONLESS_EPISODE, EPISODE_TYPE, 'Series A - Ep 3 (no season)', SERIES_A, null);
  insertItem.run(ORPHAN_EPISODE, EPISODE_TYPE, 'Orphan episode', null, null);

  const insertProvider = db.prepare('INSERT INTO BaseItemProviders (ItemId, ProviderId, ProviderValue) VALUES (?, ?, ?)');
  insertProvider.run(MOVIE_A, 'Tmdb', '967941');
  insertProvider.run(SERIES_A, 'Tvdb', '317004');
  insertProvider.run(SERIES_A, 'Imdb', 'tt1234567'); // a second, irrelevant provider id — must not confuse the Tvdb-only query

  const insertPlay = db.prepare(
    'INSERT INTO UserData (ItemId, UserId, CustomDataKey, PlayCount, LastPlayedDate, Played, PlaybackPositionTicks) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  // MOVIE_A watched by USER_A, with THREE duplicate rows carrying identical
  // PlayCount/LastPlayedDate/Played/PlaybackPositionTicks under different
  // CustomDataKeys — the real pattern Jellyfin produces (every duplicate
  // group for a real content item carries identical values across all four
  // fields; only Jellyfin's own synthetic PLACEHOLDER item, which never
  // matches this app's type filters, disagrees — see sqliteSource.ts's
  // updated header comment).
  insertPlay.run(MOVIE_A, USER_A, MOVIE_A.toLowerCase(), 5, '2026-03-01 00:19:35.4417889', 1, 0);
  insertPlay.run(MOVIE_A, USER_A, '967941', 5, '2026-03-01 00:19:35.4417889', 1, 0);
  insertPlay.run(MOVIE_A, USER_A, 'tt0000001', 5, '2026-03-01 00:19:35.4417889', 1, 0);
  // EPISODE_A1 watched by USER_B, UNFINISHED (Played=0, a real resume
  // position) — this is the FR-DEL-4 `in_progress` signal.
  insertPlay.run(EPISODE_A1, USER_B, '', 2, '2026-04-05 12:00:00.0000000', 0, 88_000_000);
  // EPISODE_A2 unwatched by anyone; a PlayCount of 0 must never surface —
  // matches analyze_watch_history.py's `WHERE PlayCount > 0`.
  insertPlay.run(EPISODE_A2, USER_B, '', 0, null, 0, 0);

  db.close();
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-jellyfin-source-test-'));
const dbPath = path.join(tmpDir, 'jellyfin-fixture.db');
buildFixtureDb(dbPath);
const source = new SqliteJellyfinPlaybackSource(dbPath);

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('normalizeGuid', () => {
  it('strips dashes and lowercases, matching analyze_watch_history.py\'s norm()', () => {
    expect(normalizeGuid('33333333-3333-3333-3333-333333333333')).toBe('33333333333333333333333333333333');
  });
});

describe('parseJellyfinTimestamp', () => {
  it('parses Jellyfin\'s space-separated, high-precision timestamp to unix seconds', () => {
    const seconds = parseJellyfinTimestamp('2026-03-01 00:19:35.4417889');
    expect(seconds).toBe(Math.floor(Date.parse('2026-03-01T00:19:35.441Z') / 1000));
  });

  it('returns null for null/empty input rather than throwing', () => {
    expect(parseJellyfinTimestamp(null)).toBeNull();
  });
});

describe('SqliteJellyfinPlaybackSource — read-only guarantee', () => {
  it('opening with {readonly, fileMustExist} refuses a write (the Node equivalent of Python\'s file:...?mode=ro)', () => {
    const ro = new Database(dbPath, { readonly: true, fileMustExist: true });
    expect(() => ro.prepare("INSERT INTO BaseItems (Id, Type) VALUES ('x', 'y')").run()).toThrow(/readonly/i);
    ro.close();
  });

  it('fileMustExist refuses to silently create a fresh DB at a missing path', () => {
    const missingPath = path.join(tmpDir, 'does-not-exist.db');
    expect(() => new Database(missingPath, { readonly: true, fileMustExist: true })).toThrow();
  });
});

describe('SqliteJellyfinPlaybackSource — listMovies', () => {
  it('resolves the Tmdb provider id and normalises the item GUID', async () => {
    const movies = await source.listMovies();
    expect(movies).toContainEqual({ itemId: normalizeGuid(MOVIE_A), tmdbId: 967941 });
  });

  it('a movie with no Tmdb provider row comes back with tmdbId: null (never dropped, never a fake 0)', async () => {
    const movies = await source.listMovies();
    expect(movies).toContainEqual({ itemId: normalizeGuid(MOVIE_B_NO_PROVIDER), tmdbId: null });
  });
});

describe('SqliteJellyfinPlaybackSource — listSeries', () => {
  it('resolves the Tvdb provider id specifically, ignoring other provider ids on the same item', async () => {
    const series = await source.listSeries();
    expect(series).toEqual([{ itemId: normalizeGuid(SERIES_A), tvdbId: 317004 }]);
  });
});

describe('SqliteJellyfinPlaybackSource — listEpisodes', () => {
  it('returns every episode with its normalised parent series id and season number', async () => {
    const episodes = await source.listEpisodes();
    expect(episodes).toContainEqual({ itemId: normalizeGuid(EPISODE_A1), seriesId: normalizeGuid(SERIES_A), seasonNumber: 1 });
    expect(episodes).toContainEqual({ itemId: normalizeGuid(EPISODE_A2), seriesId: normalizeGuid(SERIES_A), seasonNumber: 1 });
  });

  it('an orphaned episode (SeriesId NULL) comes back with seriesId: null rather than being dropped', async () => {
    const episodes = await source.listEpisodes();
    expect(episodes).toContainEqual({ itemId: normalizeGuid(ORPHAN_EPISODE), seriesId: null, seasonNumber: null });
  });

  it('P4-1 Wave 2: an episode with ParentIndexNumber NULL comes back with seasonNumber: null rather than throwing or defaulting to 0', async () => {
    const episodes = await source.listEpisodes();
    expect(episodes).toContainEqual({ itemId: normalizeGuid(SEASONLESS_EPISODE), seriesId: normalizeGuid(SERIES_A), seasonNumber: null });
  });
});

describe('SqliteJellyfinPlaybackSource — listPlayedUserData', () => {
  it('de-duplicates repeated (ItemId, UserId) rows via MAX, not SUM — playCount stays 5, not 15, and Played/PlaybackPositionTicks come through', async () => {
    const played = await source.listPlayedUserData();
    const movieAPlays = played.get(normalizeGuid(MOVIE_A));
    expect(movieAPlays).toEqual([
      {
        jellyfinUserId: normalizeGuid(USER_A),
        playCount: 5,
        lastPlayedAt: Math.floor(Date.parse('2026-03-01T00:19:35.441Z') / 1000),
        played: true,
        positionTicks: 0,
      },
    ]);
  });

  it('an unfinished episode (Played=0, a real resume position) captures positionTicks and played:false — the FR-DEL-4 in_progress signal', async () => {
    const played = await source.listPlayedUserData();
    const episodeA1Plays = played.get(normalizeGuid(EPISODE_A1));
    expect(episodeA1Plays).toEqual([
      {
        jellyfinUserId: normalizeGuid(USER_B),
        playCount: 2,
        lastPlayedAt: Math.floor(Date.parse('2026-04-05T12:00:00.000Z') / 1000),
        played: false,
        positionTicks: 88_000_000,
      },
    ]);
  });

  it('a PlayCount of 0 is excluded entirely', async () => {
    const played = await source.listPlayedUserData();
    expect(played.has(normalizeGuid(EPISODE_A2))).toBe(false);
  });

  it('an item with no plays at all is simply absent from the map', async () => {
    const played = await source.listPlayedUserData();
    expect(played.has(normalizeGuid(MOVIE_B_NO_PROVIDER))).toBe(false);
  });
});
