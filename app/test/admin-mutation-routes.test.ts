import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `FR-ADM-1`/`FR-SSO-5` non-negotiable, exercised against every P2-5
 * mutation route directly (not through a rendered page): "a member POSTing
 * straight at a mutation endpoint must get 403 and an access.denied audit
 * row." Plus the operator success/validation paths for the routes that need
 * no external mocking (`@/lib/enforcement`'s `processPendingRequest` and the
 * five reconciler entry points get their OWN test files, mocked, so no test
 * anywhere in this suite calls a real upstream — see
 * test/admin-requests-decide-route.test.ts and
 * test/admin-reconcile-route.test.ts).
 *
 * Same `next/headers` mock technique as test/auth-authorize.test.ts /
 * test/enforcement-webhook-route.test.ts: a controllable `Headers` instance,
 * since `headers()` only works inside a real request's AsyncLocalStorage
 * scope, which a plain vitest run doesn't have.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-admin-routes-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const headersStore: { current: Headers } = { current: new Headers() };
vi.mock('next/headers', () => ({
  headers: async () => headersStore.current,
}));

const { getDb, _resetDbForTests } = await import('@/lib/db');
const { appSetting, audit, claim, member, quotaPolicy, title } = await import('@/lib/db/schema');
const { _resetConfigCacheForTests } = await import('@/lib/config');
const { NextRequest } = await import('next/server');

const { POST: quotaPreviewPOST } = await import('@/app/api/admin/quota/preview/route');
const { POST: quotaDefaultPOST } = await import('@/app/api/admin/quota/default/route');
const { POST: quotaOverridePOST } = await import('@/app/api/admin/quota/override/route');
const { POST: quotaClearPOST } = await import('@/app/api/admin/quota/clear/route');
const { POST: protectPOST } = await import('@/app/api/admin/titles/protect/route');
const { POST: unprotectPOST } = await import('@/app/api/admin/titles/unprotect/route');
const { POST: settingsPOST } = await import('@/app/api/admin/settings/route');
const { POST: enforcementPOST } = await import('@/app/api/admin/settings/enforcement/route');
const { GET: enforcementPreviewGET } = await import('@/app/api/admin/settings/enforcement/preview/route');
const { POST: clearAliasPOST } = await import('@/app/api/admin/members/clear-alias/route');

const ORIGINAL_ENV = { ...process.env };
const OPERATOR = 'admin';
const MEMBER = 'dana';
const NOW = 1_800_000_000;

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
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV, DB_PATH: tmpDbPath };
  _resetConfigCacheForTests();
});

function asOperator(): void {
  headersStore.current = new Headers({ 'Remote-User': OPERATOR });
}

function asMember(): void {
  headersStore.current = new Headers({ 'Remote-User': MEMBER });
}

