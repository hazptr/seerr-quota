import { describe, expect, it, vi } from 'vitest';
import { apiKeyAuth, bearerAuth, noAuth, UpstreamClient, UpstreamError } from '@/lib/http/client';

const NO_DELAY = async () => {
  // test seam: skip real backoff waits
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A fetchImpl that returns one canned result per call, in order, then throws if exhausted. */
function queuedFetch(steps: Array<() => Response | Promise<Response>>): { fetchImpl: typeof fetch; calls: unknown[][] } {
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

function hangingFetch(): { fetchImpl: typeof fetch; calls: number } {
  let calls = 0;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    get calls() {
      return calls;
    },
  } as { fetchImpl: typeof fetch; calls: number };
}

describe('auth strategies apply headers, never leak into errors', () => {
  it('apiKeyAuth sets the named header to the key', () => {
    const headers: Record<string, string> = {};
    apiKeyAuth('X-Api-Key', 'secret-123')(headers);
    expect(headers).toEqual({ 'X-Api-Key': 'secret-123' });
  });

  it('bearerAuth sets Authorization: Bearer <token>', () => {
    const headers: Record<string, string> = {};
    bearerAuth('tok-abc')(headers);
    expect(headers).toEqual({ Authorization: 'Bearer tok-abc' });
  });

  it('noAuth sets nothing', () => {
    const headers: Record<string, string> = {};
    noAuth()(headers);
    expect(headers).toEqual({});
  });
});

describe('UpstreamClient — successful requests', () => {
  it('GET returns the parsed JSON body, and applies the configured auth header to the outgoing request', async () => {
    const { fetchImpl, calls } = queuedFetch([() => jsonResponse(200, { hello: 'world' })]);
    const client = new UpstreamClient({
      name: 'testsvc',
      baseUrl: 'http://testsvc.local',
      auth: apiKeyAuth('X-Api-Key', 'the-secret-key'),
      timeoutMs: 5000,
      retries: 2,
      fetchImpl,
    });
    const result = await client.request<{ hello: string }>('/thing');
    expect(result).toEqual({ hello: 'world' });
    expect(calls).toHaveLength(1);
    const [, init] = calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-Api-Key']).toBe('the-secret-key');
  });

  it('builds the URL from baseUrl + path + query, omitting undefined query values', async () => {
    const { fetchImpl, calls } = queuedFetch([() => jsonResponse(200, [])]);
    const client = new UpstreamClient({
      name: 'testsvc',
      baseUrl: 'http://testsvc.local/',
      auth: noAuth(),
      timeoutMs: 5000,
      retries: 0,
      fetchImpl,
    });
    await client.request('/api/v1/request', { query: { take: 100, skip: 0, filter: undefined } });
    const [url] = calls[0] as [string, RequestInit];
    expect(url).toBe('http://testsvc.local/api/v1/request?take=100&skip=0');
  });

  it('returns undefined for an empty response body (e.g. a 204)', async () => {
    const { fetchImpl } = queuedFetch([() => new Response(null, { status: 204 })]);
    const client = new UpstreamClient({
      name: 'testsvc',
      baseUrl: 'http://testsvc.local',
      auth: noAuth(),
      timeoutMs: 5000,
      retries: 0,
      fetchImpl,
    });
    await expect(client.request('/x')).resolves.toBeUndefined();
  });
});

describe('UpstreamClient.requestWithStatus — exposes the OBSERVED HTTP status', () => {
  it('returns both the parsed body and the real status on a 200', async () => {
    const { fetchImpl } = queuedFetch([() => jsonResponse(200, { hello: 'world' })]);
    const client = new UpstreamClient({ name: 'testsvc', baseUrl: 'http://testsvc.local', auth: noAuth(), timeoutMs: 5000, retries: 0, fetchImpl });
    const result = await client.requestWithStatus<{ hello: string }>('/thing');
    expect(result).toEqual({ data: { hello: 'world' }, status: 200 });
  });

  it('surfaces a non-200 SUCCESS status honestly (e.g. 204 on an empty DELETE response) — this is the whole point: FR-DEL-7 audit rows must record what actually happened, not an assumed 200', async () => {
    const { fetchImpl } = queuedFetch([() => new Response(null, { status: 204 })]);
    const client = new UpstreamClient({ name: 'testsvc', baseUrl: 'http://testsvc.local', auth: noAuth(), timeoutMs: 5000, retries: 0, fetchImpl });
    const result = await client.requestWithStatus('/x', { method: 'DELETE' });
    expect(result).toEqual({ data: undefined, status: 204 });
  });

  it('`request()` is a thin wrapper that only ever returns the body, discarding the status', async () => {
    const { fetchImpl } = queuedFetch([() => jsonResponse(201, { id: 5 })]);
    const client = new UpstreamClient({ name: 'testsvc', baseUrl: 'http://testsvc.local', auth: noAuth(), timeoutMs: 5000, retries: 0, fetchImpl });
    await expect(client.request<{ id: number }>('/x')).resolves.toEqual({ id: 5 });
  });
});

describe('UpstreamClient — error classification', () => {
  it('a non-2xx response throws UpstreamError code=http_error with status + a body snippet', async () => {
    const { fetchImpl } = queuedFetch([() => jsonResponse(404, { message: 'not found' })]);
    const client = new UpstreamClient({
      name: 'testsvc',
      baseUrl: 'http://testsvc.local',
      auth: noAuth(),
      timeoutMs: 5000,
      retries: 0,
      fetchImpl,
    });
    const err = await client.request('/missing').catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).code).toBe('http_error');
    expect((err as UpstreamError).status).toBe(404);
    expect((err as UpstreamError).bodySnippet).toContain('not found');
  });

  it('a fetch rejection (not caused by our own timeout) throws UpstreamError code=network_error', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const client = new UpstreamClient({
      name: 'testsvc',
      baseUrl: 'http://testsvc.local',
      auth: noAuth(),
      timeoutMs: 5000,
      retries: 0,
      fetchImpl,
    });
    const err = await client.request('/x').catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).code).toBe('network_error');
  });

  it('non-JSON response body throws UpstreamError code=invalid_json', async () => {
    const { fetchImpl } = queuedFetch([() => new Response('<html>not json</html>', { status: 200 })]);
    const client = new UpstreamClient({
      name: 'testsvc',
      baseUrl: 'http://testsvc.local',
      auth: noAuth(),
      timeoutMs: 5000,
      retries: 2,
      fetchImpl,
      sleepImpl: NO_DELAY,
    });
    const err = await client.request('/x').catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).code).toBe('invalid_json');
  });

  it('a hung request is aborted after timeoutMs and throws UpstreamError code=timeout', async () => {
    const { fetchImpl } = hangingFetch();
    const client = new UpstreamClient({
      name: 'testsvc',
      baseUrl: 'http://testsvc.local',
      auth: noAuth(),
      timeoutMs: 15,
      retries: 0,
      fetchImpl,
    });
    const err = await client.request('/x').catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).code).toBe('timeout');
  });
});

