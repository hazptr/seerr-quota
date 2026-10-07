import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `POST /api/admin/reconcile` — `FR-ADM-10`'s trigger half. Mocks all five
 * reconciler entry points `@/app/admin/_actions/reconcileActions.ts` calls,
 * so this suite proves the route's own wiring (auth, step order, error
 * isolation) without ever touching a real upstream — no test here may write
 * to live Seerr, and this route's `pending_sweep` step is exactly the one
 * that could (see that action module's header comment).
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-reconcile-route-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const headersStore: { current: Headers } = { current: new Headers() };
vi.mock('next/headers', () => ({
  headers: async () => headersStore.current,
}));

const syncMembersMock = vi.fn(async () => ({ ok: true }));
const runLibraryAndRequestSyncMock = vi.fn(async () => ({ ok: true }));
const runPlaybackSyncMock = vi.fn(async () => ({ ok: true }));
const runAttributionSyncMock = vi.fn(async () => ({ ok: true }));
const runPendingSweepMock = vi.fn(async () => ({ ok: true }));

vi.mock('@/lib/members/sync', () => ({ syncMembers: () => syncMembersMock() }));
vi.mock('@/lib/library/sync', () => ({ runLibraryAndRequestSync: () => runLibraryAndRequestSyncMock() }));
vi.mock('@/lib/playback/sync', () => ({ runPlaybackSync: () => runPlaybackSyncMock() }));
vi.mock('@/lib/attribution/sync', () => ({ runAttributionSync: () => runAttributionSyncMock() }));
vi.mock('@/lib/enforcement/poller', () => ({ runPendingSweep: () => runPendingSweepMock() }));

const { getDb, _resetDbForTests } = await import('@/lib/db');
const { audit } = await import('@/lib/db/schema');
const { _resetConfigCacheForTests } = await import('@/lib/config');
const { NextRequest } = await import('next/server');
const { POST } = await import('@/app/api/admin/reconcile/route');

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
  for (const m of [syncMembersMock, runLibraryAndRequestSyncMock, runPlaybackSyncMock, runAttributionSyncMock, runPendingSweepMock]) m.mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV, DB_PATH: tmpDbPath };
  _resetConfigCacheForTests();
});

function postReconcile() {
  return new NextRequest('http://x/api/admin/reconcile', { method: 'POST' });
}

describe('POST /api/admin/reconcile — FR-ADM-1: member direct-POST', () => {
  it('403s for a member and never calls any reconciler step', async () => {
    headersStore.current = new Headers({ 'Remote-User': 'dana' });
    const res = await POST(postReconcile());
    expect(res.status).toBe(403);
    expect(syncMembersMock).not.toHaveBeenCalled();
    expect(runPendingSweepMock).not.toHaveBeenCalled();
    const rows = getDb().select().from(audit).where(eq(audit.action, 'access.denied')).all();
    expect(rows.find((r) => r.actor === 'dana')).toBeDefined();
  });
});

describe('POST /api/admin/reconcile — FR-ADM-10', () => {
  it('operator: runs all five pipelines in dependency order and reports ok', async () => {
    headersStore.current = new Headers({ 'Remote-User': OPERATOR });
    const res = await POST(postReconcile());
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.steps.map((s: { step: string }) => s.step)).toEqual(['members', 'library_requests', 'playback', 'attribution', 'pending_sweep']);

    expect(syncMembersMock).toHaveBeenCalledTimes(1);
    expect(runLibraryAndRequestSyncMock).toHaveBeenCalledTimes(1);
    expect(runPlaybackSyncMock).toHaveBeenCalledTimes(1);
    expect(runAttributionSyncMock).toHaveBeenCalledTimes(1);
    expect(runPendingSweepMock).toHaveBeenCalledTimes(1);
  });

  it('one step throwing does not prevent the rest from running, and is reported as a per-step error', async () => {
    runPlaybackSyncMock.mockRejectedValueOnce(new Error('boom'));
    headersStore.current = new Headers({ 'Remote-User': OPERATOR });

    const res = await POST(postReconcile());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(false);
    const playbackStep = json.steps.find((s: { step: string }) => s.step === 'playback');
    expect(playbackStep.ok).toBe(false);
    expect(playbackStep.error).toBe('boom');
    // Attribution and pending_sweep still ran despite playback's failure.
    expect(runAttributionSyncMock).toHaveBeenCalledTimes(1);
    expect(runPendingSweepMock).toHaveBeenCalledTimes(1);
  });
});
