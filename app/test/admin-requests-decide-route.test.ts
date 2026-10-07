import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `POST /api/admin/requests/decide` — `FR-ADM-8`/`FR-ENF-11`. Mocks
 * `@/lib/enforcement`'s `processPendingRequest` (same technique
 * test/enforcement-webhook-route.test.ts uses for the webhook route) — this
 * suite is about the ROUTE's own responsibilities (auth, input parsing,
 * wiring `source: 'manual'`), never a real Seerr call.
 *
 * P2-7: also mocks `createEnforcementNotifier`, the SAME way
 * test/enforcement-webhook-route.test.ts does, to prove this route now
 * builds and forwards a real notifier (`source: 'ui'`) instead of leaving
 * `processPendingRequest` to fall back to `noopNotifier` — the bug this task
 * fixed (a manual decline used to notify the member of nothing).
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-requests-decide-route-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const headersStore: { current: Headers } = { current: new Headers() };
vi.mock('next/headers', () => ({
  headers: async () => headersStore.current,
}));

const processPendingRequestMock = vi.fn(async (seerrRequestId: number, _source: string, _deps?: unknown) => ({
  kind: 'decided' as const,
  seerrRequestId,
  decision: 'approve' as const,
  reason: 'under_quota' as const,
}));

const createEnforcementNotifierMock = vi.fn((opts: { source: string }) => ({
  __fakeNotifier: true,
  source: opts.source,
  notifyHeld: vi.fn(),
  notifyApproved: vi.fn(),
  notifyDeclined: vi.fn(),
}));

vi.mock('@/lib/enforcement', () => ({
  processPendingRequest: (...args: [number, string, unknown?]) => processPendingRequestMock(...args),
  createEnforcementNotifier: (opts: { source: string }) => createEnforcementNotifierMock(opts),
}));

const { getDb, _resetDbForTests } = await import('@/lib/db');
const { audit } = await import('@/lib/db/schema');
const { _resetConfigCacheForTests } = await import('@/lib/config');
const { NextRequest } = await import('next/server');
const { POST } = await import('@/app/api/admin/requests/decide/route');

const ORIGINAL_ENV = { ...process.env };
const OPERATOR = 'admin';

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  _resetDbForTests();
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(`${tmpDbPath}-wal`, { force: true });
  fs.rmSync(`${tmpDbPath}-shm`, { force: true });
  process.env.ADMIN_USERS = OPERATOR;
  _resetConfigCacheForTests();
  headersStore.current = new Headers();
  processPendingRequestMock.mockClear();
  createEnforcementNotifierMock.mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV, DB_PATH: tmpDbPath };
  _resetConfigCacheForTests();
});

function postDecide(body: unknown) {
  return new NextRequest('http://x/api/admin/requests/decide', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

describe('POST /api/admin/requests/decide — FR-ADM-1: member direct-POST', () => {
  it('403s for a member and writes access.denied, never calling processPendingRequest', async () => {
    headersStore.current = new Headers({ 'Remote-User': 'dana' });
    const res = await POST(postDecide({ seerrRequestId: 97 }));
    expect(res.status).toBe(403);
    expect(processPendingRequestMock).not.toHaveBeenCalled();
    const rows = getDb().select().from(audit).where(eq(audit.action, 'access.denied')).all();
    expect(rows.find((r) => r.actor === 'dana')).toBeDefined();
  });
});

describe('POST /api/admin/requests/decide — FR-ADM-8/FR-ENF-11: operator re-decide', () => {
  it('rejects a non-positive/non-integer seerrRequestId, never calling processPendingRequest', async () => {
    headersStore.current = new Headers({ 'Remote-User': OPERATOR });
    const res = await POST(postDecide({ seerrRequestId: -1 }));
    expect(res.status).toBe(400);
    expect(processPendingRequestMock).not.toHaveBeenCalled();
  });

  it('calls processPendingRequest(id, "manual") for a valid id and returns its outcome', async () => {
    headersStore.current = new Headers({ 'Remote-User': OPERATOR });
    const res = await POST(postDecide({ seerrRequestId: 97 }));
    expect(res.status).toBe(200);
    expect(processPendingRequestMock).toHaveBeenCalledTimes(1);
    expect(processPendingRequestMock).toHaveBeenCalledWith(97, 'manual', { notifier: expect.objectContaining({ __fakeNotifier: true }) });
    const json = await res.json();
    expect(json.outcome).toEqual({ kind: 'decided', seerrRequestId: 97, decision: 'approve', reason: 'under_quota' });
  });

  it('builds the real notifier with source: "ui" — a manual decline/approve now notifies the member, closing the gap where this route fell back to noopNotifier', async () => {
    headersStore.current = new Headers({ 'Remote-User': OPERATOR });
    await POST(postDecide({ seerrRequestId: 98 }));
    expect(createEnforcementNotifierMock).toHaveBeenCalledTimes(1);
    expect(createEnforcementNotifierMock).toHaveBeenCalledWith({ source: 'ui' });
  });
});
