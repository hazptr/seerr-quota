/**
 * Playback sync — Jellyfin `BaseItems`/`UserData` (via `JellyfinPlaybackSource`,
 * `../jellyfin/types.ts`) → the `playback` table, plus the derived
 * `title.watched_by_anyone` / `title.last_played_any_at` columns
 * (`wiki/Data-Model.md` §playback, `FR-ACCT-6`, `wiki/Backlog.md` P1-4).
 *
 * **Join key (`FR-ACCT-4`/`FR-ACCT-6`).** `title.tmdb_id` (movies) /
 * `title.tvdb_id` (series) — already synced from Radarr/Sonarr by
 * `../library/sync.ts` — are matched against the Jellyfin source's resolved
 * `Tmdb`/`Tvdb` provider ids, never against Seerr's `jellyfinMediaId` (see
 * `../jellyfin/sqliteSource.ts`'s header comment for why: that field is
 * nullable and was null on every live row checked).
 *
 * **A TV series counts as played if ANY episode has been played by that user**
 * (`FR-ACCT-6`, matching `analyze_watch_history.py`): for a `tv` title, every
 * episode under its matched series item is checked, and a user's plays are
 * combined across all of them (play_count summed, last_played_at maxed — see
 * `mergeEpisodeUser` below).
 *
 * **Failure isolation (`FR-ACCT-10`: never let missing playback state zero a
 * size or flip a watched flag to false).** Two distinct kinds of "no data,"
 * handled differently:
 *
 *   1. **The whole fetch fails** (Jellyfin unreachable / DB unreadable) —
 *      `syncPlayback` wraps all four source reads in one `runStep` (from
 *      `../http/syncStep.ts`, which never throws); on failure NOTHING is
 *      written — every existing `playback` row and every `title.
 *      watched_by_anyone`/`last_played_any_at` value is left exactly as it
 *      was. `last_synced_at` simply doesn't advance, which IS the staleness
 *      signal (same convention as `../library/sync.ts`).
 *   2. **One title has no match in a SUCCESSFUL fetch** (not yet indexed by
 *      Jellyfin, or a stale/renamed provider id) — that single title is
 *      skipped and left untouched, exactly like case 1, rather than written
 *      as "unwatched." Only a title that DOES resolve to a Jellyfin item this
 *      run gets a fresh write — including a fresh `watched_by_anyone: false`
 *      if the (successfully fetched) data genuinely shows nobody has played
 *      it. That's a real, current, successful observation, not missing data,
 *      so it's correct to write it.
 *
 * See `test/playback-sync.test.ts` for the regression tests, including the
 * "Jellyfin down after a title was already known-watched" case this
 * correctness bar exists to prevent.
 *
 * ## `played` / `positionTicks` / `episodesPlayed` / `episodesTotal` (`FR-ACCT-6`, revised)
 *
 * For a MOVIE these are a direct passthrough of the matched Jellyfin item's
 * own `UserData.Played`/`PlaybackPositionTicks` for that user.
 *
 * For a `tv` title they're aggregated across every episode a user has played
 * (`mergeEpisodeUser` below): `episodesPlayed` counts the distinct episodes
 * the user has ANY play on (each entry merged in already satisfies
 * `PlayCount > 0`, per `JellyfinPlaybackSource.listPlayedUserData`'s own
 * contract), `episodesTotal` is the series' total episode count (same value
 * for every user of that title), `played = episodesPlayed > 0` (matching
 * `FR-ACCT-6`'s "played if ANY episode has been played" — the same rule
 * already used for `title.watched_by_anyone`), and `positionTicks` is the
 * MAX across the user's episodes — informational only; the `in_progress`
 * deletion guard (`src/lib/deletion/guards.ts`) keys TV's unfinished signal
 * on `episodesPlayed`/`episodesTotal`, not this column.
 *
 * ## Source selection (`JELLYFIN_PLAYBACK_SOURCE`, `P3-7`)
 *
 * `resolveJellyfinPlaybackSource` below picks `RestJellyfinPlaybackSource`
 * (`../jellyfin/restSource.ts`) or `SqliteJellyfinPlaybackSource`
 * (`../jellyfin/sqliteSource.ts`) from `getConfig().upstreams.
 * jellyfinPlaybackSource` — both already implement the same
 * `JellyfinPlaybackSource` interface, so nothing else in this file branches
 * on which one is active.
 *
 * ## Season-scoped watched state (P4-1 Wave 2)
 *
 * A season counts as played using the exact same rule the whole series
 * already uses, one level down: **any episode within that season played by
 * a user, by anyone.** Mechanically this is `mergeEpisodeUser` (above) run
 * a second time, scoped to a `(seriesItemId, seasonNumber)` episode bucket
 * instead of the whole-series bucket — nothing about the merge rule itself
 * changes.
 *
 * `episodeItemsBySeriesId` (whole-series) and `episodeItemsBySeriesAndSeason`
 * (per-season) below are built from the SAME `episodes` list in one pass. An
 * episode with `seasonNumber: null` (a special Jellyfin didn't assign a
 * season to) is added to the whole-series bucket as always, but simply
 * skipped for season bucketing — it can never crash bucketing, and it is
 * "missing" only from a season's aggregate, not from the series' one, which
 * matches the file header's general principle: never let missing/unusual
 * data silently zero or falsely flip an aggregate.
 *
 * A season `title` row (`series:{arrId}:s{n}`, Wave 1) is skipped by
 * `isSeasonTitleId` in the main per-title loop and written EXCLUSIVELY from
 * the split-series branch inside the whole-series row's own iteration
 * (`row.splitIntoSeasons`) — never from the default per-tvdb path, which
 * would otherwise resolve the season row to the SAME Jellyfin series item as
 * its parent and wrongly aggregate every episode of the whole series onto
 * it. The whole-series write always happens first and is never skipped or
 * altered by a series being split — Wave 1's "the whole-series row keeps
 * syncing, frozen only from attribution" design applies here identically:
 * this file keeps writing its existing all-episodes aggregate for as long as
 * it's synced, in ADDITION to (never instead of) the new season writes.
 *
 * For an unsplit series (`split_into_seasons = false`, every series in
 * production as of this wave), `row.splitIntoSeasons` is `false`, so the
 * split branch's body never runs — zero extra `writeTitlePlayback` calls,
 * zero extra DB writes, byte-identical output to before this wave.
 */
