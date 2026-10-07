import { describe, expect, it } from 'vitest';
import { UpstreamClient, UpstreamError, noAuth } from '@/lib/http/client';
import { SonarrClient } from '@/lib/library/sonarr';
import { aggregateBytesBySeason, SonarrEpisodeFileClient, type SonarrEpisodeFile } from '@/lib/library/sonarrEpisodeFiles';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function clientWithFetch(fetchImpl: typeof fetch): SonarrClient {
  return new SonarrClient(
    new UpstreamClient({ name: 'sonarr', baseUrl: 'http://sonarr.local', auth: noAuth(), timeoutMs: 5000, retries: 0, fetchImpl }),
  );
}

/** Trimmed, realistic fixture shaped like a real GET /api/v3/series response. */
const SAMPLE_SERIES_WITH_FILES = {
  id: 3,
  tvdbId: 900001,
  title: 'Example Series A',
  year: 2006,
  path: '/data/media/tv/Example Series A',
  added: '2026-01-01T00:00:00Z',
  statistics: {
    seasonCount: 8,
    episodeFileCount: 124,
    episodeCount: 124,
    totalEpisodeCount: 129,
    sizeOnDisk: 176321392504,
  },
};

const SAMPLE_SERIES_NO_FILES = {
  id: 110,
  tvdbId: 900002,
  title: 'Example Series B',
  year: 2026,
  path: '/data/media/tv/Example Series B (2026) [tvdbid-900002]',
  added: '2026-01-15T00:00:00Z',
  statistics: { seasonCount: 2, episodeFileCount: 0, episodeCount: 0, totalEpisodeCount: 26, sizeOnDisk: 0 },
};

describe('SonarrClient.listSeries', () => {
  it('parses a realistic series array, reading statistics.sizeOnDisk (not a top-level field)', async () => {
    const client = clientWithFetch((async () => jsonResponse(200, [SAMPLE_SERIES_WITH_FILES])) as unknown as typeof fetch);
    const series = await client.listSeries();
    expect(series).toEqual([
      {
        id: 3,
        tvdbId: 900001,
        title: 'Example Series A',
        year: 2006,
        path: '/data/media/tv/Example Series A',
        added: '2026-01-01T00:00:00Z',
        sizeOnDisk: 176321392504,
        episodeFileCount: 124,
      },
    ]);
  });

  it('a series with nothing downloaded yet carries sizeOnDisk 0, not dropped', async () => {
    const client = clientWithFetch((async () => jsonResponse(200, [SAMPLE_SERIES_NO_FILES])) as unknown as typeof fetch);
    const [series] = await client.listSeries();
    expect(series.sizeOnDisk).toBe(0);
    expect(series.episodeFileCount).toBe(0);
  });

  it('a series missing `statistics` entirely defaults sizeOnDisk/episodeFileCount to 0 rather than throwing', async () => {
    const withoutStatistics: Record<string, unknown> = { ...SAMPLE_SERIES_WITH_FILES };
    delete withoutStatistics.statistics;
    const client = clientWithFetch((async () => jsonResponse(200, [withoutStatistics])) as unknown as typeof fetch);
    const [series] = await client.listSeries();
    expect(series.sizeOnDisk).toBe(0);
    expect(series.episodeFileCount).toBe(0);
  });

  it('rejects a non-array response as invalid_response', async () => {
    const client = clientWithFetch((async () => jsonResponse(200, { not: 'an array' })) as unknown as typeof fetch);
    const err = await client.listSeries().catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).code).toBe('invalid_response');
  });

  it('rejects a series row missing a required field (tvdbId) as invalid_response', async () => {
    const withoutTvdbId: Record<string, unknown> = { ...SAMPLE_SERIES_WITH_FILES };
    delete withoutTvdbId.tvdbId;
    const client = clientWithFetch((async () => jsonResponse(200, [withoutTvdbId])) as unknown as typeof fetch);
    const err = await client.listSeries().catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).code).toBe('invalid_response');
  });
});

// ---------------------------------------------------------------------------
// SonarrEpisodeFileClient + the pure per-season aggregation.
// Fixture shape matches Sonarr's real API response:
// `GET /api/v3/episodefile?seriesId={id}` returns one object per file,
// `{ seriesId, seasonNumber, relativePath, path, size, id, quality, ... }`.
// ---------------------------------------------------------------------------

/** Trimmed, realistic per-file fixture (extra fields Sonarr sends but this client doesn't read are included to prove they're tolerated). */
const SAMPLE_EPISODE_FILE = {
  id: 4821,
  seriesId: 3,
  seasonNumber: 1,
  relativePath: 'Season 01/Example Series A - S01E01 - Pilot.mkv',
  path: '/data/media/tv/Example Series A/Season 01/Example Series A - S01E01 - Pilot.mkv',
  size: 1_483_291_002,
  quality: { quality: { name: 'WEBDL-1080p' } },
};

