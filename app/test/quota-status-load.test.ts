import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `loadQuotaStatus` (`@/lib/quotaStatus/load.ts`) — the impure shell behind
 * `GET /api/quota-status` (P2-10). Covers exactly what the pure
 * `test/quota-status-derive.test.ts` suite can't: that the three DB reads
 * (`claim`, `quota_policy`, `request_decision`) are correctly scoped to ONE
 * member and never leak another's figures (`FR-BAN-3`), that a released
 * claim and a resolved (non-hold) decision are excluded, and that the
 * "no attribution snapshot yet" scoping choice documented in `load.ts`'s
 * header comment behaves as described (usage reads as a real `0`, not an
 * error).
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-status-load-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const { getDb } = await import('@/lib/db');
const { appSetting, claim, member, quotaPolicy, requestDecision, title } = await import('@/lib/db/schema');
const { loadQuotaStatus } = await import('@/lib/quotaStatus/load');
const { _resetConfigCacheForTests } = await import('@/lib/config');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function insertMember(ssoUsername: string, nowSeconds: number): void {
  getDb()
    .insert(member)
    .values({ ssoUsername, entitled: true, isOperator: false, syncStatus: 'matched', firstSeenAt: nowSeconds, lastSyncedAt: nowSeconds })
    .run();
}

let nextArrId = 1;

function insertTitle(id: string, sizeBytes: number, nowSeconds: number): void {
  getDb()
    .insert(title)
    .values({
      id,
      mediaType: 'movie',
      arrInstance: 'radarr',
      arrId: nextArrId++,
      title: id,
      year: 2020,
      sizeBytes,
      path: `/data/media/movies/${id}`,
      addedAt: nowSeconds,
      lastSyncedAt: nowSeconds,
    })
    .run();
}

function insertClaim(titleId: string, ssoUsername: string, chargedBytes: number, nowSeconds: number, active = true): void {
  getDb().insert(claim).values({ titleId, ssoUsername, chargedBytes, active, createdAt: nowSeconds }).run();
}

let nextRequestId = 1;

function insertRequestDecision(
  ssoUsername: string,
  decision: 'approve' | 'hold' | 'decline' | 'skip',
  nowSeconds: number,
): void {
  getDb()
    .insert(requestDecision)
    .values({
      seerrRequestId: nextRequestId++,
      ssoUsername,
      decision,
      reason: decision === 'hold' ? 'over_quota' : 'under_quota',
      enforced: true,
      usageBytes: 0,
      quotaBytes: 0,
      source: 'poller',
      decidedAt: nowSeconds,
      heldSince: decision === 'hold' ? nowSeconds : null,
    })
    .run();
}

describe('loadQuotaStatus — FR-BAN-3: a member never sees another member\'s figures', () => {
  const now = 1_000_000;

  beforeAll(() => {
    insertMember('frank', now);
    insertMember('dana', now);

    insertTitle('movie:frank-only', 50_000_000_000, now);
    insertTitle('movie:dana-only', 900_000_000_000, now);

    insertClaim('movie:frank-only', 'frank', 50_000_000_000, now);
    insertClaim('movie:dana-only', 'dana', 900_000_000_000, now);

    getDb()
      .insert(quotaPolicy)
      .values({ ssoUsername: 'frank', quotaBytes: 900_000_000_000, source: 'default', updatedAt: now, updatedBy: 'system' })
      .run();
    getDb()
      .insert(quotaPolicy)
      .values({ ssoUsername: 'dana', quotaBytes: 100_000_000_000, source: 'default', updatedAt: now, updatedBy: 'system' })
      .run();

    insertRequestDecision('dana', 'hold', now);
    insertRequestDecision('dana', 'hold', now);
  });

  it("frank's usage is her own claim total only, not dana's", () => {
    const result = loadQuotaStatus('frank');
    expect(result.usageBytes).toBe(50_000_000_000);
    expect(result.quotaBytes).toBe(900_000_000_000);
    expect(result.state).toBe('ok');
  });

  it("dana's usage/quota/held count are her own, not frank's", () => {
    const result = loadQuotaStatus('dana');
    expect(result.usageBytes).toBe(900_000_000_000);
    expect(result.quotaBytes).toBe(100_000_000_000);
    expect(result.heldRequests).toBe(2);
    expect(result.state).toBe('over_quota');
  });

  it("frank's heldRequests is 0 even though dana has held rows", () => {
    expect(loadQuotaStatus('frank').heldRequests).toBe(0);
  });

  it('always links to the fixed quota.example.com URL (FR-BAN-6)', () => {
    expect(loadQuotaStatus('frank').url).toBe('https://quota.example.com');
  });
});

describe('loadQuotaStatus — excludes released claims and non-hold decisions', () => {
  const now = 2_000_000;

  beforeAll(() => {
    insertMember('mo', now);
    insertTitle('movie:mo-active', 10_000_000_000, now);
    insertTitle('movie:mo-released', 999_000_000_000, now);
    insertClaim('movie:mo-active', 'mo', 10_000_000_000, now, true);
    insertClaim('movie:mo-released', 'mo', 999_000_000_000, now, false); // released — must not count

    // A resolved (approved) request and a resolved (declined, e.g. hold
    // age-out) request must NOT count as currently held.
    insertRequestDecision('mo', 'approve', now);
    insertRequestDecision('mo', 'decline', now);
  });

  it('usage excludes the released claim entirely', () => {
    expect(loadQuotaStatus('mo').usageBytes).toBe(10_000_000_000);
  });

  it('heldRequests excludes approve/decline/skip rows — only decision=hold counts', () => {
    expect(loadQuotaStatus('mo').heldRequests).toBe(0);
  });
});

