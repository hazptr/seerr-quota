import { describe, expect, it } from 'vitest';
import { UpstreamClient, UpstreamError } from '@/lib/http/client';
import { AuthentikClient } from '@/lib/authentik/client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function clientWithFetch(fetchImpl: typeof fetch): AuthentikClient {
  return new AuthentikClient(
    new UpstreamClient({ name: 'authentik', baseUrl: 'https://auth.local', auth: () => {}, timeoutMs: 5000, retries: 0, fetchImpl }),
  );
}

describe('AuthentikClient — structurally read-only (FR-SYNC-7)', () => {
  it('exposes exactly the three documented read methods and nothing else on its prototype', () => {
    const methodNames = Object.getOwnPropertyNames(AuthentikClient.prototype).filter((n) => n !== 'constructor');
    expect(methodNames.sort()).toEqual(['getApplicationBySlug', 'listActiveUsers', 'listPolicyBindingsForTarget'].sort());
  });

  it('every request issued is a GET — auth headers never accompany a write verb because none is ever sent', async () => {
    const methods: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET');
      if (methods.length === 1) return jsonResponse(200, { pk: 'app-uuid', slug: 'jellyseerr', name: 'Seerr' });
      if (methods.length === 2) return jsonResponse(200, { pagination: { next: 0 }, results: [] });
      return jsonResponse(200, { pagination: { next: 0 }, results: [] });
    }) as unknown as typeof fetch;
    const client = clientWithFetch(fetchImpl);
    await client.getApplicationBySlug('jellyseerr');
    await client.listPolicyBindingsForTarget('app-uuid');
    await client.listActiveUsers();
    expect(methods.every((m) => m === 'GET')).toBe(true);
  });
});

describe('AuthentikClient.getApplicationBySlug — the detail-by-slug form only', () => {
  it('requests /api/v3/core/applications/{slug}/ — NOT the list-with-?slug= form', async () => {
    let requestedUrl = '';
    const fetchImpl = (async (url: string) => {
      requestedUrl = url;
      return jsonResponse(200, { pk: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', slug: 'jellyseerr', name: 'Seerr' });
    }) as unknown as typeof fetch;
    const client = clientWithFetch(fetchImpl);
    const app = await client.getApplicationBySlug('jellyseerr');
    expect(requestedUrl).toContain('/api/v3/core/applications/jellyseerr/');
    expect(requestedUrl).not.toContain('?slug=');
    expect(app).toEqual({ uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', slug: 'jellyseerr', name: 'Seerr' });
  });

  it('rejects a response missing pk as invalid_response', async () => {
    const fetchImpl = (async () => jsonResponse(200, { slug: 'jellyseerr' })) as unknown as typeof fetch;
    const client = clientWithFetch(fetchImpl);
    const err = await client.getApplicationBySlug('jellyseerr').catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).code).toBe('invalid_response');
  });
});

describe('AuthentikClient.listPolicyBindingsForTarget', () => {
  it('parses a realistic binding row, including negate/enabled/user_obj', async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, {
        pagination: { count: 1, next: 0, previous: 0, current: 1, total_pages: 1 },
        results: [
          {
            pk: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001',
            policy: null,
            group: null,
            user: 101,
            policy_obj: null,
            group_obj: null,
            user_obj: {
              pk: 101,
              username: 'frank',
              name: 'Frank',
              is_active: true,
              last_login: '2026-01-01T00:00:00.000000Z',
              email: 'frank@example.com',
              attributes: {},
              uid: '0000000000000000000000000000000000000000000000000000000000000001',
            },
            target: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
            negate: false,
            enabled: true,
            order: 0,
          },
        ],
      })) as unknown as typeof fetch;
    const client = clientWithFetch(fetchImpl);
    const bindings = await client.listPolicyBindingsForTarget('aaaaaaaa-aaaa-4aaa-8aaa-000000000001');
    expect(bindings).toEqual([
      {
        pk: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001',
        user: 101,
        group: null,
        enabled: true,
        negate: false,
        userObj: { pk: 101, username: 'frank', name: 'Frank', email: 'frank@example.com', isActive: true },
      },
    ]);
  });

  it('tolerates a group/policy-type binding (user: null) rather than crashing', async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, {
        pagination: { next: 0 },
        results: [{ pk: 'b1', user: null, group: 'some-group-uuid', enabled: true, negate: false, user_obj: null }],
      })) as unknown as typeof fetch;
    const client = clientWithFetch(fetchImpl);
    const bindings = await client.listPolicyBindingsForTarget('target-uuid');
    expect(bindings[0].user).toBeNull();
    expect(bindings[0].group).toBe('some-group-uuid');
  });

  it('follows pagination.next (a page NUMBER, 0 = no more pages) across multiple pages', async () => {
    const pages = [
      { pagination: { next: 2 }, results: [{ pk: 'b1', user: 1, group: null, enabled: true, negate: false, user_obj: null }] },
      { pagination: { next: 0 }, results: [{ pk: 'b2', user: 2, group: null, enabled: true, negate: false, user_obj: null }] },
    ];
    let call = 0;
    const fetchImpl = (async () => jsonResponse(200, pages[call++])) as unknown as typeof fetch;
    const client = clientWithFetch(fetchImpl);
    const bindings = await client.listPolicyBindingsForTarget('target-uuid');
    expect(bindings.map((b) => b.pk)).toEqual(['b1', 'b2']);
    expect(call).toBe(2);
  });

  it('rejects a response not shaped {results: [...]} as invalid_response', async () => {
    const fetchImpl = (async () => jsonResponse(200, { oops: true })) as unknown as typeof fetch;
    const client = clientWithFetch(fetchImpl);
    const err = await client.listPolicyBindingsForTarget('target-uuid').catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).code).toBe('invalid_response');
  });
});

