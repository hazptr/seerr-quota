import { describe, expect, it } from 'vitest';
import { noAuth, UpstreamClient, UpstreamError } from '@/lib/http/client';
import { SeerrNativeQuotaReader } from '@/lib/quota/seerrNativeQuota';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function readerWithFetch(fetchImpl: typeof fetch): SeerrNativeQuotaReader {
  return new SeerrNativeQuotaReader(
    new UpstreamClient({ name: 'seerr', baseUrl: 'http://seerr.local', auth: noAuth(), timeoutMs: 5000, retries: 0, fetchImpl }),
  );
}

describe('FR-POL-10 — structurally no write method exists on SeerrNativeQuotaReader', () => {
  it('every prototype method is a read (starts with get/list), never a write verb', () => {
    const methodNames = Object.getOwnPropertyNames(SeerrNativeQuotaReader.prototype).filter((name) => name !== 'constructor');

    // Sanity: this must actually find the real methods, not silently pass on an empty list.
    expect(methodNames.length).toBeGreaterThan(0);

    const writeVerbPattern = /^(set|update|write|post|put|patch|delete|create|remove|save)/i;
    for (const name of methodNames) {
      expect(name).toMatch(/^(get|list)/);
      expect(name).not.toMatch(writeVerbPattern);
    }
  });

  it('the class itself has no static write-verb-named factory beyond createSeerrNativeQuotaReader (a constructor helper, not a Seerr write)', async () => {
    const mod = await import('@/lib/quota/seerrNativeQuota');
    const exportedNames = Object.keys(mod);
    const writeVerbPattern = /^(set|update|write|post|put|patch|delete)/i;
    for (const name of exportedNames) {
      expect(name).not.toMatch(writeVerbPattern);
    }
  });
});

describe('SeerrNativeQuotaReader.getQuotaSettings — GET /api/v1/user/{id}', () => {
  it('parses movieQuotaLimit/Days, tvQuotaLimit/Days from a realistic user object', async () => {
    const reader = readerWithFetch(async (input) => {
      expect(String(input)).toBe('http://seerr.local/api/v1/user/8');
      return jsonResponse(200, {
        id: 8,
        email: 'frank@example.com',
        username: null,
        displayName: 'frank',
        jellyfinUsername: 'frank',
        jellyfinUserId: '7bbb0000000000000000000000000000',
        plexUsername: null,
        plexId: null,
        permissions: 67109024,
        movieQuotaLimit: 5,
        movieQuotaDays: 7,
        tvQuotaLimit: 10,
        tvQuotaDays: 14,
        userType: 3,
        avatar: 'https://example/avatar.png',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        requestCount: 25,
      });
    });

    const result = await reader.getQuotaSettings(8);
    expect(result).toEqual({ seerrUserId: 8, movieQuotaLimit: 5, movieQuotaDays: 7, tvQuotaLimit: 10, tvQuotaDays: 14 });
  });

  it('null quota fields (no limit configured) pass through as null, never coerced to 0', async () => {
    const reader = readerWithFetch(async () =>
      jsonResponse(200, { id: 8, email: null, movieQuotaLimit: null, movieQuotaDays: null, tvQuotaLimit: null, tvQuotaDays: null }),
    );
    const result = await reader.getQuotaSettings(8);
    expect(result.movieQuotaLimit).toBeNull();
    expect(result.tvQuotaLimit).toBeNull();
  });

  it('throws UpstreamError on a non-object response', async () => {
    const reader = readerWithFetch(async () => jsonResponse(200, null));
    await expect(reader.getQuotaSettings(8)).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe('SeerrNativeQuotaReader.getQuotaUsage — GET /api/v1/user/{id}/quota', () => {
  it('parses the exact shape Seerr’s quota endpoint returns', async () => {
    const reader = readerWithFetch(async (input) => {
      expect(String(input)).toBe('http://seerr.local/api/v1/user/8/quota');
      return jsonResponse(200, {
        movie: { days: 7, limit: 5, used: 0, remaining: 5, restricted: false },
        tv: { days: 14, limit: 10, used: 4, remaining: 6, restricted: false },
      });
    });

    const result = await reader.getQuotaUsage(8);
    expect(result).toEqual({
      movie: { days: 7, limit: 5, used: 0, remaining: 5, restricted: false },
      tv: { days: 14, limit: 10, used: 4, remaining: 6, restricted: false },
    });
  });

  it('throws UpstreamError when the movie/tv window is missing a required numeric field', async () => {
    const reader = readerWithFetch(async () => jsonResponse(200, { movie: { days: 7, limit: 5 }, tv: { days: 14, limit: 10, used: 4, remaining: 6 } }));
    await expect(reader.getQuotaUsage(8)).rejects.toBeInstanceOf(UpstreamError);
  });
});
