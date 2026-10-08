import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeerrUsersClient, SeerrUserForMatch } from '@/lib/members/seerrUsers';

/**
 * Second security review (PR #17), item A — the exact scenario a fresh
 * install hits: `ADMIN_USERS=<operator's Seerr username>`, and that Seerr
 * account is the FIRST (and possibly only) account the very first sync
 * cycle ever sees. Before the fix, `classifyMembers` treated a derived key
 * colliding with `ADMIN_USERS` as unsafe UNCONDITIONALLY, so no `member`
 * row was ever created for the operator — `/` and `/delete` would show
 * "not linked yet" forever, `requireEntitledMember` 403s every self-service
 * route, and the operator's own requests attribute to nobody. This test
 * exercises the full chain end to end: sync -> member row -> `getMemberGate`
 * (the exact gate `src/app/page.tsx`/`src/app/delete/page.tsx` apply) ->
 * `requireEntitledMember` (the exact gate `/api/deletion/execute` applies).
 *
 * Same `next/headers` mock technique as `test/admin-mutation-routes.test.ts`.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-fresh-install-smoke-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const headersStore: { current: Headers } = { current: new Headers() };
vi.mock('next/headers', () => ({
  headers: async () => headersStore.current,
}));

const { getDb, _resetDbForTests } = await import('@/lib/db');
const { member } = await import('@/lib/db/schema');
const { _resetConfigCacheForTests } = await import('@/lib/config');
const { syncMembers } = await import('@/lib/members/sync');
const { getIdentity } = await import('@/lib/auth/session');
const { getMemberGate } = await import('@/lib/auth/memberGate');
const { requireEntitledMember, AuthError } = await import('@/lib/auth/authorize');
const { NextRequest } = await import('next/server');
const { POST: deletionExecutePOST } = await import('@/app/api/deletion/execute/route');

const ORIGINAL_ENV = { ...process.env };

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  _resetDbForTests();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${tmpDbPath}${suffix}`, { force: true });
  headersStore.current = new Headers();
  process.env.ADMIN_USERS = 'caleb';
  _resetConfigCacheForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV, DB_PATH: tmpDbPath };
  _resetConfigCacheForTests();
});

function seerrUsersReturning(users: SeerrUserForMatch[]): SeerrUsersClient {
  return { listAllUsers: async () => users } as unknown as SeerrUsersClient;
}

function fakeSeerrUser(id: number, username: string): SeerrUserForMatch {
  return { id, email: `${username}@example.com`, username, displayName: username, jellyfinUsername: null, jellyfinUserId: null };
}

describe('fresh install: empty DB, operator Seerr username === ADMIN_USERS', () => {
  it('a single-user fresh install (operator only) syncs, gets a matched+operator row, passes the "/" gate, and passes the deletion-route gate', async () => {
    const result = await syncMembers({ seerrUsers: seerrUsersReturning([fakeSeerrUser(1, 'caleb')]) }, 1_000_000);
    expect(result.classify.ok).toBe(true);

    const row = getDb().select().from(member).where(eq(member.ssoUsername, 'caleb')).get();
    expect(row).toBeDefined();
    expect(row?.syncStatus).toBe('matched');
    expect(row?.isOperator).toBe(true);

    // The "/" and "/delete" gate: getIdentity() + getMemberGate(), exactly
    // as src/app/page.tsx and src/app/delete/page.tsx call them.
    headersStore.current = new Headers({ 'Remote-User': 'caleb' });
    const identity = await getIdentity();
    expect(identity).not.toBeNull();
    const gate = await getMemberGate(identity!);
    expect(gate).toEqual({ status: 'ok' });

    // The deletion-route gate: requireEntitledMember, exactly as
    // /api/deletion/execute (and its /schedule alias) apply it. Must NOT
    // throw — a thrown AuthError here is exactly the 403 lockout this test
    // guards against.
    await expect(requireEntitledMember({ route: '/api/deletion/execute' })).resolves.toMatchObject({ username: 'caleb', isOperator: true });

    // And the real route handler: an empty `items` array reaches body
    // validation (400), not the auth gate (403) — proving the operator is
    // not blocked before their request is even inspected.
    const req = new NextRequest('http://x/api/deletion/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [] }),
    });
    const res = await deletionExecutePOST(req);
    expect(res.status).toBe(400);
  });

  it('a multi-user fresh install (operator + others) gives everyone a working row, operator included', async () => {
    const result = await syncMembers(
      { seerrUsers: seerrUsersReturning([fakeSeerrUser(1, 'caleb'), fakeSeerrUser(2, 'cait')]) },
      1_000_000,
    );
    expect(result.classify.ok).toBe(true);

    const rows = getDb().select().from(member).all();
    expect(rows).toHaveLength(2);
    const caleb = rows.find((r) => r.ssoUsername === 'caleb');
    const cait = rows.find((r) => r.ssoUsername === 'cait');
    expect(caleb).toMatchObject({ syncStatus: 'matched', isOperator: true });
    expect(cait).toMatchObject({ syncStatus: 'matched', isOperator: false });

    headersStore.current = new Headers({ 'Remote-User': 'cait' });
    const identity = await getIdentity();
    const gate = await getMemberGate(identity!);
    expect(gate).toEqual({ status: 'ok' });
  });

  it('BEFORE the fix this would have failed: documents the regression directly against requireEntitledMember throwing', async () => {
    await syncMembers({ seerrUsers: seerrUsersReturning([fakeSeerrUser(1, 'caleb')]) }, 1_000_000);
    headersStore.current = new Headers({ 'Remote-User': 'caleb' });
    let thrown: unknown;
    try {
      await requireEntitledMember({ route: '/api/deletion/execute' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeUndefined();
    expect(thrown instanceof AuthError).toBe(false);
  });
});