describe('AuthentikClient.listActiveUsers', () => {
  it('parses a realistic user row with the stable uuid the binding user_obj lacks; no groups_obj -> groupNames: []', async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, {
        pagination: { next: 0 },
        results: [
          { pk: 101, uuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff', username: 'frank', name: 'Frank', email: 'frank@example.com', is_active: true },
        ],
      })) as unknown as typeof fetch;
    const client = clientWithFetch(fetchImpl);
    const users = await client.listActiveUsers();
    expect(users).toEqual([
      { pk: 101, uuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff', username: 'frank', name: 'Frank', email: 'frank@example.com', isActive: true, groupNames: [] },
    ]);
  });

  it('parses groups_obj[].name into groupNames (GET /core/users/?username=admin returns groups_obj: [{name: "admins"}])', async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, {
        pagination: { next: 0 },
        results: [
          {
            pk: 1,
            uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002',
            username: 'admin',
            name: 'Admin',
            email: 'admin@example.com',
            is_active: true,
            groups: ['cccccccc-cccc-4ccc-8ccc-000000000001'],
            groups_obj: [{ pk: 'cccccccc-cccc-4ccc-8ccc-000000000001', name: 'admins' }],
          },
        ],
      })) as unknown as typeof fetch;
    const client = clientWithFetch(fetchImpl);
    const users = await client.listActiveUsers();
    expect(users[0].groupNames).toEqual(['admins']);
  });

  it('tolerates a missing/malformed groups_obj entry rather than crashing', async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, {
        pagination: { next: 0 },
        results: [
          {
            pk: 1,
            uuid: 'u1',
            username: 'someone',
            is_active: true,
            groups_obj: [{ pk: 'g1', name: 'admins' }, { pk: 'g2' /* no name */ }, 'not-an-object', null],
          },
        ],
      })) as unknown as typeof fetch;
    const client = clientWithFetch(fetchImpl);
    const users = await client.listActiveUsers();
    expect(users[0].groupNames).toEqual(['admins']);
  });

  it('requests with is_active=true', async () => {
    let requestedUrl = '';
    const fetchImpl = (async (url: string) => {
      requestedUrl = url;
      return jsonResponse(200, { pagination: { next: 0 }, results: [] });
    }) as unknown as typeof fetch;
    const client = clientWithFetch(fetchImpl);
    await client.listActiveUsers();
    expect(requestedUrl).toContain('is_active=true');
  });

  it('rejects a user row missing uuid as invalid_response', async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, { pagination: { next: 0 }, results: [{ pk: 101, username: 'frank', is_active: true }] })) as unknown as typeof fetch;
    const client = clientWithFetch(fetchImpl);
    const err = await client.listActiveUsers().catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).code).toBe('invalid_response');
  });
});