describe('UpstreamClient — retry policy (UPSTREAM_RETRIES, wiki/Configuration.md §Scheduling)', () => {
  it('retries a failing GET up to `retries` times with backoff, then succeeds on the final attempt', async () => {
    const { fetchImpl, calls } = queuedFetch([
      () => jsonResponse(500, { message: 'server hiccup' }),
      () => jsonResponse(500, { message: 'server hiccup again' }),
      () => jsonResponse(200, { ok: true }),
    ]);
    const client = new UpstreamClient({
      name: 'testsvc',
      baseUrl: 'http://testsvc.local',
      auth: noAuth(),
      timeoutMs: 5000,
      retries: 2,
      fetchImpl,
      sleepImpl: NO_DELAY,
    });
    const result = await client.request('/x');
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(3); // 1 initial + 2 retries
  });

  it('exhausts retries and throws the last error when every attempt fails', async () => {
    const { fetchImpl, calls } = queuedFetch([
      () => jsonResponse(503, {}),
      () => jsonResponse(503, {}),
      () => jsonResponse(503, {}),
    ]);
    const client = new UpstreamClient({
      name: 'testsvc',
      baseUrl: 'http://testsvc.local',
      auth: noAuth(),
      timeoutMs: 5000,
      retries: 2,
      fetchImpl,
      sleepImpl: NO_DELAY,
    });
    const err = await client.request('/x').catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).status).toBe(503);
    expect(calls).toHaveLength(3); // 1 initial + 2 retries, no more
  });

  it('does NOT retry a 4xx — retrying a definitive client error is pointless', async () => {
    const { fetchImpl, calls } = queuedFetch([() => jsonResponse(400, { message: 'bad request' })]);
    const client = new UpstreamClient({
      name: 'testsvc',
      baseUrl: 'http://testsvc.local',
      auth: noAuth(),
      timeoutMs: 5000,
      retries: 2,
      fetchImpl,
      sleepImpl: NO_DELAY,
    });
    await expect(client.request('/x')).rejects.toBeInstanceOf(UpstreamError);
    expect(calls).toHaveLength(1);
  });

  it('sleeps with exponential backoff between retries', async () => {
    const sleepImpl = vi.fn(async (_ms: number) => {});
    const { fetchImpl } = queuedFetch([() => jsonResponse(500, {}), () => jsonResponse(500, {}), () => jsonResponse(200, {})]);
    const client = new UpstreamClient({
      name: 'testsvc',
      baseUrl: 'http://testsvc.local',
      auth: noAuth(),
      timeoutMs: 5000,
      retries: 2,
      fetchImpl,
      sleepImpl,
    });
    await client.request('/x');
    expect(sleepImpl).toHaveBeenCalledTimes(2);
    const delays = sleepImpl.mock.calls.map((c) => c[0]);
    expect(delays[1]).toBeGreaterThan(delays[0]); // backoff grows
  });
});

