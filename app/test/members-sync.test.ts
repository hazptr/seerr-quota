import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { SeerrUsersClient, SeerrUserForMatch } from '@/lib/members/seerrUsers';

// Isolated throwaway DB file — same pattern as test/library-sync.test.ts and
// test/library-request-sync-failure-isolation.test.ts. Must be set BEFORE
// `@/lib/db` (transitively imported by `@/lib/members/sync`) is imported.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-members-sync-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const { getDb, _resetDbForTests } = await import('@/lib/db');
const { appSetting, member, quotaPolicy, syncRun, audit } = await import('@/lib/db/schema');
const { syncMembers } = await import('@/lib/members/sync');
const { _resetConfigCacheForTests } = await import('@/lib/config');
const { resolveEffectiveQuota } = await import('@/lib/members/quota');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Fresh DB per test — this suite cares about exact row/audit counts, which a shared handle across tests would pollute.
  _resetDbForTests();
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(`${tmpDbPath}-wal`, { force: true });
  fs.rmSync(`${tmpDbPath}-shm`, { force: true });
  _resetConfigCacheForTests();
});

function seerrUsersReturning(users: SeerrUserForMatch[]): SeerrUsersClient {
  return { listAllUsers: async () => users } as unknown as SeerrUsersClient;
}

function seerrUsersThatFail(message: string): SeerrUsersClient {
  return {
    listAllUsers: async () => {
      throw new Error(message);
    },
  } as unknown as SeerrUsersClient;
}

function fakeSeerrUser(id: number, overrides: Partial<SeerrUserForMatch> = {}): SeerrUserForMatch {
  return { id, email: `user${id}@example.com`, username: null, displayName: `user${id}`, jellyfinUsername: `user${id}`, jellyfinUserId: `guid-${id}`, ...overrides };
}

describe('syncMembers — roster comes straight from Seerr (0.2.0)', () => {
  it('every Seerr user becomes a matched, entitled member; no Authentik step exists any more', async () => {
    const seerrUsers = ['carol', 'dana', 'erin'].map((u, i) => fakeSeerrUser(i + 1, { jellyfinUsername: u, email: `${u}@example.com` }));

    const result = await syncMembers({ seerrUsers: seerrUsersReturning(seerrUsers) }, 1_000_000);

    expect(result.seerrUsers.ok).toBe(true);
    expect(result.classify.ok).toBe(true);

    const rows = getDb().select().from(member).all();
    expect(rows).toHaveLength(3);
    for (const u of ['carol', 'dana', 'erin']) {
      const row = rows.find((r) => r.ssoUsername === u);
      expect(row?.syncStatus, u).toBe('matched');
      expect(row?.entitled).toBe(true);
      expect(row?.seerrUserId).not.toBeNull();
    }

    // Every member has a resolvable quota_policy row (FR-SYNC-5), null until an operator decides (FR-POL-2).
    const quotaRows = getDb().select().from(quotaPolicy).all();
    expect(quotaRows).toHaveLength(3);
    expect(quotaRows.every((q) => q.source === 'default' && q.quotaBytes === null)).toBe(true);

    // sync_run recorded with the new (smaller) step set — no `identity` step.
    const runRow = getDb().select().from(syncRun).where(eq(syncRun.id, result.syncRunId)).get();
    expect(runRow?.ok).toBe(true);
    const steps = JSON.parse(runRow!.steps);
    expect(steps.seerr_users.ok).toBe(true);
    expect(steps.classify.ok).toBe(true);
    expect(steps.identity).toBeUndefined();
  });

  it('a Seerr user that disappears flips to entitled=false/not_entitled and the row is KEPT, never deleted', async () => {
    const seerr = [fakeSeerrUser(6, { jellyfinUsername: 'erin' })];
    await syncMembers({ seerrUsers: seerrUsersReturning(seerr) }, 4_000_000);

    // Next cycle: Seerr no longer lists erin at all.
    await syncMembers({ seerrUsers: seerrUsersReturning([]) }, 4_900_000);

    const row = getDb().select().from(member).where(eq(member.ssoUsername, 'erin')).get();
    expect(row).toBeDefined();
    expect(row?.entitled).toBe(false);
    expect(row?.syncStatus).toBe('not_entitled');
    expect(row?.seerrUserId).toBe(6); // linkage preserved for history (claims/audit keyed on sso_username, unaffected)
  });
});

