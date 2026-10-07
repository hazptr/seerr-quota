import { describe, expect, it } from 'vitest';
import { noAuth, UpstreamClient, UpstreamError } from '@/lib/http/client';
import { SeerrCleanupClient, seerrDeleteRequestCallUrl } from '@/lib/deletion/seerrCleanup';

function emptyOkResponse(): Response {
  return new Response('', { status: 200 });
}

function queuedFetch(steps: Array<() => Response>): { fetchImpl: typeof fetch; calls: unknown[][] } {
  const calls: unknown[][] = [];
  let i = 0;
  const fetchImpl = (async (...args: unknown[]) => {
    calls.push(args);
    const step = steps[i++];
    if (!step) throw new Error('test bug: fetchImpl called more times than expected');
    return step();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('SeerrCleanupClient.deleteRequest (FR-DEL-9)', () => {
  it('issues DELETE /api/v1/request/{id} with no query params or body', async () => {
    const { fetchImpl, calls } = queuedFetch([emptyOkResponse]);
    const client = new SeerrCleanupClient(new UpstreamClient({ name: 'seerr', baseUrl: 'http://jellyseerr:5055', auth: noAuth(), timeoutMs: 5000, retries: 2, fetchImpl }));

    await client.deleteRequest(123);

    expect(calls).toHaveLength(1);
    const [url, init] = calls[0] as [string, RequestInit];
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/api/v1/request/123');
    expect([...parsed.searchParams.keys()]).toHaveLength(0);
  });

  it('a DELETE is never retried even on a 500', async () => {
    const { fetchImpl, calls } = queuedFetch([() => new Response('err', { status: 500 })]);
    const client = new SeerrCleanupClient(new UpstreamClient({ name: 'seerr', baseUrl: 'http://jellyseerr:5055', auth: noAuth(), timeoutMs: 5000, retries: 5, fetchImpl }));

    await expect(client.deleteRequest(123)).rejects.toBeInstanceOf(UpstreamError);
    expect(calls).toHaveLength(1);
  });
});

describe('seerrDeleteRequestCallUrl', () => {
  it('builds the display-only URL', () => {
    expect(seerrDeleteRequestCallUrl('http://jellyseerr:5055/', 55)).toBe('http://jellyseerr:5055/api/v1/request/55');
  });
});