function episodeFileClientWithFetch(fetchImpl: typeof fetch): SonarrEpisodeFileClient {
  return new SonarrEpisodeFileClient(
    new UpstreamClient({ name: 'sonarr', baseUrl: 'http://sonarr.local', auth: noAuth(), timeoutMs: 5000, retries: 0, fetchImpl }),
  );
}

describe('SonarrEpisodeFileClient.listEpisodeFiles', () => {
  it('parses a realistic episode-file array, reading seasonNumber and size (bytes), tolerating extra fields', async () => {
    const client = episodeFileClientWithFetch((async () => jsonResponse(200, [SAMPLE_EPISODE_FILE])) as unknown as typeof fetch);
    const files = await client.listEpisodeFiles(3);
    expect(files).toEqual([{ id: 4821, seriesId: 3, seasonNumber: 1, size: 1_483_291_002, dateAdded: null }]);
  });

  it('rejects a non-array response as invalid_response', async () => {
    const client = episodeFileClientWithFetch((async () => jsonResponse(200, { not: 'an array' })) as unknown as typeof fetch);
    const err = await client.listEpisodeFiles(3).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).code).toBe('invalid_response');
  });

  it('rejects a row missing a required field (seasonNumber) as invalid_response', async () => {
    const withoutSeasonNumber: Record<string, unknown> = { ...SAMPLE_EPISODE_FILE };
    delete withoutSeasonNumber.seasonNumber;
    const client = episodeFileClientWithFetch((async () => jsonResponse(200, [withoutSeasonNumber])) as unknown as typeof fetch);
    const err = await client.listEpisodeFiles(3).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).code).toBe('invalid_response');
  });
});

describe('aggregateBytesBySeason — pure, hand-calculated (AGENTS.md rule 9, no network/DB)', () => {
  it('sums size per seasonNumber across a mix of seasons', () => {
    const files: SonarrEpisodeFile[] = [
      { id: 1, seriesId: 3, seasonNumber: 1, size: 1_000, dateAdded: null },
      { id: 2, seriesId: 3, seasonNumber: 1, size: 2_500, dateAdded: null },
      { id: 3, seriesId: 3, seasonNumber: 1, size: 500, dateAdded: null },
      { id: 4, seriesId: 3, seasonNumber: 2, size: 4_000, dateAdded: null },
      { id: 5, seriesId: 3, seasonNumber: 2, size: 6_000, dateAdded: null },
    ];
    const totals = aggregateBytesBySeason(files);
    // Hand-calculated: season 1 = 1000+2500+500 = 4000; season 2 = 4000+6000 = 10000.
    expect(totals).toEqual(
      new Map([
        [1, 4_000],
        [2, 10_000],
      ]),
    );
  });

  it('an empty file list produces an empty map', () => {
    expect(aggregateBytesBySeason([])).toEqual(new Map());
  });

  it('a single file gives that season a total equal to its own size', () => {
    const totals = aggregateBytesBySeason([{ id: 1, seriesId: 3, seasonNumber: 4, size: 999, dateAdded: null }]);
    expect(totals).toEqual(new Map([[4, 999]]));
  });

  it('a season whose only file records are size 0 still appears, totalling 0 — never silently dropped', () => {
    const files: SonarrEpisodeFile[] = [
      { id: 1, seriesId: 92, seasonNumber: 2, size: 0, dateAdded: null },
      { id: 2, seriesId: 92, seasonNumber: 2, size: 0, dateAdded: null },
      { id: 3, seriesId: 92, seasonNumber: 1, size: 12_000, dateAdded: null },
    ];
    const totals = aggregateBytesBySeason(files);
    expect(totals.get(2)).toBe(0);
    expect(totals.has(2)).toBe(true); // present, not omitted, despite totalling zero
    expect(totals.get(1)).toBe(12_000);
  });

  it('season numbers are independent of file id/order — result is order-insensitive', () => {
    const inOrder: SonarrEpisodeFile[] = [
      { id: 1, seriesId: 3, seasonNumber: 1, size: 100, dateAdded: null },
      { id: 2, seriesId: 3, seasonNumber: 2, size: 200, dateAdded: null },
      { id: 3, seriesId: 3, seasonNumber: 1, size: 300, dateAdded: null },
    ];
    const reversed = [...inOrder].reverse();
    expect(aggregateBytesBySeason(inOrder)).toEqual(aggregateBytesBySeason(reversed));
  });
});