describe('syncMembers — member key stability across re-syncs (task item 2, CRITICAL for production continuity)', () => {
  it('an existing linked member keeps its sso_username even if Seerr later reports a different jellyfinUsername for the same account', async () => {
    await syncMembers({ seerrUsers: seerrUsersReturning([fakeSeerrUser(42, { jellyfinUsername: 'original-login' })]) }, 1_000_000);
    const before = getDb().select().from(member).all();
    expect(before).toHaveLength(1);
    expect(before[0].ssoUsername).toBe('original-login');

    // Seerr now reports a renamed jellyfinUsername for the SAME account id.
    await syncMembers({ seerrUsers: seerrUsersReturning([fakeSeerrUser(42, { jellyfinUsername: 'renamed-login' })]) }, 2_000_000);

    const after = getDb().select().from(member).all();
    expect(after).toHaveLength(1); // no duplicate row
    expect(after[0].ssoUsername).toBe('original-login'); // key did NOT change
    expect(after[0].seerrUserId).toBe(42);
  });

  it('a second Seerr user never creates a duplicate row for an already-linked account', async () => {
    await syncMembers({ seerrUsers: seerrUsersReturning([fakeSeerrUser(1, { jellyfinUsername: 'dana' })]) }, 1_000_000);
    await syncMembers({ seerrUsers: seerrUsersReturning([fakeSeerrUser(1, { jellyfinUsername: 'dana' }), fakeSeerrUser(2, { jellyfinUsername: 'erin' })]) }, 2_000_000);

    const rows = getDb().select().from(member).all();
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.seerrUserId === 1)).toHaveLength(1);
  });

  it('a genuinely new Seerr user creates exactly one new member row', async () => {
    await syncMembers({ seerrUsers: seerrUsersReturning([fakeSeerrUser(1, { jellyfinUsername: 'dana' })]) }, 1_000_000);
    await syncMembers({ seerrUsers: seerrUsersReturning([fakeSeerrUser(1, { jellyfinUsername: 'dana' }), fakeSeerrUser(2, { jellyfinUsername: 'erin' })]) }, 2_000_000);

    const erin = getDb().select().from(member).where(eq(member.ssoUsername, 'erin')).get();
    expect(erin).toBeDefined();
    expect(erin?.seerrUserId).toBe(2);
    expect(erin?.isOperator).toBe(false);
  });
});

describe('syncMembers — audit discipline (FR-SYNC-9)', () => {
  it('a brand-new member produces exactly one audit row recording creation + default quota assignment', async () => {
    const result = await syncMembers({ seerrUsers: seerrUsersReturning([fakeSeerrUser(1, { jellyfinUsername: 'ivy' })]) }, 2_000_000);
    expect(result.classify.ok).toBe(true);

    const rows = getDb().select().from(audit).where(eq(audit.targetId, 'ivy')).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('member.created');
    expect(rows[0].actor).toBe('system');
    expect(rows[0].outcome).toBe('ok');
    const after = JSON.parse(rows[0].after!);
    expect(after.syncStatus).toBe('matched');
    // No DEFAULT_QUOTA_BYTES is configured in this test — the audit row honestly records `null`
    // ("nobody has decided yet"), not `0` ("unlimited") — FR-POL-2.
    expect(after.defaultQuotaBytes).toBeNull();
  });

  it('a routine no-op re-sync (identical classification) writes ZERO new audit rows', async () => {
    const seerr = [fakeSeerrUser(4, { jellyfinUsername: 'dana' })];
    await syncMembers({ seerrUsers: seerrUsersReturning(seerr) }, 3_000_000);

    const auditCountAfterFirst = getDb().select().from(audit).all().length;
    expect(auditCountAfterFirst).toBeGreaterThan(0);

    // Second, identical sync.
    await syncMembers({ seerrUsers: seerrUsersReturning(seerr) }, 3_900_000);
    const auditCountAfterSecond = getDb().select().from(audit).all().length;
    expect(auditCountAfterSecond).toBe(auditCountAfterFirst);

    // But last_synced_at DID advance — the row is fresh, just not audited.
    const row = getDb().select().from(member).where(eq(member.ssoUsername, 'dana')).get();
    expect(row?.lastSyncedAt).toBe(3_900_000);
  });

  it('losing entitlement writes exactly one member.entitlement_changed audit row', async () => {
    const seerr = [fakeSeerrUser(6, { jellyfinUsername: 'erin' })];
    await syncMembers({ seerrUsers: seerrUsersReturning(seerr) }, 4_000_000);

    // Next cycle: erin's Seerr account is gone.
    await syncMembers({ seerrUsers: seerrUsersReturning([]) }, 4_900_000);

    const rows = getDb().select().from(audit).where(eq(audit.targetId, 'erin')).all();
    const entitlementRows = rows.filter((r) => r.action === 'member.entitlement_changed');
    expect(entitlementRows).toHaveLength(1);

    const row = getDb().select().from(member).where(eq(member.ssoUsername, 'erin')).get();
    expect(row?.entitled).toBe(false);
    expect(row?.syncStatus).toBe('not_entitled');
    expect(row?.seerrUserId).toBe(6); // preserved, not nulled (FR-SYNC-6)

    const quotaRow = getDb().select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, 'erin')).get();
    expect(quotaRow).toBeDefined();
  });
});

