import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `POST /api/deletion/execute` — the ONLY mutation endpoint the member-facing
 * three-step delete UI (P2-6) calls. This route is deliberately thin (auth +
 * minimal body-shape validation only, per its own header comment) — every
 * authorization/derivation rule it exercises is already covered exhaustively
 * against `executeDeletionBatch` directly in `test/deletion-execute.test.ts`
 * (owned by another task), so this file only proves the ROUTE's own
 * contract: identity resolution, request-shape validation, and that the
 * route hands a well-formed request straight through without adding or
 * dropping anything.
 *
 * Hard constraint (the project's design): "No test or smoke test may issue a
 * real DELETE to Radarr, Sonarr or Seerr." This route never injects fake
 * `deps` (production doesn't either — see the route's own header comment),
 * so every case here is deliberately chosen to terminate BEFORE
 * `executeDeletionBatch` would ever reach an actual upstream call: an
 * unauthenticated request, a malformed body, an id the actor has no claim
 * on, an unrecognised mode, a `protected` title, and a `release_claim` on a
 * shared title (release is 100% a DB write, per `FR-DEL-2`/`FR-DEL-11` —
 * "file deletion MUST NOT touch any file" is the release path's whole
 * point, so it can never reach a Radarr/Sonarr call). No case here selects
 * `delete_files` against a title that would actually be deletable.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-deletion-execute-route-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;
process.env.DELETE_RECENT_PLAY_DAYS = '14';
process.env.DELETE_MAX_PER_HOUR = '25';

const headersStore: { current: Headers } = { current: new Headers() };
vi.mock('next/headers', () => ({
  headers: async () => headersStore.current,
}));

const { getDb, _resetDbForTests } = await import('@/lib/db');
const { audit, claim, member, title } = await import('@/lib/db/schema');
const { _resetConfigCacheForTests } = await import('@/lib/config');
const { NextRequest } = await import('next/server');
const { POST } = await import('@/app/api/deletion/execute/route');

const ORIGINAL_ENV = { ...process.env };
const NOW = 1_800_000_000;

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  _resetDbForTests();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${tmpDbPath}${suffix}`, { force: true });
  process.env.DELETE_RECENT_PLAY_DAYS = '14';
  process.env.DELETE_MAX_PER_HOUR = '25';
  _resetConfigCacheForTests();
  headersStore.current = new Headers();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV, DB_PATH: tmpDbPath };
  _resetConfigCacheForTests();
});

function asMember(username: string): void {
  headersStore.current = new Headers({ 'Remote-User': username });
}

function postJson(body: unknown) {
  return new NextRequest('http://x/api/deletion/execute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

function seedMember(ssoUsername: string): void {
  getDb().insert(member).values({ ssoUsername, entitled: true, isOperator: false, syncStatus: 'matched', firstSeenAt: NOW - 1000, lastSyncedAt: NOW - 10 }).run();
}

function seedTitle(id: string, opts: Partial<{ sizeBytes: number; protectedTitle: boolean; protectedReason: string | null }> = {}): void {
  getDb()
    .insert(title)
    .values({
      id,
      mediaType: 'movie',
      arrInstance: 'radarr',
      arrId: 1,
      title: `Title ${id}`,
      year: 2020,
      sizeBytes: opts.sizeBytes ?? 1000,
      path: `/data/media/movies/${id}`,
      protected: opts.protectedTitle ?? false,
      protectedReason: opts.protectedReason ?? null,
      watchedByAnyone: false,
      lastPlayedAnyAt: null,
      lastSyncedAt: NOW - 30,
    })
    .run();
}

function seedClaim(titleId: string, ssoUsername: string, chargedBytes = 1000): void {
  getDb().insert(claim).values({ titleId, ssoUsername, seerrRequestId: null, chargedBytes, active: true, createdAt: NOW - 500 }).run();
}

describe('POST /api/deletion/execute — identity + request-shape guard', () => {
  it('401s with no identity, and never reaches executeDeletionBatch (no audit row written)', async () => {
    const res = await POST(postJson({ items: [{ titleId: 'movie:1', requestedMode: 'delete_files' }] }));
    expect(res.status).toBe(401);
    expect(getDb().select().from(audit).all()).toHaveLength(0);
  });

  it('400s on invalid JSON body', async () => {
    asMember('frank');
    const req = new NextRequest('http://x/api/deletion/execute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('400s when items is missing', async () => {
    asMember('frank');
    const res = await POST(postJson({}));
    expect(res.status).toBe(400);
  });

  it('400s when items is an empty array', async () => {
    asMember('frank');
    const res = await POST(postJson({ items: [] }));
    expect(res.status).toBe(400);
  });

  it('400s when an item has no titleId', async () => {
    asMember('frank');
    const res = await POST(postJson({ items: [{ requestedMode: 'delete_files' }] }));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/deletion/execute — passes a well-formed request straight through, per-title outcomes (FR-DEL-8)', () => {
  it('an id the caller has no claim on comes back unauthorized — no upstream call, one access.denied row', async () => {
    seedMember('frank');
    asMember('frank');

    const res = await POST(postJson({ items: [{ titleId: 'movie:not-mine', requestedMode: 'delete_files' }] }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.items).toEqual([expect.objectContaining({ titleId: 'movie:not-mine', outcome: 'unauthorized' })]);
    expect(json.summary).toMatchObject({ total: 1, unauthorized: 1 });

    const rows = getDb().select().from(audit).where(eq(audit.targetId, 'movie:not-mine')).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('access.denied');
  });

  it('an unrecognised requestedMode is refused (FR-DEL-15) — never falls through to a delete', async () => {
    seedMember('frank');
    seedTitle('movie:1', { sizeBytes: 5000 });
    seedClaim('movie:1', 'frank', 5000);
    asMember('frank');

    const res = await POST(postJson({ items: [{ titleId: 'movie:1', requestedMode: 'release' }] })); // typo, not 'release_claim'
    const json = await res.json();
    expect(json.items[0]).toMatchObject({ titleId: 'movie:1', outcome: 'invalid_mode' });

    // The file was NOT deleted: the claim is still active and fully charged.
    const claimRow = getDb().select().from(claim).where(eq(claim.titleId, 'movie:1')).all()[0];
    expect(claimRow.active).toBe(true);
    expect(claimRow.chargedBytes).toBe(5000);
  });

  it('a protected title is blocked for a member, with the reason surfaced — no upstream call', async () => {
    seedMember('frank');
    seedTitle('movie:1', { sizeBytes: 5000, protectedTitle: true, protectedReason: 'operator pin: family favourite' });
    seedClaim('movie:1', 'frank', 5000);
    asMember('frank');

    const res = await POST(postJson({ items: [{ titleId: 'movie:1', requestedMode: 'delete_files' }] }));
    const json = await res.json();
    expect(json.items[0]).toMatchObject({ titleId: 'movie:1', outcome: 'blocked', blockedReason: 'protected' });
  });

  it('release_claim on a shared title actually releases (DB-only, no file touched) and reports it per-title', async () => {
    seedMember('frank');
    seedMember('dana');
    seedTitle('movie:1', { sizeBytes: 5000 });
    seedClaim('movie:1', 'frank', 5000);
    seedClaim('movie:1', 'dana', 5000);
    asMember('frank');

    const res = await POST(postJson({ items: [{ titleId: 'movie:1', requestedMode: 'release_claim' }] }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.items[0]).toMatchObject({ titleId: 'movie:1', outcome: 'released' });
    expect(json.summary).toMatchObject({ total: 1, released: 1 });

    const frankClaim = getDb().select().from(claim).where(eq(claim.titleId, 'movie:1')).all().find((c) => c.ssoUsername === 'frank');
    const danaClaim = getDb().select().from(claim).where(eq(claim.titleId, 'movie:1')).all().find((c) => c.ssoUsername === 'dana');
    expect(frankClaim?.active).toBe(false);
    expect(danaClaim?.active).toBe(true);
    expect(danaClaim?.chargedBytes).toBe(5000); // never re-split (D-3) — dana's own charge is untouched.
  });

  it('a sole claimant asking to release is blocked, not silently upgraded to delete or allowed to zero their usage for free', async () => {
    seedMember('frank');
    seedTitle('movie:1', { sizeBytes: 5000 });
    seedClaim('movie:1', 'frank', 5000);
    asMember('frank');

    const res = await POST(postJson({ items: [{ titleId: 'movie:1', requestedMode: 'release_claim' }] }));
    const json = await res.json();
    expect(json.items[0]).toMatchObject({ titleId: 'movie:1', outcome: 'blocked', blockedReason: 'sole_claimant_cannot_release' });

    const claimRow = getDb().select().from(claim).where(eq(claim.titleId, 'movie:1')).all()[0];
    expect(claimRow.active).toBe(true); // still owned — nothing silently zeroed.
  });

  it('a batch mixing an unauthorized id and a valid release reports BOTH independently (FR-DEL-8) — one bad item never drops another', async () => {
    seedMember('frank');
    seedMember('dana');
    seedTitle('movie:1', { sizeBytes: 5000 });
    seedClaim('movie:1', 'frank', 5000);
    seedClaim('movie:1', 'dana', 5000);
    asMember('frank');

    const res = await POST(
      postJson({
        items: [
          { titleId: 'movie:does-not-exist', requestedMode: 'delete_files' },
          { titleId: 'movie:1', requestedMode: 'release_claim' },
        ],
      }),
    );
    const json = await res.json();
    expect(json.summary).toMatchObject({ total: 2, unauthorized: 1, released: 1 });
    expect(json.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ titleId: 'movie:does-not-exist', outcome: 'unauthorized' }),
        expect.objectContaining({ titleId: 'movie:1', outcome: 'released' }),
      ]),
    );
  });
});
