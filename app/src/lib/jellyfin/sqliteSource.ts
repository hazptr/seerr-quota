/**
 * `SqliteJellyfinPlaybackSource` — the read-only `jellyfin.db` reader that
 * backs `JellyfinPlaybackSource` (`./types.ts`) today. This file's header
 * comment IS the spike writeup: the decision, why, and what was tried.
 *
 * ## The spike
 *
 * `wiki/Feature-03-Usage-Accounting.md` marks the Jellyfin REST path
 * `? unverified` and names two calls to try:
 *   `GET /Users`
 *   `GET /Items?userId=<id>&isPlayed=true&recursive=true&includeItemTypes=Movie,Series`
 *
 * Both were tried, read-only, against a real deployment (`127.0.0.1:8096`,
 * Jellyfin 10.11.11):
 *   - `GET /System/Info/Public` (genuinely unauthenticated) — 200, confirms
 *     the host is reachable and identifies the server.
 *   - `GET /Users/Public` — 200, but `[]` (no public-login users configured;
 *     this instance requires a real login, so this endpoint is a dead end
 *     for this app regardless of key status).
 *   - `GET /Users` — **401**.
 *   - `GET /Items?recursive=true` — **401**.
 *
 * Both calls this app actually needs require an API key. **There is no
 * `JELLYFIN_API_KEY` for this app** (`wiki/Configuration.md` documents one as
 * a future secret, `getConfig()` already has a slot for it), and minting one
 * is a production change needing operator sign-off, not something this code
 * does for itself. `configs/jellyfin/data` was also checked for any
 * already-issued key this app could read and reuse — there is none on disk
 * in a form this app could pick up (Jellyfin 10.11 stores API keys inside
 * `jellyfin.db`'s `ApiKeys` table, not a separate file; that table was
 * deliberately never queried here, so no key value from it can ever leak
 * into this app, a log, or an error).
 *
 * **Conclusion: the REST path is blocked on credentials, not evaluated as
 * impractical on its own merits** — the two documented calls are exactly the
 * right shape for the job (`/Users` to enumerate Jellyfin user GUIDs,
 * `/Items?isPlayed=true` per user for the played set), and should be revisited
 * the moment an operator provisions `JELLYFIN_API_KEY`. Nothing here should
 * be read as "REST doesn't work" — only "REST cannot be exercised or shipped
 * without a key that isn't this code's to mint."
 *
 * ## The fallback taken instead
 *
 * `wiki/Architecture.md`'s house rule is "read the APIs, not other services'
 * SQLite files" — a long-running service holding another app's WAL-mode DB
 * open is a real hazard, and the schema is an internal detail (Jellyfin's,
 * like Seerr's, has already churned across major versions). The same section
 * explicitly permits the exception: "Read-only sqlite access is permitted
 * ONLY as a fallback for joins the API genuinely cannot do, and must be
 * documented where used." This file is that documentation, and this
 * implementation is that fallback — chosen because it is the *only* option
 * that doesn't require a credential this reader can't mint for itself, not
 * because it was preferred over REST on the merits.
 *
 * Mitigations for the two risks the house rule calls out:
 *   - **WAL contention**: opened genuinely read-only (see `open()` below) —
 *     `better-sqlite3` never documents/parses a `file:...?mode=ro` URI the
 *     way Python's `sqlite3` module does (verified against
 *     `node_modules/better-sqlite3/docs/api.md`: no URI handling is
 *     mentioned anywhere in the `Database` constructor's docs); its
 *     idiomatic equivalent — `{ readonly: true, fileMustExist: true }` — is
 *     used instead, which opens with `SQLITE_OPEN_READONLY` and refuses to
 *     create the file if missing. This is the exact same guarantee the `?
 *     mode=ro` URI form gives Python's driver: no write, no journal/WAL
 *     takeover, no accidental file creation — just a different spelling for
 *     this driver. `readonly()`/`inTransaction` are never used; there is no
 *     write path anywhere in this file, and there never should be.
 *   - **Schema churn**: every query below only reads the same four
 *     tables/columns `analyze_watch_history.py` already depends on
 *     (`BaseItems`, `UserData`) plus one more this app's join needs that the
 *     script doesn't (`BaseItemProviders`, for `Tmdb`/`Tvdb` provider ids —
 *     see "Why this join, not `jellyfinMediaId`" below). If Jellyfin's schema
 *     changes, this file breaks loudly (a thrown error → the whole playback
 *     step goes `ok: false`, per `FR-ACCT-10`), not silently.
 *
 * ## Why this join, not `jellyfinMediaId`
 *
 * `analyze_watch_history.py` joins Seerr's `requests.csv` to Jellyfin purely
 * via `jellyfinMediaId`. `wiki/Feature-03-Usage-Accounting.md` explicitly
 * warns that field "is nullable and was null on every row checked, including
 * available ones ... join playback on tmdbId/tvdbId via the library, not on
 * this field." This app's `title` table already carries `tmdb_id`
 * (movies, from Radarr) / `tvdb_id` (series, from Sonarr) — so this reader
 * instead resolves Jellyfin items via `BaseItemProviders` (`ProviderId =
 * 'Tmdb'`/`'Tvdb'`), which every checked movie (82/82) and the large
 * majority of series (95 series rows found with a Tvdb id) carry. See this
 * task's verification comparison (reported alongside this change, not
 * committed as code) for the 100%-agreement proof against
 * `analyze_watch_history.py`'s own `results.csv` using this exact join.
 *
 * ## One documented deviation from the reference script: de-duplication
 *
 * Some Jellyfin items carry more than one `UserData` row for the same
 * `(ItemId, UserId)` pair — e.g. one episode had three rows
 * for the same user, differing only in `CustomDataKey` (the item's own GUID,
 * a composite TVDB key, and an IMDb id), with **identical** `PlayCount` and
 * `LastPlayedDate` in every duplicate checked. `analyze_watch_history.py`
 * never notices this because it only reads `uid`/`lp` (never `cnt`) and both
 * `watched_by_anyone` (an OR) and `last_played` (a MAX) are duplicate-safe.
 * This app's `playback.play_count` column *is* a real number a member sees,
 * so `listPlayedUserData` collapses duplicates with `MAX(PlayCount)` (never
 * `SUM`) — summing would silently 2-3x a play count for no reason tied to
 * actual plays.
 */
