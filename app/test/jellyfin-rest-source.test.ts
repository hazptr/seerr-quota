import { describe, expect, it } from 'vitest';
import { noAuth, UpstreamClient } from '@/lib/http/client';
import { RestJellyfinPlaybackSource, parseRestTimestamp } from '@/lib/jellyfin/restSource';
import { normalizeGuid } from '@/lib/jellyfin/sqliteSource';

/**
 * `RestJellyfinPlaybackSource` unit tests, against a HAND-BUILT fake `fetch`
 * — never a live service. The response shapes below are trimmed to exactly
 * the fields `restSource.ts` reads, but every field NAME and the overall
 * envelope (`{Items, TotalRecordCount}`, `ProviderIds` as a nested object,
 * `UserData` per item) matches what Jellyfin's REST API actually returns
 * (see `restSource.ts`'s header comment) — not invented or guessed from
 * documentation.
 */

const MOVIE_ID = '00000000000000000000000000000a01';
const MOVIE_NO_PROVIDER_ID = 'cccccccccccccccccccccccccccccccc';
const SERIES_ID = '00000000000000000000000000000a02';
const EPISODE_ID = '00000000000000000000000000000a03';
const ORPHAN_EPISODE_ID = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const USER_A_ID = '00000000000000000000000000000a04';
const USER_B_ID = '00000000000000000000000000000a05';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/**
 * Routes a fake `fetch` by matching on the request URL's path + query
 * params — `RestJellyfinPlaybackSource` issues several structurally
 * different `/Items` calls (movies, series, episodes, per-user), so a
 * single queued-response list (as `deletion-arr-actions.test.ts` uses for
 * its single-call clients) isn't expressive enough here.
 */