describe('UpstreamClient — DELETE is NEVER retried (AGENTS.md rule 11, hard rule not a tunable)', () => {
  it('a DELETE that fails with a 5xx is attempted exactly once, even with retries configured', async () => {
    const { fetchImpl, calls } = queuedFetch([() => jsonResponse(503, {})]);
    const client = new UpstreamClient({
      name: 'testsvc',
      baseUrl: 'http://testsvc.local',
      auth: noAuth(),
      timeoutMs: 5000,
      retries: 5, // deliberately high — must still not matter for DELETE
      fetchImpl,
      sleepImpl: NO_DELAY,
    });
    await expect(client.request('/thing/1', { method: 'DELETE' })).rejects.toBeInstanceOf(UpstreamError);
    expect(calls).toHaveLength(1);
  });

  it('a DELETE that fails with a network error is attempted exactly once', async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts++;
      throw new TypeError('network down');
    }) as unknown as typeof fetch;
    const client = new UpstreamClient({
      name: 'testsvc',
      baseUrl: 'http://testsvc.local',
      auth: noAuth(),
      timeoutMs: 5000,
      retries: 5,
      fetchImpl,
      sleepImpl: NO_DELAY,
    });
    await expect(client.request('/thing/1', { method: 'DELETE' })).rejects.toBeInstanceOf(UpstreamError);
    expect(attempts).toBe(1);
  });

  it('a successful DELETE still only makes one call (sanity: retry-avoidance is not why it succeeded)', async () => {
    const { fetchImpl, calls } = queuedFetch([() => new Response(null, { status: 204 })]);
    const client = new UpstreamClient({
      name: 'testsvc',
      baseUrl: 'http://testsvc.local',
      auth: noAuth(),
      timeoutMs: 5000,
      retries: 2,
      fetchImpl,
    });
    await client.request('/thing/1', { method: 'DELETE' });
    expect(calls).toHaveLength(1);
  });
});

describe('UpstreamClient — secrets never leak into errors', () => {
  const SECRET = 'X-Api-Key-Value-Must-Never-Appear-Anywhere';

  it('a network-error message/JSON never contains the api key, even though it was applied to the outgoing request', async () => {
    const { calls } = queuedFetch([]);
    // Force a network failure by having fetchImpl reject.
    const failingFetch = (async (...args: unknown[]) => {
      calls.push(args);
      throw new TypeError('connection refused');
    }) as unknown as typeof fetch;
    const client = new UpstreamClient({
      name: 'radarr',
      baseUrl: 'http://radarr.local',
      auth: apiKeyAuth('X-Api-Key', SECRET),
      timeoutMs: 5000,
      retries: 0,
      fetchImpl: failingFetch,
    });
    const err = (await client.request('/api/v3/movie').catch((e) => e)) as UpstreamError;
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.message).not.toContain(SECRET);
    expect(JSON.stringify(err)).not.toContain(SECRET);
    expect(JSON.stringify(err.toJSON())).not.toContain(SECRET);
    // Sanity: prove the auth WAS applied to the actual outgoing request (so
    // this test is verifying "secret used but not leaked", not "secret
    // never used at all").
    const [, init] = calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-Api-Key']).toBe(SECRET);
  });

  it('an http_error message/JSON never contains the api key', async () => {
    const { fetchImpl } = queuedFetch([() => jsonResponse(401, { message: 'unauthorized' })]);
    const client = new UpstreamClient({
      name: 'radarr',
      baseUrl: 'http://radarr.local',
      auth: apiKeyAuth('X-Api-Key', SECRET),
      timeoutMs: 5000,
      retries: 0,
      fetchImpl,
    });
    const err = (await client.request('/api/v3/movie').catch((e) => e)) as UpstreamError;
    expect(err.message).not.toContain(SECRET);
    expect(JSON.stringify(err)).not.toContain(SECRET);
    expect(JSON.stringify(err.toJSON())).not.toContain(SECRET);
  });

  it('a bearer-auth token never leaks into a network-error message', async () => {
    const TOKEN = 'authentik-service-token-must-not-leak';
    const fetchImpl = (async () => {
      throw new TypeError('refused');
    }) as unknown as typeof fetch;
    const client = new UpstreamClient({
      name: 'authentik',
      baseUrl: 'http://authentik.local',
      auth: bearerAuth(TOKEN),
      timeoutMs: 5000,
      retries: 0,
      fetchImpl,
    });
    const err = (await client.request('/x').catch((e) => e)) as UpstreamError;
    expect(err.message).not.toContain(TOKEN);
    expect(JSON.stringify(err)).not.toContain(TOKEN);
  });
});
