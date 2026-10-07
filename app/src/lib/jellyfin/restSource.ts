/**
 * `RestJellyfinPlaybackSource` — the REST-backed `JellyfinPlaybackSource`
 * (`./types.ts`), selected via `JELLYFIN_PLAYBACK_SOURCE=rest`
 * (`src/lib/config.ts`) now that a dedicated Jellyfin API key exists
 * (`.env`'s `JELLYFIN_API_KEY`).
 * Drops in without touching `../playback/sync.ts` or any test written
 * against the interface, exactly as `sqliteSource.ts`'s header comment
 * promised it would.
 *
 * ## Verified live, read-only, before writing this file
 *
 * To avoid building against an unexercised response shape (the mistake
 * already made once against Seerr's stale bundled OpenAPI spec), every
 * endpoint below was exercised with `curl` against a real Jellyfin instance
 * using a real `JELLYFIN_API_KEY`, via the `X-Emby-Token` header — confirmed
 * to work (`GET /Users` → 200; the documented header name is correct).
 * No POST/PUT/PATCH/DELETE was issued.
 *
 * - `GET /Users` → 200, 13 users, `{Id, Name, ...}[]` — `Id` is ALREADY the
 *   compact 32-hex-char form (no dashes, lowercase); `normalizeGuid` is still
 *   applied defensively (idempotent on an already-normalised string).
 * - `GET /Items?recursive=true&includeItemTypes=Movie&fields=ProviderIds`
 *   (no `userId`) → 200, 82 items (matches the SQLite source's
 *   documented 82/82), each with a `ProviderIds: {Tmdb, Tvdb, Imdb, ...}`
 *   object — **not** a flat field, and **not populated at all** unless
 *   `fields=ProviderIds` is requested (confirmed by omission: without it the
 *   field is simply absent from the response).
 * - `GET /Items?recursive=true&includeItemTypes=Series&fields=ProviderIds`
 *   → 200, 95 items (matches the SQLite source's documented 95).
 * - `GET /Items?recursive=true&includeItemTypes=Episode` (no `fields` needed
 *   — `SeriesId` is present by default) → 200, 3279 items in ONE call, no
 *   pagination cap hit (`TotalRecordCount` equalled `Items.length` with no
 *   `limit` param supplied) — every episode carried a non-null `SeriesId` in
 *   this library, though the mapping below still tolerates a missing one
 *   (matches an orphaned episode, same as the SQLite source).
 *
 * ## The one real discrepancy this spike found — NOT what the wiki assumed
 *
 * The wiki's REST sketch (`wiki/Feature-03-Usage-Accounting.md`) reads
 * `GET /Items?userId=<id>&isPlayed=true&recursive=true&includeItemTypes=
 * Movie,Series`. Tried exactly as written, then checked field-by-field
 * against a movie the SQLite source already knows is watched — and found
 * two problems that would have silently broken TV accounting if coded off
 * the wiki text directly:
 *
 * 1. **A `Series` item's own `UserData.PlayCount` is always `0`.** Jellyfin
 *    computes a Series' `UserData` as an aggregate over the WHOLE series
 *    (`UnplayedItemCount`, `Played = (UnplayedItemCount == 0)` — i.e. "have I
 *    finished literally every episode"), never a per-episode play count. That
 *    is the OPPOSITE of `FR-ACCT-6`'s "a series counts as played if ANY
 *    episode has been played" rule — relying on it would make a
 *    partially-watched series (which is most of them) read as unplayed.
 *    Verified live: querying a real user's watched Movie+Series items
 *    directly showed a meaningful number of `Played: true` items while the
 *    underlying `PlayCount` field on every `Series` row was `0`, confirming
 *    the aggregate never touches it.
 * 2. **`isPlayed=true` excludes exactly the rows this app most needs**: an
 *    item with `PlayCount > 0` but `Played: false` (a rewatch-in-progress, or
 *    — the `FR-DEL-4` `in_progress` guard's whole reason for existing — a
 *    resume position with no completion). Verified live: a real user had a
 *    meaningful number of Movie/Series items with `PlayCount > 0` that were
 *    NOT also `Played: true` (a DIFFERENT, non-overlapping-by-construction
 *    set once Series rows — whose own `PlayCount` is always 0 — are
 *    excluded). `isPlayed=true` would have silently dropped every one of
 *    them.
 *
 * The fix: this source does NOT rely on `isPlayed`/Series-level `UserData` at
 * all. It fetches, per user, EVERY `Movie`/`Episode` item (no `Series` — its
 * aggregate is useless here, and `../playback/sync.ts` never looks a Series
 * itemId up in this map anyway, only movie and per-episode itemIds) and
 * filters client-side to `UserData.PlayCount > 0` — the exact same
 * predicate `sqliteSource.ts`'s `WHERE PlayCount > 0` applies, so the two
 * implementations answer the identical question the identical way. Verified
 * for `admin`: 739 of 3361 Movie+Episode items had `PlayCount > 0`,
 * INCLUDING the 11 "rewatch in progress" movies `isPlayed=true` would have
 * missed and episodes with a real resume position
 * (`PlaybackPositionTicks > 0, Played: false` — confirmed present, e.g. one
 * `Baccano!` episode 16% in).
 *
 * ## Timestamps
 *
 * REST returns standard ISO-8601 (`"2024-03-31T23:15:03.7929472Z"`, 7-digit
 * sub-second precision) — a DIFFERENT shape from the SQLite DB's
 * space-separated form `sqliteSource.ts`'s `parseJellyfinTimestamp` parses.
 * `Date.parse` handles the REST form natively (verified in Node: truncates
 * the extra fractional digits rather than failing) — `parseJellyfinTimestamp`
 * must NOT be reused here, since its `raw.replace(' ', 'T') + 'Z'` logic
 * would double up the trailing `Z` on an already-ISO string and produce
 * `NaN`. `parseRestTimestamp` below is the REST-specific equivalent.
 *
 * ## Performance
 *
 * One call each for `/Users`, movies, series, episodes, plus one
 * movie+episode call PER USER (13 users in prod → 13 calls, ~3.2 MB/user,
 * <0.3s each measured live) — acceptable for a periodic reconciler step, not
 * a request-path call. `fields=ProviderIds` is requested only where the
 * provider id is actually read (movies/series); the per-user playback call
 * omits it to shrink the payload, since provider ids are already resolved
 * from the userId-less movie/series calls.
 */