import Database from 'better-sqlite3';
import type { JellyfinEpisodeItem, JellyfinMovieItem, JellyfinPlaybackSource, JellyfinSeriesItem, JellyfinUserPlayback } from './types';

const MOVIE_TYPE = 'MediaBrowser.Controller.Entities.Movies.Movie';
const SERIES_TYPE = 'MediaBrowser.Controller.Entities.TV.Series';
/** `LIKE`, not `=` — matches `analyze_watch_history.py`'s own `Type LIKE '%TV.Episode%'`, tolerant of the namespace prefix. */
const EPISODE_TYPE_LIKE = '%TV.Episode%';

/** Strips dashes and lowercases a Jellyfin GUID — `wiki/Data-Model.md` §member's `jellyfin_user_id` normalisation, and exactly what `analyze_watch_history.py`'s `norm()` does. Exported for reuse by callers/tests that need to compare against a raw Jellyfin GUID. */
export function normalizeGuid(guid: string): string {
  return guid.replace(/-/g, '').toLowerCase();
}

/** Jellyfin's `LastPlayedDate` is a free-form ISO-ish timestamp string (`"2026-05-17 01:36:23.5567267"`); `Date.parse` handles the space-separated variant Jellyfin emits. Returns `null` on anything unparseable rather than throwing — a single bad timestamp must not fail the whole sync. */
export function parseJellyfinTimestamp(raw: string | null): number | null {
  if (!raw) return null;
  const ms = Date.parse(raw.replace(' ', 'T') + 'Z');
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** Exported so `restSource.ts` can apply the identical `ProviderIds.Tmdb`/`.Tvdb` string-to-int parsing to the REST response shape — see that file's header comment. */
export function parseProviderValueAsId(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const n = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

interface MovieRow {
  id: string;
  tmdbId: string | number | null;
}
interface SeriesRow {
  id: string;
  tvdbId: string | number | null;
}
interface EpisodeRow {
  Id: string;
  SeriesId: string | null;
  /** `INTEGER NULL` in the real schema (confirmed via `.schema BaseItems`). */
  ParentIndexNumber: number | null;
}
interface UserDataRow {
  ItemId: string;
  UserId: string;
  PlayCount: number;
  LastPlayedDate: string | null;
  Played: number;
  PlaybackPositionTicks: number;
}

/**
 * Read-only `jellyfin.db` reader — the documented fallback implementation of
 * `JellyfinPlaybackSource` (see this file's header comment for the full
 * spike writeup and why it's used instead of REST). Opens the DB lazily on
 * first call, strictly read-only, and never writes anything.
 */
/** Instance type for the value `better-sqlite3` exports (mirrors `SeerrQuotaDb` in `src/lib/db/index.ts`'s use of `ReturnType<typeof drizzle<...>>` — the same "derive the instance type from the callable/constructable export" idiom, robust to exactly how `@types/better-sqlite3` names its internal namespace). */
type JellyfinSqliteDb = ReturnType<typeof Database>;

export class SqliteJellyfinPlaybackSource implements JellyfinPlaybackSource {
  private db: JellyfinSqliteDb | undefined;

  constructor(private readonly dbPath: string) {}

  private open(): JellyfinSqliteDb {
    if (!this.db) {
      // Strictly read-only (see this file's header "Mitigations" section):
      // SQLITE_OPEN_READONLY under the hood, and `fileMustExist` means this
      // can never accidentally create a fresh empty DB at `dbPath`.
      this.db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
    }
    return this.db;
  }

  async listMovies(): Promise<JellyfinMovieItem[]> {
    const rows = this.open()
      .prepare(
        `SELECT bi.Id as id, p.ProviderValue as tmdbId
         FROM BaseItems bi
         LEFT JOIN BaseItemProviders p ON p.ItemId = bi.Id AND p.ProviderId = 'Tmdb'
         WHERE bi.Type = ?`,
      )
      .all(MOVIE_TYPE) as MovieRow[];
    return rows.map((r) => ({ itemId: normalizeGuid(r.id), tmdbId: parseProviderValueAsId(r.tmdbId) }));
  }

  async listSeries(): Promise<JellyfinSeriesItem[]> {
    const rows = this.open()
      .prepare(
        `SELECT bi.Id as id, p.ProviderValue as tvdbId
         FROM BaseItems bi
         LEFT JOIN BaseItemProviders p ON p.ItemId = bi.Id AND p.ProviderId = 'Tvdb'
         WHERE bi.Type = ?`,
      )
      .all(SERIES_TYPE) as SeriesRow[];
    return rows.map((r) => ({ itemId: normalizeGuid(r.id), tvdbId: parseProviderValueAsId(r.tvdbId) }));
  }

  async listEpisodes(): Promise<JellyfinEpisodeItem[]> {
    // `ParentIndexNumber` is in the SELECT list — a real
    // `INTEGER NULL` column on this table, so a missing
    // value comes back as SQL NULL / JS `null`, never a thrown error.
    const rows = this.open()
      .prepare(`SELECT Id, SeriesId, ParentIndexNumber FROM BaseItems WHERE Type LIKE ?`)
      .all(EPISODE_TYPE_LIKE) as EpisodeRow[];
    return rows.map((r) => ({
      itemId: normalizeGuid(r.Id),
      seriesId: r.SeriesId ? normalizeGuid(r.SeriesId) : null,
      seasonNumber: typeof r.ParentIndexNumber === 'number' ? r.ParentIndexNumber : null,
    }));
  }

  async listPlayedUserData(): Promise<Map<string, JellyfinUserPlayback[]>> {
    // GROUP BY + MAX collapses the duplicate-CustomDataKey rows documented
    // in this file's header comment — never SUM (see "One documented
    // deviation" above). `Played`/`PlaybackPositionTicks` are collapsed the
    // same way: every duplicate-CustomDataKey
    // group for a REAL content item (joined against BaseItems) carries
    // IDENTICAL Played/PlaybackPositionTicks across its rows — the only
    // groups where these values genuinely differ belong to Jellyfin's own
    // `Id = 00000000-0000-0000-0000-000000000001` "PLACEHOLDER" bucket (its
    // `Type` is `PLACEHOLDER`, which never matches this app's
    // Movie/Series/Episode filters, so those rows are collected here but
    // never looked up by `../playback/sync.ts` — harmless). `MAX` is used
    // regardless, for the same "never let missing/duplicate rows silently
    // suppress a true signal" reasoning as the PlayCount collapse.
    const rows = this.open()
      .prepare(
        `SELECT ItemId, UserId, MAX(PlayCount) as PlayCount, MAX(LastPlayedDate) as LastPlayedDate,
                MAX(Played) as Played, MAX(PlaybackPositionTicks) as PlaybackPositionTicks
         FROM UserData
         WHERE PlayCount > 0
         GROUP BY ItemId, UserId`,
      )
      .all() as UserDataRow[];

    const byItem = new Map<string, JellyfinUserPlayback[]>();
    for (const r of rows) {
      const itemId = normalizeGuid(r.ItemId);
      const entry: JellyfinUserPlayback = {
        jellyfinUserId: normalizeGuid(r.UserId),
        playCount: r.PlayCount,
        lastPlayedAt: parseJellyfinTimestamp(r.LastPlayedDate),
        played: Boolean(r.Played),
        positionTicks: r.PlaybackPositionTicks,
      };
      const existing = byItem.get(itemId);
      if (existing) existing.push(entry);
      else byItem.set(itemId, [entry]);
    }
    return byItem;
  }
}

/** Builds the fallback reader wired to `JELLYFIN_DB_PATH` (`wiki/Configuration.md` — not yet a declared key there; should be added alongside `JELLYFIN_API_KEY`). */
export function createSqliteJellyfinPlaybackSource(dbPath: string): SqliteJellyfinPlaybackSource {
  return new SqliteJellyfinPlaybackSource(dbPath);
}
