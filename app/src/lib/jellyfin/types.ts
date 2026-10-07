/**
 * Narrow, read-only interface this app needs from Jellyfin for the playback
 * sync (`FR-ACCT-6`, `wiki/Backlog.md`). Deliberately NOT a general
 * Jellyfin client — four bulk reads, matching exactly what
 * `analyze_watch_history.py` (the proven reference, root
 * `seerr-quota/analyze_watch_history.py`) loads: movies, series, episodes
 * (for the "any episode played" series rule), and played `UserData` rows.
 *
 * **Why an interface at all, with only one implementation.** The spike
 * (see `sqliteSource.ts`'s header comment for the full writeup) found the
 * REST path blocked on missing credentials — this app has no
 * `JELLYFIN_API_KEY` yet, and creating one is a production change needing
 * operator sign-off. So today there is exactly one implementation,
 * `SqliteJellyfinPlaybackSource` — the documented DB-read fallback
 * (`wiki/Architecture.md` "Read the APIs, not other services' SQLite
 * files" — a read-only DB open is the permitted exception, *if* documented
 * as one, which this is). `src/lib/playback/sync.ts` and every test are
 * written against this interface, not against SQLite directly, so a
 * REST-backed implementation can be dropped in later — once a dedicated key
 * exists — without touching the sync logic or its tests.
 */

/**
 * One (item, user) row with `PlayCount > 0` — the only rows either the
 * reference script or this app care about; an unplayed item contributes
 * nothing.
 *
 * `played`/`positionTicks` were added for `FR-ACCT-6` (revised): capturing
 * Jellyfin's `Played`/`PlaybackPositionTicks` alongside play count/last-played
 * is what lets `FR-DEL-4`'s `in_progress` deletion guard distinguish "someone
 * finished this" from "someone is partway through and hasn't come back" —
 * `positionTicks > 0` with `played = false` is exactly that unfinished
 * signal. Confirmed true of both the `SqliteJellyfinPlaybackSource`
 * and REST paths: every row with `PlaybackPositionTicks > 0` also has
 * `PlayCount > 0`, so the existing `PlayCount > 0` filter
 * already captures every unfinished row — no separate query needed.
 */
export interface JellyfinUserPlayback {
  /** Normalised Jellyfin user GUID (no dashes, lowercase) — matches `member.jellyfin_user_id` (`wiki/Data-Model.md` §member). */
  jellyfinUserId: string;
  /** De-duplicated across any repeated `UserData` rows for the same (item, user) — see `sqliteSource.ts` for why duplicates exist and why `MAX` (not `SUM`) is the correct collapse. */
  playCount: number;
  /** Unix seconds, or `null` if Jellyfin recorded no `LastPlayedDate`. */
  lastPlayedAt: number | null;
  /** Jellyfin's `UserData.Played` — finished, as opposed to merely started (`wiki/Data-Model.md` §playback). */
  played: boolean;
  /** Jellyfin's `UserData.PlaybackPositionTicks` (100-ns .NET ticks, passed through verbatim — same unit in the SQLite DB and the REST API, no conversion). `0` when there is no resume position. */
  positionTicks: number;
}

export interface JellyfinMovieItem {
  /** Normalised Jellyfin item GUID. */
  itemId: string;
  /** From the `Tmdb` provider id, join key to `title.tmdb_id` (`FR-ACCT-4`). `null` if Jellyfin has no Tmdb provider id for this item. */
  tmdbId: number | null;
}

export interface JellyfinSeriesItem {
  /** Normalised Jellyfin item GUID. */
  itemId: string;
  /** From the `Tvdb` provider id, join key to `title.tvdb_id` (`FR-ACCT-4`). `null` if Jellyfin has no Tvdb provider id for this item. */
  tvdbId: number | null;
}

export interface JellyfinEpisodeItem {
  /** Normalised Jellyfin item GUID. */
  itemId: string;
  /** Normalised parent series item GUID, or `null` if Jellyfin didn't record one (orphaned episode — excluded from every series' episode list). */
  seriesId: string | null;
  /**
   * Jellyfin's `ParentIndexNumber` (present by default on both the REST
   * and SQLite paths, no query-shape change needed). `null` when Jellyfin
   * didn't record one for this episode (e.g. a special with no season
   * assignment) — `../playback/sync.ts` excludes such an episode from every
   * per-season bucket while still counting it in the whole-series bucket, so
   * a missing season number can never crash bucketing or silently vanish
   * from the series-level aggregate.
   */
  seasonNumber: number | null;
}

export interface JellyfinPlaybackSource {
  /** Every movie in the Jellyfin library, with its resolved TMDB provider id (or `null`). */
  listMovies(): Promise<JellyfinMovieItem[]>;
  /** Every TV series in the Jellyfin library, with its resolved TVDB provider id (or `null`). */
  listSeries(): Promise<JellyfinSeriesItem[]>;
  /** Every episode in the Jellyfin library, with its parent series id — used to implement "a series counts as played if ANY episode has been played" (`FR-ACCT-6`). */
  listEpisodes(): Promise<JellyfinEpisodeItem[]>;
  /** Every (item, user) pair with `PlayCount > 0`, keyed by normalised item id. */
  listPlayedUserData(): Promise<Map<string, JellyfinUserPlayback[]>>;
}