import { apiKeyAuth, UpstreamClient } from '../http/client';
import { normalizeGuid, parseProviderValueAsId } from './sqliteSource';
import type { JellyfinEpisodeItem, JellyfinMovieItem, JellyfinPlaybackSource, JellyfinSeriesItem, JellyfinUserPlayback } from './types';

/** Verified live: `X-Emby-Token: <key>` is accepted by this Jellyfin instance (10.11.11) — the same header both Emby- and Jellyfin-flavoured clients use. */
const AUTH_HEADER = 'X-Emby-Token';

interface RestProviderIds {
  Tmdb?: string;
  Tvdb?: string;
}

interface RestItem {
  Id: string;
  Type: string;
  SeriesId?: string | null;
  /** Season number. Present by default on the exact `/Items?includeItemTypes=Episode` call below — no `fields=` parameter needed, verified against a live Jellyfin instance. Absent/`null` for a special or otherwise unassigned episode. */
  ParentIndexNumber?: number | null;
  ProviderIds?: RestProviderIds;
  UserData?: {
    PlayCount?: number;
    LastPlayedDate?: string | null;
    Played?: boolean;
    PlaybackPositionTicks?: number;
  };
}

interface RestItemsResponse {
  Items: RestItem[];
  TotalRecordCount: number;
}

interface RestUser {
  Id: string;
  Name: string;
}