import { desc, eq } from 'drizzle-orm';
import { getConfig } from '../config';
import { getDb, type SeerrQuotaDb } from '../db';
import { playback, syncRun, title } from '../db/schema';
import { runStep, type StepResult } from '../http/syncStep';
import { createRestJellyfinPlaybackSource } from '../jellyfin/restSource';
import { createSqliteJellyfinPlaybackSource } from '../jellyfin/sqliteSource';
import type { JellyfinPlaybackSource, JellyfinUserPlayback } from '../jellyfin/types';

/**
 * True for a P4-1 season title row (`series:{arrId}:s{n}`), as opposed to
 * its parent whole-series row (`series:{arrId}`) or a movie row
 * (`movie:{arrId}`, never matches — no `:s\d+` suffix is ever produced for
 * a movie id). Used to keep the main per-tvdb loop below from processing a
 * season row as if it were its own series (see this file's header comment,
 * "Season-scoped watched state").
 */
const SEASON_TITLE_ID_PATTERN = /:s\d+$/;
function isSeasonTitleId(titleId: string): boolean {
  return SEASON_TITLE_ID_PATTERN.test(titleId);
}

interface UserAggregate {
  playCount: number;
  lastPlayedAt: number | null;
  played: boolean;
  positionTicks: number;
  /** `null` for a movie row; set for a `tv` row (see this file's header comment). */
  episodesPlayed: number | null;
  episodesTotal: number | null;
}

/** Combines one more episode's playback for a user into their series-level total — see this file's header comment ("played / positionTicks / episodesPlayed / episodesTotal"). `episodesTotal` is passed on every call (cheap, constant per series) rather than patched in afterward, so `map` never has a moment where a user's `episodesTotal` disagrees with their `episodesPlayed`. */
function mergeEpisodeUser(map: Map<string, UserAggregate>, userId: string, entry: JellyfinUserPlayback, episodesTotal: number): void {
  const existing = map.get(userId);
  if (!existing) {
    map.set(userId, {
      playCount: entry.playCount,
      lastPlayedAt: entry.lastPlayedAt,
      played: true, // this merge call itself IS one played episode (FR-ACCT-6: any episode played -> played)
      positionTicks: entry.positionTicks,
      episodesPlayed: 1,
      episodesTotal,
    });
    return;
  }
  existing.playCount += entry.playCount;
  if (entry.lastPlayedAt !== null && (existing.lastPlayedAt === null || entry.lastPlayedAt > existing.lastPlayedAt)) {
    existing.lastPlayedAt = entry.lastPlayedAt;
  }
  if (entry.positionTicks > existing.positionTicks) existing.positionTicks = entry.positionTicks;
  existing.episodesPlayed = (existing.episodesPlayed ?? 0) + 1;
  existing.episodesTotal = episodesTotal;
}

