import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// DB_PATH must be set BEFORE `@/lib/db` (imported indirectly via
// `@/lib/auth/authorize`) is first touched — an isolated, throwaway file
// rather than the default `/db/seerr-quota.db` (same pattern as
// test/db.test.ts and test/audit-write.test.ts).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-auth-authorize-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

// `next/headers`' `headers()` only works inside a real request's
// AsyncLocalStorage scope, which a plain vitest run doesn't have. Mock it
// with a controllable `Headers` instance so `getIdentity()`/`requireOperator()`
// can be exercised without booting a Next.js server (same technique
// a comparable project's equivalent test uses).
const headersStore: { current: Headers } = { current: new Headers() };
vi.mock('next/headers', () => ({
  headers: async () => headersStore.current,
}));

const { requireIdentity, requireOperator, toAuthErrorResponse, AuthError } = await import('@/lib/auth/authorize');
const { getDb } = await import('@/lib/db');
const { audit } = await import('@/lib/db/schema');
const { _resetConfigCacheForTests } = await import('@/lib/config');
const { NextResponse } = await import('next/server');
const { eq } = await import('drizzle-orm');

const ORIGINAL_ENV = { ...process.env };

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  headersStore.current = new Headers();
  process.env = { ...ORIGINAL_ENV, DB_PATH: tmpDbPath };
  _resetConfigCacheForTests();
});

describe('requireIdentity', () => {
  it('throws AuthError(401) when there is no identity at all (defensive; middleware normally already gates this)', async () => {
    await expect(requireIdentity()).rejects.toMatchObject({ status: 401 });
    await expect(requireIdentity()).rejects.toBeInstanceOf(AuthError);
  });

  it('returns the Identity when Remote-User is present', async () => {
    headersStore.current = new Headers({ 'Remote-User': 'dana' });
    const identity = await requireIdentity();
    expect(identity).toMatchObject({ username: 'dana', isOperator: false });
  });
});

describe('requireOperator (FR-SSO-5): returns the Identity or throws — never a boolean a caller can ignore', () => {
  it('returns the Identity for a real operator, without writing an audit row', async () => {
    headersStore.current = new Headers({ 'Remote-User': 'admin' });
    const db = getDb();
    const before = db.select().from(audit).all().length;

    const identity = await requireOperator({ route: '/admin/quota' });
    expect(identity).toMatchObject({ username: 'admin', isOperator: true });

    const after = db.select().from(audit).all().length;
    expect(after).toBe(before); // success writes nothing — only denials are audited here
  });

  it('throws AuthError(403) for an authenticated member hitting an operator-only route', async () => {
    headersStore.current = new Headers({ 'Remote-User': 'dana' });
    await expect(requireOperator({ route: '/admin/quota' })).rejects.toMatchObject({ status: 403 });
  });

  it('a 403 ALWAYS writes an access.denied audit row (FR-SSO-5 + FR-AUD-4), before the throw is observed', async () => {
    headersStore.current = new Headers({ 'Remote-User': 'dana' });
    const db = getDb();

    let caught: unknown;
    try {
      await requireOperator({ route: '/admin/quota/deep-link' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AuthError);

    const rows = db.select().from(audit).where(eq(audit.action, 'access.denied')).all();
    const match = rows.find((r) => r.targetId === '/admin/quota/deep-link');
    expect(match).toBeDefined();
    expect(match?.actor).toBe('dana');
    expect(match?.actorRole).toBe('member');
    expect(match?.outcome).toBe('denied');
    expect(match?.source).toBe('ui');
  });

  it('access.denied defaults target_type to "route" and target_id to the attempted route when no specific object was named', async () => {
    headersStore.current = new Headers({ 'Remote-User': 'dana' });
    const db = getDb();
    await expect(requireOperator({ route: '/admin/fleet' })).rejects.toBeInstanceOf(AuthError);
    const [row] = db.select().from(audit).where(eq(audit.targetId, '/admin/fleet')).all();
    expect(row.targetType).toBe('route');
  });

  it('access.denied uses the named domain object (target) instead of the bare route, when the attempt named one', async () => {
    headersStore.current = new Headers({ 'Remote-User': 'dana' });
    const db = getDb();
    await expect(
      requireOperator({ route: '/admin/members/frank', target: { type: 'member', id: 'frank' } }),
    ).rejects.toBeInstanceOf(AuthError);
    const [row] = db.select().from(audit).where(eq(audit.targetId, 'frank')).all();
    expect(row.targetType).toBe('member');
    expect(row.action).toBe('access.denied');
  });

  it('throws AuthError(401), not 403, when there is no identity at all (401 takes precedence over the role check)', async () => {
    await expect(requireOperator({ route: '/admin/quota' })).rejects.toMatchObject({ status: 401 });
  });
});

describe('toAuthErrorResponse', () => {
  it('converts a 401 AuthError to a 401 NextResponse', () => {
    const res = toAuthErrorResponse(new AuthError(401, 'nope'));
    expect(res instanceof NextResponse).toBe(true);
    expect(res.status).toBe(401);
  });

  it('converts a 403 AuthError to a 403 NextResponse', () => {
    const res = toAuthErrorResponse(new AuthError(403, 'nope'));
    expect(res.status).toBe(403);
  });

  it('rethrows anything that is not an AuthError rather than swallowing it', () => {
    expect(() => toAuthErrorResponse(new Error('boom'))).toThrow('boom');
  });
});