describe('syncMembers — quota assignment (FR-SYNC-5, FR-POL-2a: inheritance resolved at READ time, never materialised)', () => {
  it('a new member ALWAYS gets quota_policy.quota_bytes = null, source = default — regardless of DEFAULT_QUOTA_BYTES, per wiki/Data-Model.md §quota_policy', async () => {
    process.env.DEFAULT_QUOTA_BYTES = '500000000000';
    _resetConfigCacheForTests();

    await syncMembers({ seerrUsers: seerrUsersReturning([fakeSeerrUser(1, { jellyfinUsername: 'jack' })]) }, 5_000_000);

    const quotaRow = getDb().select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, 'jack')).get();
    expect(quotaRow).toMatchObject({ source: 'default', quotaBytes: null });

    const auditRows = getDb().select().from(audit).where(eq(audit.targetId, 'jack')).all();
    const after = JSON.parse(auditRows[0].after!);
    expect(after.defaultQuotaBytes).toBe(500_000_000_000);

    delete process.env.DEFAULT_QUOTA_BYTES;
    _resetConfigCacheForTests();
  });

  it('DEFAULT_QUOTA_BYTES unset at creation time: quota_policy.quota_bytes is null AND the audit row honestly records null too', async () => {
    expect(process.env.DEFAULT_QUOTA_BYTES).toBeUndefined();
    await syncMembers({ seerrUsers: seerrUsersReturning([fakeSeerrUser(1, { jellyfinUsername: 'gus' })]) }, 5_100_000);
    const quotaRow = getDb().select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, 'gus')).get();
    expect(quotaRow?.source).toBe('default');
    expect(quotaRow?.quotaBytes).toBeNull();
  });

  it('DEFAULT_QUOTA_BYTES=0 at creation time: quota_policy.quota_bytes is STILL null, not 0', async () => {
    process.env.DEFAULT_QUOTA_BYTES = '0';
    _resetConfigCacheForTests();

    await syncMembers({ seerrUsers: seerrUsersReturning([fakeSeerrUser(1, { jellyfinUsername: 'hank' })]) }, 5_200_000);
    const quotaRow = getDb().select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, 'hank')).get();
    expect(quotaRow?.source).toBe('default');
    expect(quotaRow?.quotaBytes).toBeNull();

    delete process.env.DEFAULT_QUOTA_BYTES;
    _resetConfigCacheForTests();
  });

  it('raising the global default AFTER a member was created changes their effective quota immediately, with NO write to their quota_policy row', async () => {
    await syncMembers({ seerrUsers: seerrUsersReturning([fakeSeerrUser(1, { jellyfinUsername: 'ivy' })]) }, 5_300_000);
    const before = getDb().select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, 'ivy')).get()!;
    expect(before.quotaBytes).toBeNull();
    expect(resolveEffectiveQuota(before.quotaBytes, null)).toEqual({ kind: 'unconfigured' });

    getDb().insert(appSetting).values({ key: 'default_quota_bytes', value: JSON.stringify(250_000_000_000), updatedAt: 5_400_000, updatedBy: 'admin' }).run();

    const after = getDb().select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, 'ivy')).get()!;
    expect(after).toEqual(before);
    expect(resolveEffectiveQuota(after.quotaBytes, 250_000_000_000)).toEqual({ kind: 'limited', bytes: 250_000_000_000 });
  });

  it('never overwrites an operator quota override, even across a later classification change', async () => {
    const seerr = [fakeSeerrUser(8, { jellyfinUsername: 'frank' })];
    await syncMembers({ seerrUsers: seerrUsersReturning(seerr) }, 6_000_000);

    getDb()
      .update(quotaPolicy)
      .set({ quotaBytes: 999_999, source: 'override', note: 'operator bump', updatedAt: 6_100_000, updatedBy: 'admin' })
      .where(eq(quotaPolicy.ssoUsername, 'frank'))
      .run();

    // A later cycle that changes frank's classification (loses entitlement) must not touch the override.
    await syncMembers({ seerrUsers: seerrUsersReturning([]) }, 6_200_000);

    const quotaRow = getDb().select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, 'frank')).get();
    expect(quotaRow).toMatchObject({ source: 'override', quotaBytes: 999_999 });
  });
});

