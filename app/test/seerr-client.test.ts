import { describe, expect, it } from 'vitest';
import { UpstreamClient, UpstreamError, noAuth } from '@/lib/http/client';
import { SeerrClient } from '@/lib/seerr/client';
import { MediaRequestStatus, MediaStatus } from '@/lib/seerr/types';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function clientWithFetch(fetchImpl: typeof fetch): SeerrClient {
  return new SeerrClient(
    new UpstreamClient({ name: 'seerr', baseUrl: 'http://seerr.local', auth: noAuth(), timeoutMs: 5000, retries: 0, fetchImpl }),
  );
}

/**
 * Trimmed but realistic, shaped like a real GET /api/v1/request
 * response — includes the extra fields Seerr actually sends (downloadStatus,
 * serverId, ratingKey, modifiedBy, ...) that this app doesn't model, to
 * prove the parser tolerates them.
 */
function realRequestRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 97,
    status: MediaRequestStatus.APPROVED,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    type: 'tv',
    is4k: false,
    serverId: null,
    profileId: null,
    isAutoRequest: false,
    media: {
      downloadStatus: [],
      id: 195,
      mediaType: 'tv',
      tmdbId: 500001,
      tvdbId: 500002,
      imdbId: null,
      status: MediaStatus.PROCESSING,
      status4k: MediaStatus.UNKNOWN,
      ratingKey: null,
      jellyfinMediaId: null,
      jellyfinMediaId4k: null,
      serviceUrl: 'https://sonarr.example.com/series/example-series-a',
    },
    seasons: [{ id: 95, seasonNumber: 1, status: MediaRequestStatus.APPROVED, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
    requestedBy: {
      id: 8,
      email: 'frank@example.com',
      jellyfinUsername: 'frank',
      jellyfinUserId: '7bbb0000000000000000000000000000',
      movieQuotaLimit: null,
      movieQuotaDays: null,
      permissions: 67109024,
      requestCount: 25,
      displayName: 'frank',
    },
    modifiedBy: { id: 8, jellyfinUsername: 'frank' },
    ...overrides,
  };
}

describe('the verified status enums — regression guard against the stale bundled spec', () => {
  it('MediaRequestStatus matches the compiled-source values, including FAILED/COMPLETED which the bundled spec omits', () => {
    expect(MediaRequestStatus).toEqual({ PENDING: 1, APPROVED: 2, DECLINED: 3, FAILED: 4, COMPLETED: 5 });
  });

  it('MediaStatus matches the compiled-source values — 6=BLOCKLISTED, 7=DELETED (the bundled spec wrongly says 6=DELETED)', () => {
    expect(MediaStatus).toEqual({ UNKNOWN: 1, PENDING: 2, PROCESSING: 3, PARTIALLY_AVAILABLE: 4, AVAILABLE: 5, BLOCKLISTED: 6, DELETED: 7 });
  });
});