/**
 * Writes one title's `playback` rows (one per user who has played it) and
 * its derived `title.watched_by_anyone`/`last_played_any_at` columns, from a
 * SUCCESSFULLY resolved set of per-user aggregates. Only called for a title
 * that matched a Jellyfin item this run — see this file's header comment,
 * case 2. `users` may be empty (matched item, genuinely never played) — that
 * is a real negative result and is written as such.
 */
function writeTitlePlayback(titleId: string, users: Map<string, UserAggregate>, nowSeconds: number): void {
  const db = getDb();
  let watchedByAnyone = false;
  let lastPlayedAnyAt: number | null = null;

  for (const [jellyfinUserId, agg] of users) {
    watchedByAnyone = true;
    if (agg.lastPlayedAt !== null && (lastPlayedAnyAt === null || agg.lastPlayedAt > lastPlayedAnyAt)) {
      lastPlayedAnyAt = agg.lastPlayedAt;
    }
    db.insert(playback)
      .values({
        titleId,
        jellyfinUserId,
        playCount: agg.playCount,
        played: agg.played,
        positionTicks: agg.positionTicks,
        episodesPlayed: agg.episodesPlayed,
        episodesTotal: agg.episodesTotal,
        lastPlayedAt: agg.lastPlayedAt,
        lastSyncedAt: nowSeconds,
      })
      .onConflictDoUpdate({
        target: [playback.titleId, playback.jellyfinUserId],
        set: {
          playCount: agg.playCount,
          played: agg.played,
          positionTicks: agg.positionTicks,
          episodesPlayed: agg.episodesPlayed,
          episodesTotal: agg.episodesTotal,
          lastPlayedAt: agg.lastPlayedAt,
          lastSyncedAt: nowSeconds,
        },
      })
      .run();
  }

  db.update(title).set({ watchedByAnyone, lastPlayedAnyAt }).where(eq(title.id, titleId)).run();
}

/**
 * The P1-4 reconcile step: reads every `title` row and, for each one that
 * resolves to a Jellyfin item this run, writes its playback state. Never
 * throws (wrapped in `runStep`); on any failure of the underlying fetch,
 * returns `{ok: false, count: 0, ...}` and the DB is left completely
 * untouched (see this file's header comment).
 *
 * `count` in the returned `StepResult` is the number of titles that
 * resolved to a Jellyfin item and were (re)written this run — titles with no
 * match are not counted, since nothing was written for them.
 */
