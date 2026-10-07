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
});