describe('SeerrClient.listRequestsPage', () => {
  it('parses a realistic request page, tolerating fields this app does not model', async () => {
    const client = clientWithFetch(
      (async () =>
        jsonResponse(200, {
          pageInfo: { pages: 1, pageSize: 100, results: 1, page: 1 },
          results: [realRequestRow()],
        })) as unknown as typeof fetch,
    );
    const page = await client.listRequestsPage({ take: 100, skip: 0, filter: 'all' });
    expect(page.pageInfo).toEqual({ pages: 1, pageSize: 100, results: 1, page: 1 });
    expect(page.results).toEqual([
      {
        id: 97,
        status: MediaRequestStatus.APPROVED,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        type: 'tv',
        is4k: false,
        isAutoRequest: false,
        media: {
          id: 195,
          mediaType: 'tv',
          tmdbId: 500001,
          tvdbId: 500002,
          status: MediaStatus.PROCESSING,
          status4k: MediaStatus.UNKNOWN,
          jellyfinMediaId: null,
        },
        seasons: [{ id: 95, seasonNumber: 1, status: MediaRequestStatus.APPROVED }],
        requestedBy: {
          id: 8,
          email: 'frank@example.com',
          jellyfinUsername: 'frank',
          jellyfinUserId: '7bbb0000000000000000000000000000',
          displayName: 'frank',
        },
      },
    ]);
  });

  it('media.jellyfinMediaId null is carried through, not rejected (null on every row checked in practice)', async () => {
    const client = clientWithFetch(
      (async () =>
        jsonResponse(200, { pageInfo: { pages: 1, pageSize: 100, results: 1, page: 1 }, results: [realRequestRow()] })) as unknown as typeof fetch,
    );
    const page = await client.listRequestsPage({ take: 100, skip: 0 });
    expect(page.results[0].media.jellyfinMediaId).toBeNull();
  });

  it('a request whose media.tmdbId/tvdbId is null is still parsed (unresolved-ness is an attribution-time concern, not a parse error, FR-ACCT-4)', async () => {
    const row = realRequestRow({ type: 'movie', media: { ...(realRequestRow().media as Record<string, unknown>), mediaType: 'movie', tmdbId: null, tvdbId: null } });
    const client = clientWithFetch(
      (async () => jsonResponse(200, { pageInfo: { pages: 1, pageSize: 100, results: 1, page: 1 }, results: [row] })) as unknown as typeof fetch,
    );
    const page = await client.listRequestsPage({ take: 100, skip: 0 });
    expect(page.results[0].media.tmdbId).toBeNull();
  });

  it('a request with status=5 (COMPLETED, the majority live case) parses correctly rather than falling through a default', async () => {
    const row = realRequestRow({ status: MediaRequestStatus.COMPLETED });
    const client = clientWithFetch(
      (async () => jsonResponse(200, { pageInfo: { pages: 1, pageSize: 100, results: 1, page: 1 }, results: [row] })) as unknown as typeof fetch,
    );
    const page = await client.listRequestsPage({ take: 100, skip: 0 });
    expect(page.results[0].status).toBe(5);
  });

  it('a genuinely-deleted media row (status=7) parses as DELETED, not BLOCKLISTED', async () => {
    const row = realRequestRow({ media: { ...(realRequestRow().media as Record<string, unknown>), status: MediaStatus.DELETED } });
    const client = clientWithFetch(
      (async () => jsonResponse(200, { pageInfo: { pages: 1, pageSize: 100, results: 1, page: 1 }, results: [row] })) as unknown as typeof fetch,
    );
    const page = await client.listRequestsPage({ take: 100, skip: 0 });
    expect(page.results[0].media.status).toBe(MediaStatus.DELETED);
    expect(page.results[0].media.status).not.toBe(6);
  });

  it('rejects a request row with an unrecognised status value as invalid_response', async () => {
    const row = realRequestRow({ status: 99 });
    const client = clientWithFetch(
      (async () => jsonResponse(200, { pageInfo: { pages: 1, pageSize: 100, results: 1, page: 1 }, results: [row] })) as unknown as typeof fetch,
    );
    const err = await client.listRequestsPage({ take: 100, skip: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).code).toBe('invalid_response');
  });
});

describe('SeerrClient.listAllRequests — pagination', () => {
  it('pages through skip= until pageInfo.results is covered, concatenating every page', async () => {
    const allRows = Array.from({ length: 5 }, (_v, i) => realRequestRow({ id: i + 1 }));
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      const u = new URL(url);
      const skip = Number(u.searchParams.get('skip'));
      const take = Number(u.searchParams.get('take'));
      const page = allRows.slice(skip, skip + take);
      return jsonResponse(200, { pageInfo: { pages: Math.ceil(5 / take), pageSize: take, results: 5, page: skip / take + 1 }, results: page });
    }) as unknown as typeof fetch;
    const client = new SeerrClient(
      new UpstreamClient({ name: 'seerr', baseUrl: 'http://seerr.local', auth: noAuth(), timeoutMs: 5000, retries: 0, fetchImpl }),
    );
    const requests = await client.listAllRequests(2); // page size 2 -> 3 pages for 5 rows
    expect(requests.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
    expect(calls).toHaveLength(3);
  });

  it('stops immediately when the first page is empty', async () => {
    const fetchImpl = (async () => jsonResponse(200, { pageInfo: { pages: 0, pageSize: 100, results: 0, page: 1 }, results: [] })) as unknown as typeof fetch;
    const client = new SeerrClient(
      new UpstreamClient({ name: 'seerr', baseUrl: 'http://seerr.local', auth: noAuth(), timeoutMs: 5000, retries: 0, fetchImpl }),
    );
    await expect(client.listAllRequests()).resolves.toEqual([]);
  });
});
