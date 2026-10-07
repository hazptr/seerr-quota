import { describe, expect, it } from 'vitest';
import type { SeerrClient } from '@/lib/seerr/client';
import { syncRequests } from '@/lib/seerr/sync';
import { MediaRequestStatus, MediaStatus, type SeerrRequest } from '@/lib/seerr/types';

function fakeRequest(id: number): SeerrRequest {
  return {
    id,
    status: MediaRequestStatus.COMPLETED,
    createdAt: '2026-08-24T12:31:17.000Z',
    updatedAt: '2026-08-24T12:31:17.000Z',
    type: 'movie',
    is4k: false,
    isAutoRequest: false,
    media: { id, mediaType: 'movie', tmdbId: 100 + id, tvdbId: null, status: MediaStatus.AVAILABLE, status4k: null, jellyfinMediaId: null },
    seasons: [],
    requestedBy: { id: 1, email: 'a@example.com', jellyfinUsername: 'frank', jellyfinUserId: 'abc', displayName: 'frank' },
  };
}

describe('syncRequests', () => {
  it('on success, returns ok:true with the correct count and the fetched requests', async () => {
    const seerr = { listAllRequests: async () => [fakeRequest(1), fakeRequest(2)] } as unknown as SeerrClient;
    const { step, requests } = await syncRequests(seerr);
    expect(step.ok).toBe(true);
    expect(step.count).toBe(2);
    expect(typeof step.ms).toBe('number');
    expect(step.error).toBeUndefined();
    expect(requests).toHaveLength(2);
  });

  it('on failure, returns ok:false with an error message and an empty request list — never throws', async () => {
    const seerr = {
      listAllRequests: async () => {
        throw new Error('seerr unreachable');
      },
    } as unknown as SeerrClient;
    const { step, requests } = await syncRequests(seerr);
    expect(step.ok).toBe(false);
    expect(step.count).toBe(0);
    expect(step.error).toBe('seerr unreachable');
    expect(requests).toEqual([]);
  });
});
