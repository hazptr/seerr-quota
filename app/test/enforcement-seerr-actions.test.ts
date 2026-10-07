import { describe, expect, it } from 'vitest';
import { UpstreamClient, noAuth } from '@/lib/http/client';
import { EnforcementSeerrActions } from '@/lib/enforcement/seerrActions';
import { MediaRequestStatus } from '@/lib/seerr/types';

/** Mirrors `test/seerr-client.test.ts`'s fetch-mocking style for the same `UpstreamClient`. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

function actionsWithFetch(fetchImpl: typeof fetch): EnforcementSeerrActions {
  return new EnforcementSeerrActions(
    new UpstreamClient({ name: 'seerr', baseUrl: 'http://seerr.local', auth: noAuth(), timeoutMs: 5000, retries: 0, fetchImpl }),
  );
}

describe('EnforcementSeerrActions.getRequestById', () => {
  it('parses id/status/requestedBy.id from a realistic single-request response, tolerating extra fields', async () => {
    let calledUrl = '';
    const client = actionsWithFetch(async (input) => {
      calledUrl = String(input);
      return jsonResponse(200, {
        id: 97,
        status: MediaRequestStatus.PENDING,
        seasonCount: 3,
        createdAt: '2026-08-24T12:31:17.000Z',
        media: { id: 195, mediaType: 'tv', tmdbId: null, tvdbId: 347645, status: 3, status4k: 1 },
        requestedBy: { id: 8, email: 'frank@example.com', jellyfinUsername: 'frank', extraField: 'ignored' },
      });
    });

    const result = await client.getRequestById(97);
    expect(result).toEqual({ id: 97, status: MediaRequestStatus.PENDING, requestedBySeerrUserId: 8 });
    expect(calledUrl).toBe('http://seerr.local/api/v1/request/97');
  });

  it('throws UpstreamError (invalid_response) when requestedBy.id is missing', async () => {
    const client = actionsWithFetch(async () => jsonResponse(200, { id: 97, status: MediaRequestStatus.PENDING, requestedBy: {} }));
    await expect(client.getRequestById(97)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('throws UpstreamError (invalid_response) on an unrecognised status value (stale-spec regression guard)', async () => {
    const client = actionsWithFetch(async () => jsonResponse(200, { id: 97, status: 999, requestedBy: { id: 8 } }));
    await expect(client.getRequestById(97)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('throws UpstreamError (http_error) on a 404 — a request id that no longer exists', async () => {
    const client = actionsWithFetch(async () => emptyResponse(404));
    await expect(client.getRequestById(404)).rejects.toMatchObject({ code: 'http_error', status: 404 });
  });
});

describe('EnforcementSeerrActions.approveRequest / declineRequest', () => {
  it('POSTs to /api/v1/request/{id}/approve with no request body (verified: Seerr\'s API accepts none)', async () => {
    let capturedMethod = '';
    let capturedUrl = '';
    let capturedBody: BodyInit | null | undefined;
    const client = actionsWithFetch(async (input, init) => {
      capturedUrl = String(input);
      capturedMethod = init?.method ?? 'GET';
      capturedBody = init?.body;
      return jsonResponse(200, { id: 42, status: MediaRequestStatus.APPROVED });
    });

    await client.approveRequest(42);
    expect(capturedUrl).toBe('http://seerr.local/api/v1/request/42/approve');
    expect(capturedMethod).toBe('POST');
    expect(capturedBody).toBeUndefined();
  });

  it('POSTs to /api/v1/request/{id}/decline with no request body', async () => {
    let capturedUrl = '';
    const client = actionsWithFetch(async (input) => {
      capturedUrl = String(input);
      return jsonResponse(200, { id: 42, status: MediaRequestStatus.DECLINED });
    });

    await client.declineRequest(42);
    expect(capturedUrl).toBe('http://seerr.local/api/v1/request/42/decline');
  });

  it('approveRequest rejects with UpstreamError on a 500, carrying the status', async () => {
    const client = actionsWithFetch(async () => emptyResponse(500));
    await expect(client.approveRequest(42)).rejects.toMatchObject({ code: 'http_error', status: 500 });
  });
});
