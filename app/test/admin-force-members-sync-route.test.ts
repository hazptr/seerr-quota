import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `POST /api/admin/reconcile/force-members-sync` — second security review
 * (PR #17), SHOULD-FIX 2: the one-shot operator override for
 * `checkMassRevocationRisk`'s refusal. Mocks `syncMembers` itself (same
 * technique as `test/admin-reconcile-route.test.ts`) so this suite proves
 * the ROUTE's own wiring (auth, `forceApply`/`forcedBy` threading) without
 * touching a real upstream.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-force-members-sync-route-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const headersStore: { current: Headers } = { current: new Headers() };
vi.mock('next/headers', () => ({
  headers: async () => headersStore.current,
}));

const syncMembersMock = vi.fn(async (_deps: unknown, _now: unknown, options: unknown) => ({
  seerrUsers: { ok: true, count: 1, ms: 1 },
  classify: { ok: true, count: 1, ms: 1 },
  syncRunId: 1,
  classified: [],
  _options: options,
}));
vi.mock('@/lib/members/sync', () => ({ syncMembers: (deps: unknown, now: unknown, options: unknown) => syncMembersMock(deps, now, options) }));

const { getDb, _resetDbForTests } = await import('@/lib/db');
const { audit } = await import('@/lib/db/schema');
const { _resetConfigCacheForTests } = await import('@/lib/config');
const { NextRequest } = await import('next/server');
const { POST } = await import('@/app/api/admin/reconcile/force-members-sync/route');

const ORIGINAL_ENV = { ...process.env };
const OPERATOR = 'admin';

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  _resetDbForTests();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${tmpDbPath}${suffix}`, { force: true });
  process.env.ADMIN_USERS = OPERATOR;
  _resetConfigCacheForTests();
  headersStore.current = new Headers();
  syncMembersMock.mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV, DB_PATH: tmpDbPath };
  _resetConfigCacheForTests();
});

function postForce() {
  return new NextRequest('http://x/api/admin/reconcile/force-members-sync', { method: 'POST' });
}

describe('POST /api/admin/reconcile/force-members-sync — FR-ADM-1: member direct-POST', () => {
  it('403s for a member and never calls syncMembers', async () => {
    headersStore.current = new Headers({ 'Remote-User': 'dana' });
    const res = await POST(postForce());
    expect(res.status).toBe(403);
    expect(syncMembersMock).not.toHaveBeenCalled();
    const rows = getDb().select().from(audit).where(eq(audit.action, 'access.denied')).all();
    expect(rows.find((r) => r.actor === 'dana')).toBeDefined();
  });
});

describe('POST /api/admin/reconcile/force-members-sync — operator path', () => {
  it('calls syncMembers with forceApply:true and forcedBy set to the operator', async () => {
    headersStore.current = new Headers({ 'Remote-User': OPERATOR });
    const res = await POST(postForce());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    expect(syncMembersMock).toHaveBeenCalledTimes(1);
    const [, , options] = syncMembersMock.mock.calls[0];
    expect(options).toEqual({ forceApply: true, forcedBy: OPERATOR });
  });

  it('reports ok:false when the forced cycle itself still fails for an unrelated reason', async () => {
    syncMembersMock.mockResolvedValueOnce({
      seerrUsers: { ok: true, count: 0, ms: 1 },
      classify: { ok: false, count: 0, ms: 1, error: 'boom' },
      syncRunId: 2,
      classified: [],
    } as never);
    headersStore.current = new Headers({ 'Remote-User': OPERATOR });
    const res = await POST(postForce());
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.classify.error).toBe('boom');
  });
});
