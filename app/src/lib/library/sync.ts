/**
 * Library sync — Radarr movies + Sonarr series → the `title` table
 * (`wiki/Data-Model.md` §title, `wiki/Backlog.md` P1-5), plus the combined
 * "library & request sync" entry point (`runLibraryAndRequestSync`) that
 * also pulls Seerr requests (`../seerr/sync.ts`) and records every step's
 * outcome into `sync_run` (`wiki/Data-Model.md` §sync_run: "Per-step
 * `{ok, count, ms, error}` for the six reconciler steps").
 *
 * **Single-instance deployment note (`FR-ACCT-5`).** `wiki/Configuration.md`
 * §"Upstream endpoints" declares exactly one `RADARR_URL` and one
 * `SONARR_URL` — this deployment has no separate 4K Radarr/Sonarr host (see
 * `wiki/Data-Model.md` §title's "4K caveat" note: Seerr's non-4K and 4K
 * server slots both point at the SAME physical Radarr/Sonarr). So this sync
 * only ever writes `arr_instance: 'radarr' | 'sonarr'` — never the `-4k`
 * schema variants, which exist for a future multi-instance deployment this
 * one isn't. `FR-ACCT-5`'s "key on the physical (arr host, arr_id) pair" is
 * satisfied structurally: there is exactly one arr host per media type to
 * sync from, so `title.id` (`movie:{arrId}` / `series:{arrId}`) can never
 * collide across a 4K/non-4K distinction the way it could with two hosts.
 * The double-counting risk `FR-ACCT-5` warns about is a Seerr-request-side
 * concern (two requests, `is4k` true/false, both resolving to the SAME
 * `title` row via `tmdbId`/`tvdbId`) — that resolution is attribution's job
 * (`P1-6`), not this sync's.
 *
 * **Failure isolation (`FR-ACCT-10`).** Movies and series are synced
 * independently via `runStep` (`../http/syncStep.ts`, which never throws) —
 * a Sonarr outage cannot prevent the Radarr upsert from running, and vice
 * versa. A title absent from the current fetch is left completely untouched:
 * not deleted, not zeroed, and its `last_synced_at` simply doesn't advance —
 * that non-advancement IS the staleness signal (`wiki/Data-Model.md` §title:
 * "Titles that vanish upstream are marked `last_synced_at` stale ... not
 * deleted, so the audit log's foreign references stay resolvable").
 *
 * `protected`/`protected_reason` (the operator pin, `D-6`) and
 * `watched_by_anyone`/`last_played_any_at` (owned by the not-yet-built
 * playback sync, P1-4) are deliberately never written by the `set` clause
 * below — an upsert here must not clobber columns this sync doesn't own.
 */
import { eq } from 'drizzle-orm';
import { getConfig } from '../config';
import { getDb } from '../db';
import { syncRun, title } from '../db/schema';
import { runStep, type StepResult } from '../http/syncStep';
import { createRadarrClient, type RadarrClient, type RadarrMovie } from './radarr';
import { createSonarrClient, type SonarrClient, type SonarrSeries } from './sonarr';
import { aggregateBytesBySeason, createSonarrEpisodeFileClient, type SonarrEpisodeFileClient } from './sonarrEpisodeFiles';
import { createSeerrClient, type SeerrClient } from '../seerr/client';
import { syncRequests } from '../seerr/sync';
import type { SeerrRequest } from '../seerr/types';

export interface LibrarySyncResult {
  movies: StepResult;
  series: StepResult;
}

