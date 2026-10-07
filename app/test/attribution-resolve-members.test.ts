import { describe, expect, it } from 'vitest';
import { resolveRequestMembers } from '@/lib/attribution/resolveMembers';
import type { SeerrRequest } from '@/lib/seerr/types';
import { MediaRequestStatus, MediaStatus } from '@/lib/seerr/types';

function fakeSeerrRequest(overrides: Partial<SeerrRequest> & { id: number; requestedById: number }): SeerrRequest {
  const { requestedById, ...rest } = overrides;
  return {
    status: MediaRequestStatus.COMPLETED,
    createdAt: '2026-08-24T12:00:00.000Z',
    updatedAt: '2026-08-24T12:00:00.000Z',
    type: 'movie',
    is4k: false,
    isAutoRequest: false,
    media: { id: 1, mediaType: 'movie', tmdbId: 100, tvdbId: null, status: MediaStatus.AVAILABLE, status4k: null, jellyfinMediaId: null },
    seasons: [],
    requestedBy: { id: requestedById, email: null, jellyfinUsername: null, jellyfinUserId: null, displayName: null },
    ...rest,
  };
}

describe('resolveRequestMembers — the "member" half of resolved requests', () => {
  it('matches a request to its member via requestedBy.id === member.seerrUserId', () => {
    const requests = [fakeSeerrRequest({ id: 1, requestedById: 8 })];
    const members = [{ ssoUsername: 'frank', seerrUserId: 8 }];
    const { resolved, unmatched } = resolveRequestMembers(requests, members);
    expect(unmatched).toEqual([]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ seerrRequestId: 1, ssoUsername: 'frank', mediaType: 'movie', tmdbId: 100, tvdbId: null, requestStatus: MediaRequestStatus.COMPLETED });
  });

  it('parses createdAt to unix seconds', () => {
    const requests = [fakeSeerrRequest({ id: 1, requestedById: 8, createdAt: '2026-08-24T00:00:00.000Z' })];
    const members = [{ ssoUsername: 'frank', seerrUserId: 8 }];
    const { resolved } = resolveRequestMembers(requests, members);
    expect(resolved[0].createdAt).toBe(Math.floor(Date.parse('2026-08-24T00:00:00.000Z') / 1000));
  });

  it('a request whose requestedBy.id matches no member.seerrUserId is surfaced in unmatched, never dropped', () => {
    const requests = [fakeSeerrRequest({ id: 1, requestedById: 999 })];
    const members = [{ ssoUsername: 'frank', seerrUserId: 8 }];
    const { resolved, unmatched } = resolveRequestMembers(requests, members);
    expect(resolved).toEqual([]);
    expect(unmatched).toEqual([{ seerrRequestId: 1, seerrUserId: 999 }]);
  });

  it('a member with seerrUserId: null (no Seerr account yet) never matches anything', () => {
    const requests = [fakeSeerrRequest({ id: 1, requestedById: 8 })];
    const members = [{ ssoUsername: 'ivy', seerrUserId: null }];
    const { resolved, unmatched } = resolveRequestMembers(requests, members);
    expect(resolved).toEqual([]);
    expect(unmatched).toEqual([{ seerrRequestId: 1, seerrUserId: 8 }]);
  });

  it('an orphan/not_entitled member row (e.g. akadmin) still resolves — it has a seerrUserId even though not entitled', () => {
    const requests = [fakeSeerrRequest({ id: 1, requestedById: 1 })];
    const members = [{ ssoUsername: 'seerr:1', seerrUserId: 1 }];
    const { resolved } = resolveRequestMembers(requests, members);
    expect(resolved[0].ssoUsername).toBe('seerr:1');
  });
});