describe('loadQuotaStatus — the three FR-POL-2a quota states round-trip through a real quota_policy row', () => {
  const now = 3_000_000;

  it('no quota_policy row at all -> unconfigured (never promoted to 0 or unlimited)', () => {
    insertMember('nopolicy', now);
    const result = loadQuotaStatus('nopolicy');
    expect(result.state).toBe('unconfigured');
    expect(result.quotaBytes).toBeNull();
  });

  it('quota_policy.quota_bytes = null -> unconfigured', () => {
    insertMember('nullpolicy', now);
    getDb().insert(quotaPolicy).values({ ssoUsername: 'nullpolicy', quotaBytes: null, source: 'default', updatedAt: now, updatedBy: 'system' }).run();
    const result = loadQuotaStatus('nullpolicy');
    expect(result.state).toBe('unconfigured');
  });

  it('quota_policy.quota_bytes = 0 -> unlimited, never conflated with unconfigured', () => {
    insertMember('unlimiteduser', now);
    getDb().insert(quotaPolicy).values({ ssoUsername: 'unlimiteduser', quotaBytes: 0, source: 'override', updatedAt: now, updatedBy: 'admin' }).run();
    const result = loadQuotaStatus('unlimiteduser');
    expect(result.state).toBe('ok');
    expect(result.quotaBytes).toBe(0);
  });
});

describe('loadQuotaStatus — no attribution/claims recorded yet: usage reads as a real 0, not an error (see load.ts scoping note)', () => {
  it('a member with a configured quota but zero claims resolves ok with usageBytes=0', () => {
    const now = 4_000_000;
    insertMember('freshmember', now);
    getDb().insert(quotaPolicy).values({ ssoUsername: 'freshmember', quotaBytes: 500_000_000_000, source: 'default', updatedAt: now, updatedBy: 'system' }).run();
    const result = loadQuotaStatus('freshmember');
    expect(result).toEqual({
      state: 'ok',
      usageBytes: 0,
      quotaBytes: 500_000_000_000,
      shortfallBytes: 0,
      heldRequests: 0,
      url: 'https://quota.example.com',
    });
  });

  it('an unknown ssoUsername (no member row at all) still resolves cleanly to unconfigured, never throws', () => {
    expect(() => loadQuotaStatus('totally-unknown-user')).not.toThrow();
    const result = loadQuotaStatus('totally-unknown-user');
    expect(result.state).toBe('unconfigured');
    expect(result.usageBytes).toBe(0);
  });
});

describe('loadQuotaStatus — inheritance resolved at READ time, from BOTH the row and the CURRENT global default', () => {
  it('quota_policy.quota_bytes = null with a global default configured resolves to that default, live — no fan-out write required', () => {
    const now = 5_000_000;
    insertMember('inheritsdefault', now);
    getDb().insert(quotaPolicy).values({ ssoUsername: 'inheritsdefault', quotaBytes: null, source: 'default', updatedAt: now, updatedBy: 'system' }).run();

    // No default configured yet -> unconfigured.
    expect(loadQuotaStatus('inheritsdefault').state).toBe('unconfigured');

    // Operator sets a global default directly in app_setting (the real
    // setter, src/lib/quota/policy.ts's setGlobalDefaultQuota, is covered in
    // test/quota-policy.test.ts) — the member's row is NEVER touched, yet
    // their next read reflects it immediately.
    getDb().insert(appSetting).values({ key: 'default_quota_bytes', value: JSON.stringify(300_000_000_000), updatedAt: now, updatedBy: 'admin' }).run();

    const result = loadQuotaStatus('inheritsdefault');
    expect(result.state).toBe('ok');
    expect(result.quotaBytes).toBe(300_000_000_000);

    // Raising the default again — still no write to quota_policy — changes it again.
    getDb().update(appSetting).set({ value: JSON.stringify(10) }).where(eq(appSetting.key, 'default_quota_bytes')).run();
    expect(loadQuotaStatus('inheritsdefault').quotaBytes).toBe(10);

    const row = getDb().select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, 'inheritsdefault')).get();
    expect(row?.quotaBytes).toBeNull(); // untouched throughout
  });
});

describe('loadQuotaStatus — APP_URL is read from config, not hardcoded (FR-BAN-6)', () => {
  const ORIGINAL_APP_URL = process.env.APP_URL;

  afterAll(() => {
    if (ORIGINAL_APP_URL === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = ORIGINAL_APP_URL;
    _resetConfigCacheForTests();
  });

  it('an overridden APP_URL is reflected in the response', () => {
    process.env.APP_URL = 'https://quota-staging.example.com';
    _resetConfigCacheForTests();
    insertMember('urltest', 6_000_000);
    const result = loadQuotaStatus('urltest');
    expect(result.url).toBe('https://quota-staging.example.com');
  });
});
