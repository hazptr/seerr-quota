import { describe, expect, it } from 'vitest';
import { noAuth, UpstreamClient, UpstreamError } from '@/lib/http/client';
import { RadarrDeleteClient, SonarrDeleteClient, radarrDeleteCallUrl, sonarrDeleteCallUrl } from '@/lib/deletion/arrActions';

function emptyOkResponse(): Response {
  return new Response('', { status: 200 });
}

/** A fetchImpl that returns one canned result per call, in order. */
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

describe('RadarrDeleteClient.deleteMovie — FR-DEL-10 param name (verified P0-2, tag v6.1.1.10360)', () => {
  it('issues DELETE /api/v3/movie/{id}?deleteFiles=true&addImportExclusion=false', async () => {
    const { fetchImpl, calls } = queuedFetch([emptyOkResponse]);
    const client = new RadarrDeleteClient(new UpstreamClient({ name: 'radarr', baseUrl: 'http://radarr.local', auth: noAuth(), timeoutMs: 5000, retries: 2, fetchImpl }));

    await client.deleteMovie(42);

    expect(calls).toHaveLength(1);
    const [url, init] = calls[0] as [string, RequestInit];
    expect(init.method).toBe('DELETE');
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/api/v3/movie/42');
    expect(parsed.searchParams.get('deleteFiles')).toBe('true');
    expect(parsed.searchParams.get('addImportExclusion')).toBe('false');
    // Radarr's param, NOT Sonarr's — the whole point of FR-DEL-10.
    expect(parsed.searchParams.has('addImportListExclusion')).toBe(false);
  });

  it('a DELETE is NEVER retried even on a 500 (AGENTS.md rule 11) — exactly one fetch call', async () => {
    const { fetchImpl, calls } = queuedFetch([() => new Response('server error', { status: 500 })]);
    const client = new RadarrDeleteClient(new UpstreamClient({ name: 'radarr', baseUrl: 'http://radarr.local', auth: noAuth(), timeoutMs: 5000, retries: 5, fetchImpl }));

    await expect(client.deleteMovie(42)).rejects.toBeInstanceOf(UpstreamError);
    expect(calls).toHaveLength(1); // NOT 6 — retries=5 is ignored for DELETE by the shared client
  });
});

describe('SonarrDeleteClient.deleteSeries — FR-DEL-10 param name (verified P0-2, tag v4.0.19.2979)', () => {
  it('issues DELETE /api/v3/series/{id}?deleteFiles=true&addImportListExclusion=false — NOT addImportExclusion', async () => {
    const { fetchImpl, calls } = queuedFetch([emptyOkResponse]);
    const client = new SonarrDeleteClient(new UpstreamClient({ name: 'sonarr', baseUrl: 'http://sonarr.local', auth: noAuth(), timeoutMs: 5000, retries: 2, fetchImpl }));

    await client.deleteSeries(7);

    expect(calls).toHaveLength(1);
    const [url, init] = calls[0] as [string, RequestInit];
    expect(init.method).toBe('DELETE');
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/api/v3/series/7');
    expect(parsed.searchParams.get('deleteFiles')).toBe('true');
    expect(parsed.searchParams.get('addImportListExclusion')).toBe('false');
    // The exact bug the wiki's P0-2 spike caught: Sonarr's param is NOT
    // addImportExclusion — that name silently no-ops on this endpoint.
    expect(parsed.searchParams.has('addImportExclusion')).toBe(false);
  });

  it('a DELETE is NEVER retried even on a 500', async () => {
    const { fetchImpl, calls } = queuedFetch([() => new Response('server error', { status: 500 })]);
    const client = new SonarrDeleteClient(new UpstreamClient({ name: 'sonarr', baseUrl: 'http://sonarr.local', auth: noAuth(), timeoutMs: 5000, retries: 5, fetchImpl }));

    await expect(client.deleteSeries(7)).rejects.toBeInstanceOf(UpstreamError);
    expect(calls).toHaveLength(1);
  });
});

describe('display-only call-URL builders — never carry the API key (FR-AUD-11)', () => {
  it('radarrDeleteCallUrl matches the real call shape and strips a trailing slash', () => {
    expect(radarrDeleteCallUrl('http://radarr:7878/', 5)).toBe('http://radarr:7878/api/v3/movie/5?deleteFiles=true&addImportExclusion=false');
  });

  it('sonarrDeleteCallUrl matches the real call shape', () => {
    expect(sonarrDeleteCallUrl('http://sonarr:8989', 9)).toBe('http://sonarr:8989/api/v3/series/9?deleteFiles=true&addImportListExclusion=false');
  });
});
