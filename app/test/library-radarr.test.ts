import { describe, expect, it } from 'vitest';
import { UpstreamClient, UpstreamError, noAuth } from '@/lib/http/client';
import { RadarrClient } from '@/lib/library/radarr';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function clientWithFetch(fetchImpl: typeof fetch): RadarrClient {
  return new RadarrClient(
    new UpstreamClient({ name: 'radarr', baseUrl: 'http://radarr.local', auth: noAuth(), timeoutMs: 5000, retries: 0, fetchImpl }),
  );
}

/** A trimmed, realistic fixture shaped exactly like a real GET /api/v3/movie
 * response (extra fields Radarr sends but
 * this app never reads stripped out — see src/lib/library/radarr.ts header). */
const SAMPLE_MOVIE_WITH_FILE = {
  id: 5,
  tmdbId: 900001,
  title: 'Example Movie A',
  year: 2023,
  hasFile: true,
  sizeOnDisk: 15589124313,
  added: '2026-01-01T00:00:00Z',
  path: '/data/media/movies/Example Movie A (2023)',
  // ...Radarr also sends images, ratings, movieFile, collection, keywords, etc. — deliberately omitted here.
};

const SAMPLE_MOVIE_WITHOUT_FILE = {
  id: 51,
  tmdbId: 900002,
  title: 'Example Movie B',
  year: 2026,
  hasFile: false,
  sizeOnDisk: 0,
  added: '2026-01-15T00:00:00Z',
  path: '/data/media/anime-movies/Example Movie B (2026)',
};

describe('RadarrClient.listMovies', () => {
  it('parses a realistic movie array, picking out only the fields this app needs', async () => {
    const client = clientWithFetch((async () => jsonResponse(200, [SAMPLE_MOVIE_WITH_FILE])) as unknown as typeof fetch);
    const movies = await client.listMovies();
    expect(movies).toEqual([
      {
        id: 5,
        tmdbId: 900001,
        title: 'Example Movie A',
        year: 2023,
        hasFile: true,
        sizeOnDisk: 15589124313,
        added: '2026-01-01T00:00:00Z',
        path: '/data/media/movies/Example Movie A (2023)',
      },
    ]);
  });

  it('a movie with hasFile:false carries sizeOnDisk 0 (FR-ACCT-1: pending contributes zero bytes) — not rejected or dropped', async () => {
    const client = clientWithFetch(
      (async () => jsonResponse(200, [SAMPLE_MOVIE_WITH_FILE, SAMPLE_MOVIE_WITHOUT_FILE])) as unknown as typeof fetch,
    );
    const movies = await client.listMovies();
    expect(movies).toHaveLength(2);
    const pending = movies.find((m) => m.id === 51)!;
    expect(pending.hasFile).toBe(false);
    expect(pending.sizeOnDisk).toBe(0);
  });

  it('tolerates extra fields Radarr sends that this app does not model', async () => {
    const client = clientWithFetch(
      (async () =>
        jsonResponse(200, [
          { ...SAMPLE_MOVIE_WITH_FILE, images: [{ coverType: 'poster' }], ratings: { imdb: { value: 8.5 } }, movieFile: { id: 1 } },
        ])) as unknown as typeof fetch,
    );
    await expect(client.listMovies()).resolves.toHaveLength(1);
  });

  it('a missing `added` date is carried through as null, not thrown on', async () => {
    const client = clientWithFetch(
      (async () => jsonResponse(200, [{ ...SAMPLE_MOVIE_WITH_FILE, added: undefined }])) as unknown as typeof fetch,
    );
    const [movie] = await client.listMovies();
    expect(movie.added).toBeNull();
  });

  it('rejects a non-array response as invalid_response', async () => {
    const client = clientWithFetch((async () => jsonResponse(200, { not: 'an array' })) as unknown as typeof fetch);
    const err = await client.listMovies().catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).code).toBe('invalid_response');
  });

  it('rejects a movie row missing a required field (tmdbId) as invalid_response', async () => {
    const withoutTmdbId: Record<string, unknown> = { ...SAMPLE_MOVIE_WITH_FILE };
    delete withoutTmdbId.tmdbId;
    const client = clientWithFetch((async () => jsonResponse(200, [withoutTmdbId])) as unknown as typeof fetch);
    const err = await client.listMovies().catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).code).toBe('invalid_response');
  });
});