function parseIsoToUnixSeconds(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

function upsertMovies(movies: RadarrMovie[], nowSeconds: number): void {
  const db = getDb();
  for (const m of movies) {
    const id = `movie:${m.id}`;
    const addedAt = parseIsoToUnixSeconds(m.added);
    db.insert(title)
      .values({
        id,
        mediaType: 'movie',
        arrInstance: 'radarr',
        arrId: m.id,
        tmdbId: m.tmdbId,
        tvdbId: null,
        title: m.title,
        year: m.year,
        sizeBytes: m.sizeOnDisk,
        path: m.path,
        addedAt,
        lastSyncedAt: nowSeconds,
      })
      .onConflictDoUpdate({
        target: title.id,
        set: {
          tmdbId: m.tmdbId,
          title: m.title,
          year: m.year,
          sizeBytes: m.sizeOnDisk,
          path: m.path,
          addedAt,
          lastSyncedAt: nowSeconds,
        },
      })
      .run();
  }
}

/**
 * P4-1 Wave 1 (additive, gated off by default — see `wiki/Data-Model.md`
 * §title). For a series whose whole-series `title` row already has
 * `split_into_seasons = true` (only ever set by a later wave's
 * operator-triggered action — nothing in this repo sets it yet), also
 * upsert one `series:{sonarrId}:s{n}` row per season that actually has
 * bytes on disk, sized from real per-file data
 * (`./sonarrEpisodeFiles.ts`) rather than a second, unverified field on the
 * series response.
 *
 * Judgment calls made here (flagged since the plan left them open):
 *  - **`path`**: Sonarr has no per-season path (`path`/
 *    `relativePath` are per-FILE, not per-season-folder), so a season row
 *    reuses the parent series' on-disk `path` unchanged rather than
 *    fabricating a `.../Season 01` subfolder this app can't verify for
 *    every library layout.
 *  - **`title`**: `"{series title} — Season {n}"`, per the plan's own
 *    example.
 *  - **`year`/`added_at`**: copied from the parent series (Sonarr doesn't
 *    give a per-season value for either) — display-only fields, harmless
 *    to inherit.
 *  - **Seasons with zero episode files** never get a row: there is nothing
 *    to size or delete yet, matching why `aggregateBytesBySeason` simply
 *    omits them (see that function's own comment).
 *
 * Exported (Wave 3) so the new operator split action
 * (`src/app/admin/_actions/splitSeriesActions.ts`) can call the exact same
 * upsert this file's own regular sync loop uses, rather than a second,
 * potentially-drifting reimplementation — the trigger this comment's first
 * paragraph says "no later wave has built yet" is now that action.
 */
export async function upsertSeasonsForSplitSeries(s: SonarrSeries, sonarrEpisodeFiles: SonarrEpisodeFileClient, nowSeconds: number): Promise<void> {
  const db = getDb();
  const files = await sonarrEpisodeFiles.listEpisodeFiles(s.id);
  const bytesBySeason = aggregateBytesBySeason(files);
  const addedAt = parseIsoToUnixSeconds(s.added);

  for (const [seasonNumber, sizeBytes] of bytesBySeason) {
    const id = `series:${s.id}:s${seasonNumber}`;
    const seasonTitle = `${s.title} — Season ${seasonNumber}`;
    db.insert(title)
      .values({
        id,
        mediaType: 'tv',
        arrInstance: 'sonarr',
        arrId: s.id,
        tmdbId: null,
        tvdbId: s.tvdbId,
        title: seasonTitle,
        year: s.year,
        sizeBytes,
        path: s.path,
        addedAt,
        lastSyncedAt: nowSeconds,
      })
      .onConflictDoUpdate({
        target: title.id,
        set: {
          tvdbId: s.tvdbId,
          title: seasonTitle,
          year: s.year,
          sizeBytes,
          path: s.path,
          addedAt,
          lastSyncedAt: nowSeconds,
        },
      })
      .run();
  }
}

async function upsertSeries(series: SonarrSeries[], sonarrEpisodeFiles: SonarrEpisodeFileClient, nowSeconds: number): Promise<void> {
  const db = getDb();
  for (const s of series) {
    const id = `series:${s.id}`;
    const addedAt = parseIsoToUnixSeconds(s.added);
    db.insert(title)
      .values({
        id,
        mediaType: 'tv',
        arrInstance: 'sonarr',
        arrId: s.id,
        tmdbId: null,
        tvdbId: s.tvdbId,
        title: s.title,
        year: s.year,
        sizeBytes: s.sizeOnDisk,
        path: s.path,
        addedAt,
        lastSyncedAt: nowSeconds,
      })
      .onConflictDoUpdate({
        target: title.id,
        set: {
          tvdbId: s.tvdbId,
          title: s.title,
          year: s.year,
          sizeBytes: s.sizeOnDisk,
          path: s.path,
          addedAt,
          lastSyncedAt: nowSeconds,
        },
      })
      .run();

    // Wave 1's gate: every series is unsplit by default, so this reads
    // `false` and the season fetch/upsert below never runs for the entire
    // existing library — zero extra Sonarr calls, zero extra rows.
    const row = db.select({ splitIntoSeasons: title.splitIntoSeasons }).from(title).where(eq(title.id, id)).get();
    if (row?.splitIntoSeasons) {
      await upsertSeasonsForSplitSeries(s, sonarrEpisodeFiles, nowSeconds);
    }
  }
}

/**
 * Radarr `GET /api/v3/movie` + Sonarr `GET /api/v3/series` → `title` rows.
 * Each source is independently retryable/failure-isolated (see file header);
 * this function itself never throws.
 */
export async function syncLibrary(
  radarr: RadarrClient,
  sonarr: SonarrClient,
  sonarrEpisodeFiles: SonarrEpisodeFileClient,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<LibrarySyncResult> {
  const { result: movies } = await runStep(async () => {
    const list = await radarr.listMovies();
    upsertMovies(list, nowSeconds);
    return list;
  });

  const { result: series } = await runStep(async () => {
    const list = await sonarr.listSeries();
    await upsertSeries(list, sonarrEpisodeFiles, nowSeconds);
    return list;
  });

  return { movies, series };
}

/** One row in `sync_run`, per `wiki/Data-Model.md` §sync_run. Returns the inserted row's id. */
function recordSyncRun(steps: Record<string, StepResult>, startedAtSeconds: number, finishedAtSeconds: number): number {
  const db = getDb();
  const ok = Object.values(steps).every((s) => s.ok);
  const row = db
    .insert(syncRun)
    .values({
      startedAt: startedAtSeconds,
      finishedAt: finishedAtSeconds,
      steps: JSON.stringify(steps),
      ok,
    })
    .returning({ id: syncRun.id })
    .get();
  return row.id;
}

export interface LibraryAndRequestSyncDeps {
  radarr?: RadarrClient;
  sonarr?: SonarrClient;
  sonarrEpisodeFiles?: SonarrEpisodeFileClient;
  seerr?: SeerrClient;
}

export interface LibraryAndRequestSyncResult {
  movies: StepResult;
  series: StepResult;
  requests: StepResult;
  requestList: SeerrRequest[];
  syncRunId: number;
}

/**
 * Test seam — mirrors `src/lib/members/sync.ts`'s `MemberSyncDeps`
 * pattern: any client the caller injects is used as-is; anything omitted is
 * built from `getConfig()` (already a cached singleton, so calling it here
 * even when every client is injected — the common case in this file's own
 * tests — is cheap and side-effect-free).
 */
function resolveClients(deps: LibraryAndRequestSyncDeps): Required<LibraryAndRequestSyncDeps> {
  const config = getConfig();
  return {
    radarr:
      deps.radarr ??
      createRadarrClient(
        config.upstreams.radarrUrl,
        config.secrets.radarrApiKey,
        config.scheduling.upstreamTimeoutMs,
        config.scheduling.upstreamRetries,
      ),
    sonarr:
      deps.sonarr ??
      createSonarrClient(
        config.upstreams.sonarrUrl,
        config.secrets.sonarrApiKey,
        config.scheduling.upstreamTimeoutMs,
        config.scheduling.upstreamRetries,
      ),
    sonarrEpisodeFiles:
      deps.sonarrEpisodeFiles ??
      createSonarrEpisodeFileClient(
        config.upstreams.sonarrUrl,
        config.secrets.sonarrApiKey,
        config.scheduling.upstreamTimeoutMs,
        config.scheduling.upstreamRetries,
      ),
    seerr:
      deps.seerr ??
      createSeerrClient(
        config.upstreams.seerrUrl,
        config.secrets.seerrApiKey,
        config.scheduling.upstreamTimeoutMs,
        config.scheduling.upstreamRetries,
      ),
  };
}

/**
 * The P1-5 reconcile step: library sync (movies + series) and request sync,
 * run together, with one `sync_run` row recording all three per-source
 * outcomes. Corresponds to reconciler steps 2 ("Request sync") and 3
 * ("Library sync") in `wiki/Architecture.md` §Reconciler — steps 1
 * (identity), 4 (playback), 5 (attribution), and 6 (pending sweep) are later
 * backlog items and are NOT included in this function's `steps` JSON; a
 * future full-reconciler orchestrator can merge additional step keys into
 * the same `sync_run` shape.
 *
 * Deps are injectable (a standard test seam); when omitted, real clients are built from
 * `getConfig()`.
 */
export async function runLibraryAndRequestSync(
  deps: LibraryAndRequestSyncDeps = {},
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<LibraryAndRequestSyncResult> {
  const clients = resolveClients(deps);
  const startedAt = Math.floor(Date.now() / 1000);

  const { movies, series } = await syncLibrary(clients.radarr, clients.sonarr, clients.sonarrEpisodeFiles, nowSeconds);
  const { step: requests, requests: requestList } = await syncRequests(clients.seerr);

  const finishedAt = Math.floor(Date.now() / 1000);
  const syncRunId = recordSyncRun({ movies, series, requests }, startedAt, finishedAt);

  return { movies, series, requests, requestList, syncRunId };
}