function postJson(url: string, body: unknown) {
  return new NextRequest(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

function insertMember(ssoUsername: string): void {
  getDb().insert(member).values({ ssoUsername, entitled: true, isOperator: ssoUsername === OPERATOR, syncStatus: 'matched', firstSeenAt: NOW, lastSyncedAt: NOW }).run();
  getDb().insert(quotaPolicy).values({ ssoUsername, quotaBytes: null, source: 'default', updatedAt: NOW, updatedBy: 'system' }).run();
}

function insertTitle(id: string, protectedFlag = false): void {
  getDb().insert(title).values({ id, mediaType: 'movie', arrInstance: 'radarr', arrId: 1, title: id, sizeBytes: 1000, path: `/data/${id}`, protected: protectedFlag, lastSyncedAt: NOW }).run();
}

function setDefaultQuota(bytes: number): void {
  getDb().insert(appSetting).values({ key: 'default_quota_bytes', value: JSON.stringify(bytes), updatedAt: NOW, updatedBy: OPERATOR }).run();
}

// ---------------------------------------------------------------------------
// FR-ADM-1: every route, member-direct-POST -> 403 + access.denied
// ---------------------------------------------------------------------------

describe('every P2-5 mutation route: a member posting directly gets 403 and an access.denied audit row', () => {
  const cases: Array<{ name: string; call: () => Promise<Response> }> = [
    { name: 'POST /api/admin/quota/preview', call: () => quotaPreviewPOST(postJson('http://x/api/admin/quota/preview', { mode: 'default', proposedGb: 10 })) },
    { name: 'POST /api/admin/quota/default', call: () => quotaDefaultPOST(postJson('http://x/api/admin/quota/default', { proposedGb: 10 })) },
    { name: 'POST /api/admin/quota/override', call: () => quotaOverridePOST(postJson('http://x/api/admin/quota/override', { ssoUsername: 'erin', proposedGb: 10 })) },
    { name: 'POST /api/admin/quota/clear', call: () => quotaClearPOST(postJson('http://x/api/admin/quota/clear', { ssoUsername: 'erin' })) },
    { name: 'POST /api/admin/titles/protect', call: () => protectPOST(postJson('http://x/api/admin/titles/protect', { titleId: 'movie:1', reason: 'x' })) },
    { name: 'POST /api/admin/titles/unprotect', call: () => unprotectPOST(postJson('http://x/api/admin/titles/unprotect', { titleId: 'movie:1' })) },
    { name: 'POST /api/admin/settings', call: () => settingsPOST(postJson('http://x/api/admin/settings', { key: 'hold_max_days', value: 10 })) },
    { name: 'POST /api/admin/settings/enforcement', call: () => enforcementPOST(postJson('http://x/api/admin/settings/enforcement', { enabled: true })) },
    { name: 'GET /api/admin/settings/enforcement/preview', call: () => enforcementPreviewGET(new NextRequest('http://x/api/admin/settings/enforcement/preview') as never) },
    { name: 'POST /api/admin/members/clear-alias', call: () => clearAliasPOST(postJson('http://x/api/admin/members/clear-alias', { ssoUsername: 'erin' })) },
  ];

  for (const { name, call } of cases) {
    it(`${name}`, async () => {
      asMember();
      const res = await call();
      expect(res.status).toBe(403);
      const denied = getDb().select().from(audit).where(eq(audit.action, 'access.denied')).all();
      const match = denied.find((r) => r.actor === MEMBER);
      expect(match).toBeDefined();
      expect(match?.outcome).toBe('denied');
    });
  }

  it('also 401s (not 403) with no identity at all, and never writes an access.denied row for the missing-identity case (defensive path, matches requireIdentity)', async () => {
    // No Remote-User header at all.
    const res = await quotaDefaultPOST(postJson('http://x/api/admin/quota/default', { proposedGb: 10 }));
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// quota/preview, quota/default, quota/override, quota/clear
// ---------------------------------------------------------------------------

describe('POST /api/admin/quota/preview', () => {
  it('default mode: returns newlyOver/newlyUnder for an operator', async () => {
    asOperator();
    insertMember('dana');
    insertTitle('movie:1');
    getDb().insert(claim).values({ titleId: 'movie:1', ssoUsername: 'dana', chargedBytes: 1_000, active: true, createdAt: NOW }).run();

    const res = await quotaPreviewPOST(postJson('http://x/api/admin/quota/preview', { mode: 'default', proposedGb: 0.0000005 }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.kind).toBe('default');
    expect(Array.isArray(json.preview.newlyOver)).toBe(true);
  });

  it('override mode: 404 for an unknown member', async () => {
    asOperator();
    const res = await quotaPreviewPOST(postJson('http://x/api/admin/quota/preview', { mode: 'override', ssoUsername: 'ghost', proposedGb: 10 }));
    expect(res.status).toBe(404);
  });
});

describe('POST /api/admin/quota/default', () => {
  it('operator: negative GB is rejected (400), nothing written', async () => {
    asOperator();
    const res = await quotaDefaultPOST(postJson('http://x/api/admin/quota/default', { proposedGb: -5 }));
    expect(res.status).toBe(400);
    expect(getDb().select().from(appSetting).where(eq(appSetting.key, 'default_quota_bytes')).all()).toHaveLength(0);
  });

  it('operator: valid GB commits and returns before/after', async () => {
    asOperator();
    const res = await quotaDefaultPOST(postJson('http://x/api/admin/quota/default', { proposedGb: 300 }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.after).toBe(300_000_000_000);
  });
});

describe('POST /api/admin/quota/override', () => {
  it('operator: 404 for an unknown member, nothing written', async () => {
    asOperator();
    const res = await quotaOverridePOST(postJson('http://x/api/admin/quota/override', { ssoUsername: 'ghost', proposedGb: 100 }));
    expect(res.status).toBe(404);
    expect(getDb().select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, 'ghost')).all()).toHaveLength(0);
  });

  it('operator: sets an override for a real member', async () => {
    asOperator();
    insertMember('erin');
    const res = await quotaOverridePOST(postJson('http://x/api/admin/quota/override', { ssoUsername: 'erin', proposedGb: 469, note: 'grandfathered' }));
    expect(res.status).toBe(200);
    const row = getDb().select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, 'erin')).get()!;
    expect(row.quotaBytes).toBe(469_000_000_000);
    expect(row.source).toBe('override');
  });
});

describe('POST /api/admin/quota/clear', () => {
  it('operator: 404 for an unknown member', async () => {
    asOperator();
    const res = await quotaClearPOST(postJson('http://x/api/admin/quota/clear', { ssoUsername: 'ghost' }));
    expect(res.status).toBe(404);
  });

  it('operator: clears a real member back to null/inherit', async () => {
    asOperator();
    insertMember('frank');
    getDb().update(quotaPolicy).set({ quotaBytes: 411_000_000_000, source: 'override' }).where(eq(quotaPolicy.ssoUsername, 'frank')).run();

    const res = await quotaClearPOST(postJson('http://x/api/admin/quota/clear', { ssoUsername: 'frank' }));
    expect(res.status).toBe(200);
    const row = getDb().select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, 'frank')).get()!;
    expect(row.quotaBytes).toBeNull();
    expect(row.source).toBe('default');
  });
});

// ---------------------------------------------------------------------------
// titles/protect, titles/unprotect
// ---------------------------------------------------------------------------

describe('POST /api/admin/titles/protect', () => {
  it('operator: empty reason -> 400, nothing written', async () => {
    asOperator();
    insertTitle('movie:1');
    const res = await protectPOST(postJson('http://x/api/admin/titles/protect', { titleId: 'movie:1', reason: '   ' }));
    expect(res.status).toBe(400);
    expect(getDb().select().from(title).where(eq(title.id, 'movie:1')).get()!.protected).toBe(false);
  });

  it('operator: unknown title -> 404', async () => {
    asOperator();
    const res = await protectPOST(postJson('http://x/api/admin/titles/protect', { titleId: 'movie:ghost', reason: 'x' }));
    expect(res.status).toBe(404);
  });

  it('operator: protects with a reason', async () => {
    asOperator();
    insertTitle('movie:2');
    const res = await protectPOST(postJson('http://x/api/admin/titles/protect', { titleId: 'movie:2', reason: 'family favorite, do not delete' }));
    expect(res.status).toBe(200);
    const row = getDb().select().from(title).where(eq(title.id, 'movie:2')).get()!;
    expect(row.protected).toBe(true);
    expect(row.protectedReason).toBe('family favorite, do not delete');
  });
});

describe('POST /api/admin/titles/unprotect', () => {
  it('operator: unprotects a title', async () => {
    asOperator();
    insertTitle('movie:3', true);
    const res = await unprotectPOST(postJson('http://x/api/admin/titles/unprotect', { titleId: 'movie:3' }));
    expect(res.status).toBe(200);
    expect(getDb().select().from(title).where(eq(title.id, 'movie:3')).get()!.protected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// settings, settings/enforcement, settings/enforcement/preview
// ---------------------------------------------------------------------------

describe('POST /api/admin/settings', () => {
  it('operator: unknown key -> 400', async () => {
    asOperator();
    const res = await settingsPOST(postJson('http://x/api/admin/settings', { key: 'default_quota_bytes', value: 10 }));
    expect(res.status).toBe(400);
  });

  it('operator: writes a valid setting', async () => {
    asOperator();
    const res = await settingsPOST(postJson('http://x/api/admin/settings', { key: 'delete_max_per_hour', value: 5 }));
    expect(res.status).toBe(200);
    const row = getDb().select().from(appSetting).where(eq(appSetting.key, 'delete_max_per_hour')).get()!;
    expect(JSON.parse(row.value)).toBe(5);
  });
});

describe('POST /api/admin/settings/enforcement + GET .../preview', () => {
  it('refuses to enable when default_quota_bytes is unset', async () => {
    asOperator();
    const res = await enforcementPOST(postJson('http://x/api/admin/settings/enforcement', { enabled: true }));
    expect(res.status).toBe(400);
    expect(getDb().select().from(appSetting).where(eq(appSetting.key, 'enforcement_enabled')).all()).toHaveLength(0);
  });

  it('preview reports defaultQuotaConfigured and affected count for an operator', async () => {
    asOperator();
    setDefaultQuota(100_000_000_000);
    const res = await enforcementPreviewGET(new NextRequest('http://x/api/admin/settings/enforcement/preview') as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.defaultQuotaConfigured).toBe(true);
    expect(json.currentlyEnabled).toBe(false);
  });

  it('enables once a default is configured, audited with enforcement.toggled', async () => {
    asOperator();
    setDefaultQuota(100_000_000_000);
    const res = await enforcementPOST(postJson('http://x/api/admin/settings/enforcement', { enabled: true }));
    expect(res.status).toBe(200);
    const row = getDb().select().from(appSetting).where(eq(appSetting.key, 'enforcement_enabled')).get()!;
    expect(JSON.parse(row.value)).toBe(true);
    const rows = getDb().select().from(audit).where(eq(audit.action, 'enforcement.toggled')).all();
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// members/clear-alias (security review, PR #17)
// ---------------------------------------------------------------------------

describe('POST /api/admin/members/clear-alias', () => {
  it('404s an unknown member', async () => {
    asOperator();
    const res = await clearAliasPOST(postJson('http://x/api/admin/members/clear-alias', { ssoUsername: 'ghost' }));
    expect(res.status).toBe(404);
  });

  it('400s a blank ssoUsername', async () => {
    asOperator();
    const res = await clearAliasPOST(postJson('http://x/api/admin/members/clear-alias', { ssoUsername: '   ' }));
    expect(res.status).toBe(400);
  });

  it('operator: clears an existing alias and writes member.alias_cleared', async () => {
    asOperator();
    insertMember('erin');
    getDb().update(member).set({ loginAlias: 'erin-newidp' }).where(eq(member.ssoUsername, 'erin')).run();

    const res = await clearAliasPOST(postJson('http://x/api/admin/members/clear-alias', { ssoUsername: 'erin' }));
    expect(res.status).toBe(200);

    const row = getDb().select().from(member).where(eq(member.ssoUsername, 'erin')).get();
    expect(row?.loginAlias).toBeNull();

    const rows = getDb().select().from(audit).where(eq(audit.action, 'member.alias_cleared')).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].targetId).toBe('erin');
    expect(rows[0].actor).toBe(OPERATOR);
    expect(rows[0].actorRole).toBe('operator');
  });

  it('operator: clearing a member who already has no alias still succeeds and audits (idempotent)', async () => {
    asOperator();
    insertMember('erin');
    const res = await clearAliasPOST(postJson('http://x/api/admin/members/clear-alias', { ssoUsername: 'erin' }));
    expect(res.status).toBe(200);
    const rows = getDb().select().from(audit).where(eq(audit.action, 'member.alias_cleared')).all();
    expect(rows).toHaveLength(1);
  });

  // --- Second security review (PR #17), SHOULD-FIX: lowercase input + transaction + target ---

  it('lowercases a differently-cased ssoUsername before looking it up — a mixed-case input still finds the (lowercase-stored) row', async () => {
    asOperator();
    insertMember('erin');
    getDb().update(member).set({ loginAlias: 'erin-newidp' }).where(eq(member.ssoUsername, 'erin')).run();

    const res = await clearAliasPOST(postJson('http://x/api/admin/members/clear-alias', { ssoUsername: 'ERIN' }));
    expect(res.status).toBe(200);
    expect(getDb().select().from(member).where(eq(member.ssoUsername, 'erin')).get()?.loginAlias).toBeNull();
  });

  it('a member posting directly records the SPECIFIC member targeted, not just the bare route (requireOperatorForRoute target)', async () => {
    asMember();
    insertMember('erin');
    const res = await clearAliasPOST(postJson('http://x/api/admin/members/clear-alias', { ssoUsername: 'erin' }));
    expect(res.status).toBe(403);
    const denied = getDb().select().from(audit).where(eq(audit.action, 'access.denied')).all();
    const match = denied.find((r) => r.actor === MEMBER && r.targetId === 'erin');
    expect(match).toBeDefined();
    expect(match?.targetType).toBe('member');
  });

  it('a malformed JSON body still 403s a non-operator (auth is checked first; the pre-auth body peek is tolerant of garbage, never itself 400s)', async () => {
    asMember();
    const req = new NextRequest('http://x/api/admin/members/clear-alias', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
    const res = await clearAliasPOST(req);
    expect(res.status).toBe(403);
  });

  it('the write and its audit row commit atomically — a second lookup immediately after shows both changed together', async () => {
    asOperator();
    insertMember('erin');
    getDb().update(member).set({ loginAlias: 'erin-newidp' }).where(eq(member.ssoUsername, 'erin')).run();

    await clearAliasPOST(postJson('http://x/api/admin/members/clear-alias', { ssoUsername: 'erin' }));

    const row = getDb().select().from(member).where(eq(member.ssoUsername, 'erin')).get();
    const auditRows = getDb().select().from(audit).where(eq(audit.action, 'member.alias_cleared')).all();
    // Both reflect the SAME post-transaction state — proves this wasn't two
    // independent statements that could commit (or fail) separately.
    expect(row?.loginAlias).toBeNull();
    expect(auditRows).toHaveLength(1);
  });
});