function routedFetch(routes: Array<{ match: (url: URL) => boolean; respond: () => unknown }>): { fetchImpl: typeof fetch; calls: URL[] } {
  const calls: URL[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url);
    const route = routes.find((r) => r.match(url));
    if (!route) throw new Error(`test bug: no route matched ${url.toString()}`);
    return jsonResponse(route.respond());
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function includeItemTypesIs(url: URL, value: string): boolean {
  return url.pathname === '/Items' && url.searchParams.get('includeItemTypes') === value && !url.searchParams.has('userId');
}

const MOVIES_RESPONSE = {
  TotalRecordCount: 2,
  Items: [
    { Id: MOVIE_ID, Type: 'Movie', ProviderIds: { Tmdb: '900001', Tvdb: '900101', Imdb: 'tt0000001' } },
    { Id: MOVIE_NO_PROVIDER_ID, Type: 'Movie', ProviderIds: {} },
  ],
};

const SERIES_RESPONSE = {
  TotalRecordCount: 1,
  Items: [{ Id: SERIES_ID, Type: 'Series', ProviderIds: { Imdb: 'tt0000002', Tmdb: '900002', Tvdb: '900102' } }],
};

const SEASONLESS_EPISODE_ID = 'ffffffffffffffffffffffffffffffff';

const EPISODES_RESPONSE = {
  TotalRecordCount: 3,
  Items: [
    { Id: EPISODE_ID, Type: 'Episode', SeriesId: SERIES_ID, ParentIndexNumber: 1 },
    { Id: ORPHAN_EPISODE_ID, Type: 'Episode', SeriesId: null, ParentIndexNumber: 1 },
    // P4-1 Wave 2: a special/unassigned episode with no ParentIndexNumber at
    // all — must come back seasonNumber: null, never throw or default to 0.
    { Id: SEASONLESS_EPISODE_ID, Type: 'Episode', SeriesId: SERIES_ID },
  ],
};

const USERS_RESPONSE = [
  { Id: USER_A_ID, Name: 'frank' },
  { Id: USER_B_ID, Name: 'admin' },
];

function buildSource(fetchImpl: typeof fetch): RestJellyfinPlaybackSource {
  const client = new UpstreamClient({ name: 'jellyfin', baseUrl: 'http://jellyfin.local', auth: noAuth(), timeoutMs: 5000, retries: 2, fetchImpl });
  return new RestJellyfinPlaybackSource(client);
}

describe('parseRestTimestamp', () => {
  it('parses REST\'s native ISO-8601 (7-digit sub-second precision) to unix seconds', () => {
    const seconds = parseRestTimestamp('2026-01-01T00:00:00.0000000Z');
    expect(seconds).toBe(Math.floor(Date.parse('2026-01-01T00:00:00.000Z') / 1000));
  });

  it('returns null for null/undefined input rather than throwing', () => {
    expect(parseRestTimestamp(null)).toBeNull();
    expect(parseRestTimestamp(undefined)).toBeNull();
  });

  it('does NOT reuse sqliteSource.ts\'s space-separated parser logic — a bare ISO string must not double up the trailing Z', () => {
    // Regression guard for the exact bug this file's header comment warns
    // about: `raw.replace(' ', 'T') + 'Z'` on an already-ISO string with no
    // space produces "...ZZ", which Date.parse rejects as NaN.
    expect(parseRestTimestamp('2026-01-01T00:00:00.159848Z')).not.toBeNull();
  });
});

describe('RestJellyfinPlaybackSource.listMovies', () => {
  it('resolves the Tmdb provider id from the nested ProviderIds object and normalises the item id', async () => {
    const { fetchImpl } = routedFetch([{ match: (url) => includeItemTypesIs(url, 'Movie'), respond: () => MOVIES_RESPONSE }]);
    const source = buildSource(fetchImpl);

    const movies = await source.listMovies();
    expect(movies).toContainEqual({ itemId: normalizeGuid(MOVIE_ID), tmdbId: 900001 });
  });

  it('a movie with no Tmdb provider id comes back with tmdbId: null (never dropped, never a fake 0)', async () => {
    const { fetchImpl } = routedFetch([{ match: (url) => includeItemTypesIs(url, 'Movie'), respond: () => MOVIES_RESPONSE }]);
    const source = buildSource(fetchImpl);

    const movies = await source.listMovies();
    expect(movies).toContainEqual({ itemId: normalizeGuid(MOVIE_NO_PROVIDER_ID), tmdbId: null });
  });

  it('requests fields=ProviderIds and includeItemTypes=Movie, recursive, with NO userId', async () => {
    const { fetchImpl, calls } = routedFetch([{ match: (url) => includeItemTypesIs(url, 'Movie'), respond: () => MOVIES_RESPONSE }]);
    await buildSource(fetchImpl).listMovies();
    expect(calls).toHaveLength(1);
    expect(calls[0].searchParams.get('fields')).toBe('ProviderIds');
    expect(calls[0].searchParams.get('recursive')).toBe('true');
    expect(calls[0].searchParams.has('userId')).toBe(false);
  });
});

describe('RestJellyfinPlaybackSource.listSeries', () => {
  it('resolves the Tvdb provider id specifically, ignoring other provider ids on the same item', async () => {
    const { fetchImpl } = routedFetch([{ match: (url) => includeItemTypesIs(url, 'Series'), respond: () => SERIES_RESPONSE }]);
    const series = await buildSource(fetchImpl).listSeries();
    expect(series).toEqual([{ itemId: normalizeGuid(SERIES_ID), tvdbId: 900102 }]);
  });
});

describe('RestJellyfinPlaybackSource.listEpisodes', () => {
  it('returns every episode with its normalised parent series id, in ONE call (no per-series fan-out)', async () => {
    const { fetchImpl, calls } = routedFetch([{ match: (url) => includeItemTypesIs(url, 'Episode'), respond: () => EPISODES_RESPONSE }]);
    const episodes = await buildSource(fetchImpl).listEpisodes();
    expect(calls).toHaveLength(1);
    expect(episodes).toContainEqual({ itemId: normalizeGuid(EPISODE_ID), seriesId: normalizeGuid(SERIES_ID), seasonNumber: 1 });
  });

  it('an orphaned episode (SeriesId null) comes back with seriesId: null rather than being dropped', async () => {
    const { fetchImpl } = routedFetch([{ match: (url) => includeItemTypesIs(url, 'Episode'), respond: () => EPISODES_RESPONSE }]);
    const episodes = await buildSource(fetchImpl).listEpisodes();
    expect(episodes).toContainEqual({ itemId: normalizeGuid(ORPHAN_EPISODE_ID), seriesId: null, seasonNumber: 1 });
  });

  it('P4-1 Wave 2: parses ParentIndexNumber into seasonNumber, present by default with NO fields= parameter added to the request', async () => {
    const { fetchImpl, calls } = routedFetch([{ match: (url) => includeItemTypesIs(url, 'Episode'), respond: () => EPISODES_RESPONSE }]);
    await buildSource(fetchImpl).listEpisodes();
    expect(calls).toHaveLength(1);
    expect(calls[0].searchParams.has('fields')).toBe(false);
  });

  it('an episode with no ParentIndexNumber at all comes back with seasonNumber: null rather than throwing or defaulting to 0', async () => {
    const { fetchImpl } = routedFetch([{ match: (url) => includeItemTypesIs(url, 'Episode'), respond: () => EPISODES_RESPONSE }]);
    const episodes = await buildSource(fetchImpl).listEpisodes();
    expect(episodes).toContainEqual({ itemId: normalizeGuid(SEASONLESS_EPISODE_ID), seriesId: normalizeGuid(SERIES_ID), seasonNumber: null });
  });
});

describe('RestJellyfinPlaybackSource.listPlayedUserData — NOT isPlayed=true, NOT Series (see restSource.ts header comment)', () => {
  it('one call per user over Movie,Episode; filters client-side to PlayCount > 0', async () => {
    const routes = [
      { match: (url: URL) => url.pathname === '/Users', respond: () => USERS_RESPONSE },
      {
        match: (url: URL) => url.pathname === '/Items' && url.searchParams.get('userId') === USER_A_ID,
        respond: () => ({
          TotalRecordCount: 2,
          Items: [
            { Id: MOVIE_ID, Type: 'Movie', UserData: { PlayCount: 3, Played: true, PlaybackPositionTicks: 0, LastPlayedDate: '2026-01-01T00:00:00.0000000Z' } },
            { Id: 'unplayedmovie', Type: 'Movie', UserData: { PlayCount: 0, Played: false, PlaybackPositionTicks: 0, LastPlayedDate: null } },
          ],
        }),
      },
      {
        match: (url: URL) => url.pathname === '/Items' && url.searchParams.get('userId') === USER_B_ID,
        respond: () => ({ TotalRecordCount: 0, Items: [] }),
      },
    ];
    const { fetchImpl, calls } = routedFetch(routes);
    const played = await buildSource(fetchImpl).listPlayedUserData();

    // Exactly 3 calls: /Users + one /Items per user.
    expect(calls.filter((u) => u.pathname === '/Items')).toHaveLength(2);

    const moviePlays = played.get(normalizeGuid(MOVIE_ID));
    expect(moviePlays).toEqual([
      {
        jellyfinUserId: normalizeGuid(USER_A_ID),
        playCount: 3,
        played: true,
        positionTicks: 0,
        lastPlayedAt: Math.floor(Date.parse('2026-01-01T00:00:00.000Z') / 1000),
      },
    ]);
    // The zero-PlayCount movie must not surface at all.
    expect(played.has(normalizeGuid('unplayedmovie'))).toBe(false);
  });

  it('captures an UNFINISHED item (PlayCount > 0, Played: false, a real resume position) — the exact case isPlayed=true would silently drop (FR-DEL-4 in_progress)', async () => {
    const routes = [
      { match: (url: URL) => url.pathname === '/Users', respond: () => [{ Id: USER_A_ID, Name: 'frank' }] },
      {
        match: (url: URL) => url.pathname === '/Items' && url.searchParams.get('userId') === USER_A_ID,
        respond: () => ({
          TotalRecordCount: 1,
          Items: [{ Id: EPISODE_ID, Type: 'Episode', UserData: { PlayCount: 1, Played: false, PlaybackPositionTicks: 2_670_510_000, LastPlayedDate: '2026-01-01T00:00:00.0000000Z' } }],
        }),
      },
    ];
    const { fetchImpl } = routedFetch(routes);
    const played = await buildSource(fetchImpl).listPlayedUserData();

    const episodePlays = played.get(normalizeGuid(EPISODE_ID));
    expect(episodePlays).toEqual([
      {
        jellyfinUserId: normalizeGuid(USER_A_ID),
        playCount: 1,
        played: false,
        positionTicks: 2_670_510_000,
        lastPlayedAt: Math.floor(Date.parse('2026-01-01T00:00:00.000Z') / 1000),
      },
    ]);
  });

  it('requests includeItemTypes=Movie,Episode per user — never Series (whose own UserData.PlayCount is always 0, see restSource.ts header comment)', async () => {
    const routes = [
      { match: (url: URL) => url.pathname === '/Users', respond: () => [{ Id: USER_A_ID, Name: 'frank' }] },
      { match: (url: URL) => url.pathname === '/Items' && url.searchParams.get('userId') === USER_A_ID, respond: () => ({ TotalRecordCount: 0, Items: [] }) },
    ];
    const { fetchImpl, calls } = routedFetch(routes);
    await buildSource(fetchImpl).listPlayedUserData();

    const itemsCall = calls.find((u) => u.pathname === '/Items');
    expect(itemsCall?.searchParams.get('includeItemTypes')).toBe('Movie,Episode');
    expect(itemsCall?.searchParams.get('isPlayed')).toBeNull(); // deliberately NOT set — see header comment
  });

  it('a PlayCount of 0 with no UserData at all does not throw', async () => {
    const routes = [
      { match: (url: URL) => url.pathname === '/Users', respond: () => [{ Id: USER_A_ID, Name: 'frank' }] },
      {
        match: (url: URL) => url.pathname === '/Items' && url.searchParams.get('userId') === USER_A_ID,
        respond: () => ({ TotalRecordCount: 1, Items: [{ Id: 'no-userdata-item', Type: 'Movie' }] }),
      },
    ];
    const { fetchImpl } = routedFetch(routes);
    await expect(buildSource(fetchImpl).listPlayedUserData()).resolves.toBeInstanceOf(Map);
  });
});