/** REST's native ISO-8601 timestamp (`"2024-03-31T23:15:03.7929472Z"`) → unix seconds, or `null` for absent/unparseable — see this file's header "Timestamps" section for why `sqliteSource.ts`'s `parseJellyfinTimestamp` must not be reused here. */
export function parseRestTimestamp(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

export class RestJellyfinPlaybackSource implements JellyfinPlaybackSource {
  constructor(private readonly client: UpstreamClient) {}

  async listMovies(): Promise<JellyfinMovieItem[]> {
    const res = await this.client.request<RestItemsResponse>('/Items', {
      query: { recursive: true, includeItemTypes: 'Movie', fields: 'ProviderIds' },
    });
    return res.Items.map((item) => ({
      itemId: normalizeGuid(item.Id),
      tmdbId: parseProviderValueAsId(item.ProviderIds?.Tmdb),
    }));
  }

  async listSeries(): Promise<JellyfinSeriesItem[]> {
    const res = await this.client.request<RestItemsResponse>('/Items', {
      query: { recursive: true, includeItemTypes: 'Series', fields: 'ProviderIds' },
    });
    return res.Items.map((item) => ({
      itemId: normalizeGuid(item.Id),
      tvdbId: parseProviderValueAsId(item.ProviderIds?.Tvdb),
    }));
  }

  async listEpisodes(): Promise<JellyfinEpisodeItem[]> {
    // Deliberately UNCHANGED query — `ParentIndexNumber` is
    // already present in this exact response by default (verified against
    // a live Jellyfin instance), so no `fields=` parameter is added here.
    const res = await this.client.request<RestItemsResponse>('/Items', {
      query: { recursive: true, includeItemTypes: 'Episode' },
    });
    return res.Items.map((item) => ({
      itemId: normalizeGuid(item.Id),
      seriesId: item.SeriesId ? normalizeGuid(item.SeriesId) : null,
      seasonNumber: typeof item.ParentIndexNumber === 'number' ? item.ParentIndexNumber : null,
    }));
  }

  /**
   * Per this file's header comment: NOT `isPlayed=true`, NOT `Series` — one
   * call per user over `Movie,Episode`, filtered client-side to
   * `PlayCount > 0`, matching `sqliteSource.ts`'s predicate exactly so both
   * implementations answer the same question the same way.
   */
  async listPlayedUserData(): Promise<Map<string, JellyfinUserPlayback[]>> {
    const usersRes = await this.client.request<RestUser[]>('/Users');

    const byItem = new Map<string, JellyfinUserPlayback[]>();
    for (const user of usersRes) {
      const jellyfinUserId = normalizeGuid(user.Id);
      const res = await this.client.request<RestItemsResponse>('/Items', {
        query: { userId: user.Id, recursive: true, includeItemTypes: 'Movie,Episode' },
      });
      for (const item of res.Items) {
        const playCount = item.UserData?.PlayCount ?? 0;
        if (playCount <= 0) continue;
        const itemId = normalizeGuid(item.Id);
        const entry: JellyfinUserPlayback = {
          jellyfinUserId,
          playCount,
          lastPlayedAt: parseRestTimestamp(item.UserData?.LastPlayedDate),
          played: item.UserData?.Played ?? false,
          positionTicks: item.UserData?.PlaybackPositionTicks ?? 0,
        };
        const existing = byItem.get(itemId);
        if (existing) existing.push(entry);
        else byItem.set(itemId, [entry]);
      }
    }
    return byItem;
  }
}

/** Builds the REST source against `JELLYFIN_URL` (`src/lib/config.ts`), authenticated with `JELLYFIN_API_KEY` via the verified-live `X-Emby-Token` header, reusing the shared `UpstreamClient` (`../http/client.ts`) — same timeout/retry policy as every other upstream in this app. */
export function createRestJellyfinPlaybackSource(baseUrl: string, apiKey: string, timeoutMs: number, retries: number): RestJellyfinPlaybackSource {
  const client = new UpstreamClient({
    name: 'jellyfin',
    baseUrl,
    auth: apiKeyAuth(AUTH_HEADER, apiKey),
    timeoutMs,
    retries,
  });
  return new RestJellyfinPlaybackSource(client);
}
