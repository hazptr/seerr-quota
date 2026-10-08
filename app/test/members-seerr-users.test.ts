import { describe, expect, it } from 'vitest';
import { UpstreamClient, UpstreamError, noAuth } from '@/lib/http/client';
import { SeerrUsersClient } from '@/lib/members/seerrUsers';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function clientWithFetch(fetchImpl: typeof fetch): SeerrUsersClient {
  return new SeerrUsersClient(
    new UpstreamClient({ name: 'seerr', baseUrl: 'http://seerr.local', auth: noAuth(), timeoutMs: 5000, retries: 0, fetchImpl }),
  );
}

/** Trimmed but realistic — shaped like a real GET /api/v1/user response. */
function realUserRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 8,
    email: 'frank@example.com',
    username: null,
    displayName: 'frank',
    jellyfinUsername: 'frank',
    jellyfinUserId: '7bbb0000000000000000000000000000',
    plexUsername: null,
    plexId: null,
    permissions: 67109024,
    movieQuotaLimit: null,
    movieQuotaDays: null,
    tvQuotaLimit: null,
    tvQuotaDays: null,
    userType: 3,
    avatar: 'https://example.com/avatar.png',
    avatarETag: null,
    avatarVersion: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    requestCount: 25,
    recoveryLinkExpirationDate: null,
    warnings: [],
    ...overrides,
  };
}

describe('SeerrUsersClient.listAllUsers', () => {
  it('parses a realistic user row, tolerating fields this app does not model (a realistic GET /api/v1/user response shape)', async () => {
    const client = clientWithFetch(
      (async () => jsonResponse(200, { pageInfo: { pages: 1, pageSize: 100, results: 1, page: 1 }, results: [realUserRow()] })) as unknown as typeof fetch,
    );
    const users = await client.listAllUsers();
    expect(users).toEqual([
      { id: 8, email: 'frank@example.com', username: null, displayName: 'frank', jellyfinUsername: 'frank', jellyfinUserId: '7bbb0000000000000000000000000000' },
    ]);
  });

  it('a local-admin-shaped account with jellyfinUsername null still parses (akadmin-like)', async () => {
    const row = realUserRow({ id: 9, jellyfinUsername: null, jellyfinUserId: null, username: 'akadmin', displayName: 'akadmin' });
    const client = clientWithFetch(
      (async () => jsonResponse(200, { pageInfo: { pages: 1, pageSize: 100, results: 1, page: 1 }, results: [row] })) as unknown as typeof fetch,
    );
    const users = await client.listAllUsers();
    expect(users[0]).toEqual({ id: 9, email: 'frank@example.com', username: 'akadmin', displayName: 'akadmin', jellyfinUsername: null, jellyfinUserId: null });
  });

  it('pages through skip= until pageInfo.results is covered, concatenating every page', async () => {
    const allRows = Array.from({ length: 5 }, (_v, i) => realUserRow({ id: i + 1 }));
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      const u = new URL(url);
      const skip = Number(u.searchParams.get('skip'));
      const take = Number(u.searchParams.get('take'));
      const page = allRows.slice(skip, skip + take);
      return jsonResponse(200, { pageInfo: { pages: Math.ceil(5 / take), pageSize: take, results: 5, page: skip / take + 1 }, results: page });
    }) as unknown as typeof fetch;
    const client = new SeerrUsersClient(
      new UpstreamClient({ name: 'seerr', baseUrl: 'http://seerr.local', auth: noAuth(), timeoutMs: 5000, retries: 0, fetchImpl }),
    );
    const users = await client.listAllUsers(2);
    expect(users.map((u) => u.id)).toEqual([1, 2, 3, 4, 5]);
    expect(calls).toHaveLength(3);
  });

  it('rejects a response missing pageInfo/results as invalid_response', async () => {
    const client = clientWithFetch((async () => jsonResponse(200, { oops: true })) as unknown as typeof fetch);
    const err = await client.listAllUsers().catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).code).toBe('invalid_response');
  });

  it('rejects a result row missing a numeric id as invalid_response', async () => {
    const client = clientWithFetch(
      (async () => jsonResponse(200, { pageInfo: { pages: 1, results: 1 }, results: [{ email: 'x@x.com' }] })) as unknown as typeof fetch,
    );
    const err = await client.listAllUsers().catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).code).toBe('invalid_response');
  });

  // --- Security review (PR #17), item 5: fail-safe, never fail-silent on a partial list ---

  it('throws invalid_response rather than returning a SHORT list when the first (and only) page under-reports pageInfo.results', async () => {
    // Server claims 5 total, but the single page returned has only 2 rows and
    // signals "no more" by returning an empty results[] would be the normal
    // end; here it just stops mid-count with a non-empty-but-short page and
    // pageInfo.results that doesn't match — a misbehaving/inconsistent upstream.
    const client = clientWithFetch(
      (async () => jsonResponse(200, { pageInfo: { pages: 1, results: 5 }, results: [realUserRow({ id: 1 }), realUserRow({ id: 2 })] })) as unknown as typeof fetch,
    );
    const err = await client.listAllUsers(2).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).code).toBe('invalid_response');
  });

  it('throws invalid_response when MAX_PAGES is exhausted without ever reaching pageInfo.results (a looping/pathological upstream)', async () => {
    // Every page returns exactly 1 row and claims results: 999999999 — the
    // loop would paginate forever without this safety cap.
    const fetchImpl = (async () => jsonResponse(200, { pageInfo: { pages: 999999999, results: 999999999 }, results: [realUserRow({ id: 1 })] })) as unknown as typeof fetch;
    const client = new SeerrUsersClient(
      new UpstreamClient({ name: 'seerr', baseUrl: 'http://seerr.local', auth: noAuth(), timeoutMs: 5000, retries: 0, fetchImpl }),
    );
    const err = await client.listAllUsers(1).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).code).toBe('invalid_response');
    expect((err as UpstreamError).message).toContain('MAX_PAGES');
  });

  it('an empty roster (zero Seerr users at all) is accepted — pageInfo.results: 0 with an empty results[] is a complete, consistent response', async () => {
    const client = clientWithFetch(
      (async () => jsonResponse(200, { pageInfo: { pages: 1, results: 0 }, results: [] })) as unknown as typeof fetch,
    );
    const users = await client.listAllUsers();
    expect(users).toEqual([]);
  });
});