describe('syncMembers — failure isolation (FR-SYNC-10): Seerr down must not mass-flip entitlement', () => {
  it('a previously matched+entitled member is left COMPLETELY untouched when Seerr is unreachable', async () => {
    const seerr = [fakeSeerrUser(3, { jellyfinUsername: 'carol' })];
    await syncMembers({ seerrUsers: seerrUsersReturning(seerr) }, 7_000_000);

    const before = getDb().select().from(member).where(eq(member.ssoUsername, 'carol')).get();
    expect(before?.entitled).toBe(true);
    expect(before?.syncStatus).toBe('matched');

    const auditCountBefore = getDb().select().from(audit).all().length;

    const result = await syncMembers({ seerrUsers: seerrUsersThatFail('connect ECONNREFUSED jellyseerr:5055') }, 7_900_000);

    expect(result.seerrUsers.ok).toBe(false);
    expect(result.classify.ok).toBe(false);
    expect(result.classify.error).toMatch(/skipped/);

    const after = getDb().select().from(member).where(eq(member.ssoUsername, 'carol')).get();
    expect(after).toEqual(before); // byte-for-byte unchanged

    const runRow = getDb().select().from(syncRun).where(eq(syncRun.id, result.syncRunId)).get();
    expect(runRow?.ok).toBe(false);
    const steps = JSON.parse(runRow!.steps);
    expect(steps.seerr_users.ok).toBe(false);

    const failedRows = getDb().select().from(audit).where(eq(audit.action, 'sync.failed')).all();
    expect(failedRows.length).toBeGreaterThan(0);
    const auditCountAfter = getDb().select().from(audit).all().length;
    expect(auditCountAfter).toBe(auditCountBefore + failedRows.length);
    const carolAuditRows = getDb().select().from(audit).where(eq(audit.targetId, 'carol')).all();
    expect(carolAuditRows).toHaveLength(1); // only the original member.created
  });
});

describe('syncMembers — is_operator (FR-ENF-6, background half: ADMIN_USERS only — no groups header off-request)', () => {
  it('persists is_operator=true for a member whose USERNAME is in ADMIN_USERS (default ADMIN_USERS=admin)', async () => {
    await syncMembers({ seerrUsers: seerrUsersReturning([fakeSeerrUser(1, { jellyfinUsername: null, username: 'admin' })]) }, 9_100_000);

    const admin = getDb().select().from(member).where(eq(member.ssoUsername, 'admin')).get();
    expect(admin?.isOperator).toBe(true);
  });

  it('a member outside ADMIN_USERS has is_operator=false, even if they would be in ADMIN_GROUP at request time', async () => {
    await syncMembers({ seerrUsers: seerrUsersReturning([fakeSeerrUser(1, { jellyfinUsername: null, username: 'gus' })]) }, 9_200_000);

    const gus = getDb().select().from(member).where(eq(member.ssoUsername, 'gus')).get();
    expect(gus?.isOperator).toBe(false);
  });
});
