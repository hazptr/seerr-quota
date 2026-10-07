import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `GET /api/quota-status` (P2-10). Covers the route's own responsibilities
 * (identity resolution, response wiring) — the state-machine math is
 * `test/quota-status-derive.test.ts`'s job and the DB-scoping guarantees are
 * `test/quota-status-load.test.ts`'s; this suite proves the two are wired
 * together correctly behind a real `Identity`.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-status-route-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

// `next/headers`' `headers()` only works inside a real request's
// AsyncLocalStorage scope — mocked the same way test/auth-authorize.test.ts
// mocks it for the same reason.
const headersStore: { current: Headers } = { current: new Headers() };
vi.mock('next/headers', () => ({
  headers: async () => headersStore.current,
}));

const { GET } = await import('@/app/api/quota-status/route');
const { getDb } = await import('@/lib/db');
const { member, quotaPolicy, requestDecision, title, claim } = await import('@/lib/db/schema');
const { _resetConfigCacheForTests } = await import('@/lib/config');

const ORIGINAL_ENV = { ...process.env };

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  headersStore.current = new Headers();
  process.env = { ...ORIGINAL_ENV, DB_PATH: tmpDbPath };
  _resetConfigCacheForTests();
});

describe('GET /api/quota-status — FR-BAN-3: unreachable without Remote-User', () => {
  it('401s when Remote-User is missing (defensive — src/middleware.ts already gates this in production)', async () => {
    const res = await GET();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'unauthorized' });
  });

  it('401s on a whitespace-only Remote-User too', async () => {
    headersStore.current = new Headers({ 'Remote-User': '   ' });
    const res = await GET();
    expect(res.status).toBe(401);
  });
});

describe('GET /api/quota-status — returns the caller\'s own figures', () => {
  const now = 1_000_000;
  let arrId = 1;

  it('a member in good standing gets state=ok with their real usage/quota', async () => {
    headersStore.current = new Headers({ 'Remote-User': 'GoodStanding' }); // mixed case — proves lowercasing round-trips
    getDb()
      .insert(member)
      .values({ ssoUsername: 'goodstanding', entitled: true, isOperator: false, syncStatus: 'matched', firstSeenAt: now, lastSyncedAt: now })
      .run();
    getDb()
      .insert(quotaPolicy)
      .values({ ssoUsername: 'goodstanding', quotaBytes: 900_000_000_000, source: 'default', updatedAt: now, updatedBy: 'system' })
      .run();

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      state: 'ok',
      usageBytes: 0,
      quotaBytes: 900_000_000_000,
      shortfallBytes: 0,
      heldRequests: 0,
      url: 'https://quota.example.com',
    });
  });

  it('an over-quota member with held requests gets the full FR-BAN-5 figure set', async () => {
    headersStore.current = new Headers({ 'Remote-User': 'overquota' });
    getDb()
      .insert(member)
      .values({ ssoUsername: 'overquota', entitled: true, isOperator: false, syncStatus: 'matched', firstSeenAt: now, lastSyncedAt: now })
      .run();
    getDb()
      .insert(quotaPolicy)
      .values({ ssoUsername: 'overquota', quotaBytes: 900_000_000_000, source: 'default', updatedAt: now, updatedBy: 'system' })
      .run();
    getDb()
      .insert(title)
      .values({
        id: 'movie:big-one',
        mediaType: 'movie',
        arrInstance: 'radarr',
        arrId: arrId++,
        title: 'big one',
        year: 2020,
        sizeBytes: 1_040_000_000_000,
        path: '/data/media/movies/big-one',
        addedAt: now,
        lastSyncedAt: now,
      })
      .run();
    getDb().insert(claim).values({ titleId: 'movie:big-one', ssoUsername: 'overquota', chargedBytes: 1_040_000_000_000, active: true, createdAt: now }).run();
    getDb()
      .insert(requestDecision)
      .values({
        seerrRequestId: 5001,
        ssoUsername: 'overquota',
        decision: 'hold',
        reason: 'over_quota',
        enforced: true,
        usageBytes: 1_040_000_000_000,
        quotaBytes: 900_000_000_000,
        source: 'poller',
        heldSince: now,
        decidedAt: now,
      })
      .run();

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      state: 'over_quota',
      usageBytes: 1_040_000_000_000,
      quotaBytes: 900_000_000_000,
      shortfallBytes: 140_000_000_000,
      heldRequests: 1,
      url: 'https://quota.example.com',
    });
  });

  it("one member's call never returns another member's figures (FR-BAN-3, exercised end-to-end through the route)", async () => {
    headersStore.current = new Headers({ 'Remote-User': 'goodstanding' });
    const res = await GET();
    const body = await res.json();
    // Must NOT pick up 'overquota's usage/held-request figures from the
    // previous test — proves the route threads the resolved identity's
    // username through, not some shared/cached state.
    expect(body.usageBytes).toBe(0);
    expect(body.heldRequests).toBe(0);
    expect(body.state).toBe('ok');
  });

  it('a member with no member/quota_policy row at all gets state=unconfigured, not a 500', async () => {
    headersStore.current = new Headers({ 'Remote-User': 'brandnew' });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe('unconfigured');
    expect(body.quotaBytes).toBeNull();
  });
});