export async function syncPlayback(
  source: JellyfinPlaybackSource,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<StepResult> {
  const { result } = await runStep(async () => {
    const [movies, series, episodes, playedByItem] = await Promise.all([
      source.listMovies(),
      source.listSeries(),
      source.listEpisodes(),
      source.listPlayedUserData(),
    ]);

    const movieItemByTmdb = new Map<number, string>();
    for (const m of movies) {
      if (m.tmdbId !== null) movieItemByTmdb.set(m.tmdbId, m.itemId);
    }

    const seriesItemByTvdb = new Map<number, string>();
    for (const s of series) {
      if (s.tvdbId !== null) seriesItemByTvdb.set(s.tvdbId, s.itemId);
    }

    const episodeItemsBySeriesId = new Map<string, string[]>();
    /** `seriesItemId -> seasonNumber -> episode itemIds` (P4-1 Wave 2 — see this file's header comment). */
    const episodeItemsBySeriesAndSeason = new Map<string, Map<number, string[]>>();
    for (const e of episodes) {
      if (!e.seriesId) continue;
      const list = episodeItemsBySeriesId.get(e.seriesId);
      if (list) list.push(e.itemId);
      else episodeItemsBySeriesId.set(e.seriesId, [e.itemId]);

      // An episode with no season number is counted in the whole-series
      // bucket above (unchanged) but excluded from every season bucket —
      // see this file's header comment.
      if (e.seasonNumber === null) continue;
      let bySeason = episodeItemsBySeriesAndSeason.get(e.seriesId);
      if (!bySeason) {
        bySeason = new Map<number, string[]>();
        episodeItemsBySeriesAndSeason.set(e.seriesId, bySeason);
      }
      const seasonList = bySeason.get(e.seasonNumber);
      if (seasonList) seasonList.push(e.itemId);
      else bySeason.set(e.seasonNumber, [e.itemId]);
    }

    const titles = getDb().select().from(title).all();
    const matchedTitleIds: string[] = [];

    for (const row of titles) {
      if (row.mediaType === 'movie') {
        if (row.tmdbId === null) continue;
        const itemId = movieItemByTmdb.get(row.tmdbId);
        if (!itemId) continue; // no Jellyfin match this run — leave stale (case 2 above)

        const users = new Map<string, UserAggregate>();
        for (const p of playedByItem.get(itemId) ?? []) {
          users.set(p.jellyfinUserId, {
            playCount: p.playCount,
            lastPlayedAt: p.lastPlayedAt,
            played: p.played,
            positionTicks: p.positionTicks,
            episodesPlayed: null,
            episodesTotal: null,
          });
        }
        writeTitlePlayback(row.id, users, nowSeconds);
        matchedTitleIds.push(row.id);
      } else {
        // P4-1 Wave 2: a season title row is written exclusively from the
        // split-series branch below, when ITS PARENT whole-series row is
        // processed — never here (see this file's header comment for why).
        if (isSeasonTitleId(row.id)) continue;

        if (row.tvdbId === null) continue;
        const seriesItemId = seriesItemByTvdb.get(row.tvdbId);
        if (!seriesItemId) continue; // no Jellyfin match this run — leave stale (case 2 above)

        const episodeItemIds = episodeItemsBySeriesId.get(seriesItemId) ?? [];
        const episodesTotal = episodeItemIds.length;
        const users = new Map<string, UserAggregate>();
        for (const episodeItemId of episodeItemIds) {
          for (const p of playedByItem.get(episodeItemId) ?? []) {
            mergeEpisodeUser(users, p.jellyfinUserId, p, episodesTotal);
          }
        }
        writeTitlePlayback(row.id, users, nowSeconds);
        matchedTitleIds.push(row.id);

        // P4-1 Wave 2: for a series split into season title rows (Wave 1,
        // `title.split_into_seasons`), ALSO write a season-scoped playback
        // aggregate for every season Jellyfin currently reports episodes
        // for — in ADDITION to the whole-series write above, never instead
        // of it. Unsplit series (every series in production today) have
        // `splitIntoSeasons: false`, so this block is a strict no-op and
        // produces zero extra writes — the hard non-regression requirement
        // for this wave.
        if (row.splitIntoSeasons) {
          const bySeason = episodeItemsBySeriesAndSeason.get(seriesItemId);
          if (bySeason) {
            for (const [seasonNumber, seasonEpisodeItemIds] of bySeason) {
              const seasonTitleId = `${row.id}:s${seasonNumber}`;
              const seasonEpisodesTotal = seasonEpisodeItemIds.length;
              const seasonUsers = new Map<string, UserAggregate>();
              for (const episodeItemId of seasonEpisodeItemIds) {
                for (const p of playedByItem.get(episodeItemId) ?? []) {
                  mergeEpisodeUser(seasonUsers, p.jellyfinUserId, p, seasonEpisodesTotal);
                }
              }
              writeTitlePlayback(seasonTitleId, seasonUsers, nowSeconds);
              matchedTitleIds.push(seasonTitleId);
            }
          }
        }
      }
    }

    return matchedTitleIds;
  });

  return result;
}

/** One row in `sync_run`, mirroring `../library/sync.ts`'s `recordSyncRun` — a separate local function, not a shared import, since `src/lib/library/sync.ts` is a different module this file doesn't modify. A future full-reconciler orchestrator (post attribution, P1-6+) can merge this step's key into the same run as library/request sync's, per that file's own header comment ("a future full-reconciler orchestrator can merge additional step keys into the same sync_run shape"). */
function recordSyncRun(steps: Record<string, StepResult>, startedAtSeconds: number, finishedAtSeconds: number): number {
  const db = getDb();
  const ok = Object.values(steps).every((s) => s.ok);
  const row = db
    .insert(syncRun)
    .values({ startedAt: startedAtSeconds, finishedAt: finishedAtSeconds, steps: JSON.stringify(steps), ok })
    .returning({ id: syncRun.id })
    .get();
  return row.id;
}

/**
 * `JELLYFIN_DB_PATH` — read directly from `process.env` rather than
 * `getConfig()` (even though `config.ts` already carries the equivalent
 * `paths.jellyfinDbPath`), for the same "a test can override it before
 * first use without touching the config singleton" reason
 * `src/lib/db/index.ts`'s `DB_PATH` read documents.
 * Defaults to the container-side path Jellyfin's
 * `configs/jellyfin/data/data/jellyfin.db` is bind-mounted **read-only** at
 * (`docker-compose.yml`).
 */
function resolveJellyfinDbPath(): string {
  return process.env.JELLYFIN_DB_PATH ?? '/jellyfin-db/jellyfin.db';
}

/**
 * Selects the live `JellyfinPlaybackSource` from `getConfig().upstreams.
 * jellyfinPlaybackSource` (`JELLYFIN_PLAYBACK_SOURCE`, `rest` default | `db`)
 * — this file's header comment "Source selection" section. Both
 * implementations satisfy the exact same interface, so nothing downstream
 * (`syncPlayback`, the deletion guards) needs to know or care which one is
 * active.
 */
function resolveJellyfinPlaybackSource(): JellyfinPlaybackSource {
  const config = getConfig();
  if (config.upstreams.jellyfinPlaybackSource === 'rest') {
    return createRestJellyfinPlaybackSource(
      config.upstreams.jellyfinUrl,
      config.secrets.jellyfinApiKey,
      config.scheduling.upstreamTimeoutMs,
      config.scheduling.upstreamRetries,
    );
  }
  return createSqliteJellyfinPlaybackSource(resolveJellyfinDbPath());
}

export interface PlaybackSyncDeps {
  source?: JellyfinPlaybackSource;
}

export interface PlaybackSyncRunResult {
  playback: StepResult;
  syncRunId: number;
}

/**
 * Top-level entry point, mirroring `../library/sync.ts`'s
 * `runLibraryAndRequestSync` shape: builds a real source via
 * `resolveJellyfinPlaybackSource` when none is injected, runs `syncPlayback`,
 * and records one `sync_run` row with a single `playback` step key.
 */
export async function runPlaybackSync(
  deps: PlaybackSyncDeps = {},
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<PlaybackSyncRunResult> {
  const source = deps.source ?? resolveJellyfinPlaybackSource();
  const startedAt = Math.floor(Date.now() / 1000);

  const playbackResult = await syncPlayback(source, nowSeconds);

  const finishedAt = Math.floor(Date.now() / 1000);
  const syncRunId = recordSyncRun({ playback: playbackResult }, startedAt, finishedAt);

  return { playback: playbackResult, syncRunId };
}

const SYNC_RUN_SCAN_LIMIT = 20;

interface SyncRunStepsShape {
  playback?: { ok: boolean };
}

/**
 * `FR-DEL-21` support: the most recent `sync_run` whose `playback` step
 * actually succeeded, or `undefined` if none has (this app has never
 * completed a playback sync, or every attempt on record failed). Mirrors
 * `src/lib/enforcement/usage.ts`'s `findLatestAttributionSnapshot` — same
 * "scan the last N sync_run rows newest-first, parse `steps`, stop at the
 * first `ok: true`" shape, kept as an independent copy here rather than an
 * import because that module is out of this file's scope to modify.
 *
 * `src/lib/deletion/guards.ts` uses this (plus `STALE_SNAPSHOT_MAX_AGE_S`)
 * to decide `GuardContext.playbackUnavailable` — closing a fail-open gap: a
 * step that failed outright wrote NOTHING (see this file's header comment,
 * "Failure isolation" case 1), so
 * `title.watched_by_anyone` staying `false` across every title is
 * indistinguishable, from that column alone, from "successfully confirmed
 * nobody watched anything." This function is what lets a caller tell the
 * two apart.
 */
export function findLatestSuccessfulPlaybackSync(db: SeerrQuotaDb): { finishedAt: number } | undefined {
  const rows = db
    .select({ finishedAt: syncRun.finishedAt, steps: syncRun.steps })
    .from(syncRun)
    .orderBy(desc(syncRun.id))
    .limit(SYNC_RUN_SCAN_LIMIT)
    .all();

  for (const row of rows) {
    if (row.finishedAt === null) continue;
    let steps: SyncRunStepsShape;
    try {
      steps = JSON.parse(row.steps) as SyncRunStepsShape;
    } catch {
      continue;
    }
    if (steps.playback?.ok === true) {
      return { finishedAt: row.finishedAt };
    }
  }
  return undefined;
}
