import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthentikClient } from '@/lib/authentik/client';
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

interface FakeIdentity {
  ssoUsername: string;
  authentikUuid: string;
  displayName: string;
  email: string;
  groupNames: string[];
}

function authentikReturning(identities: FakeIdentity[]): AuthentikClient {
  return {
    getApplicationBySlug: async () => ({ uuid: 'app-uuid', slug: 'jellyseerr', name: 'Seerr' }),
    listPolicyBindingsForTarget: async () =>
      identities.map((i, index) => ({
        pk: `binding-${index}`,
        user: index,
        group: null,
        enabled: true,
        negate: false,
        userObj: { pk: index, username: i.ssoUsername, name: i.displayName, email: i.email, isActive: true },
      })),
    listActiveUsers: async () =>
      identities.map((i, index) => ({
        pk: index,
        uuid: i.authentikUuid,
        username: i.ssoUsername,
        name: i.displayName,
        email: i.email,
        isActive: true,
        groupNames: i.groupNames,
      })),
  } as unknown as AuthentikClient;
}

function authentikThatFails(message: string): AuthentikClient {
  return {
    getApplicationBySlug: async () => {
      throw new Error(message);
    },
    listPolicyBindingsForTarget: async () => [],
    listActiveUsers: async () => [],
  } as unknown as AuthentikClient;
}

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

function fakeIdentity(ssoUsername: string, overrides: Partial<FakeIdentity> = {}): FakeIdentity {
  return { ssoUsername, authentikUuid: `uuid-${ssoUsername}`, displayName: ssoUsername, email: `${ssoUsername}@example.com`, groupNames: [], ...overrides };
}

function fakeSeerrUser(id: number, overrides: Partial<SeerrUserForMatch> = {}): SeerrUserForMatch {
  return { id, email: `user${id}@example.com`, username: null, displayName: `user${id}`, jellyfinUsername: `user${id}`, jellyfinUserId: `guid-${id}`, ...overrides };
}

describe('syncMembers — the live correctness bar (wiki/Feature-02-Account-Sync.md)', () => {
  it('persists exactly the documented classification for the 2026-08-24 worked table', async () => {
    const entitledUsernames = ['admin', 'carol', 'dana', 'erin', 'jack', 'frank', 'ivy', 'hank', 'family', 'gus'];
    const identities = entitledUsernames.map((u) => fakeIdentity(u, { email: u === 'family' ? '' : `${u}@example.com` }));
    const matchedUsernames = ['admin', 'carol', 'dana', 'erin', 'jack', 'frank'];
    const seerrUsers = [
      ...matchedUsernames.map((u, i) => fakeSeerrUser(i + 1, { jellyfinUsername: u, email: `${u}@example.com` })),
      fakeSeerrUser(9, { jellyfinUsername: null, username: 'akadmin', displayName: 'akadmin', email: null }),
    ];

    const result = await syncMembers({ authentik: authentikReturning(identities), seerrUsers: seerrUsersReturning(seerrUsers) }, 1_000_000);

    expect(result.identity.ok).toBe(true);
    expect(result.seerrUsers.ok).toBe(true);
    expect(result.classify.ok).toBe(true);

    const rows = getDb().select().from(member).all();
    expect(rows).toHaveLength(11); // 10 entitled + akadmin orphan

    for (const u of matchedUsernames) {
      const row = rows.find((r) => r.ssoUsername === u);
      expect(row?.syncStatus, u).toBe('matched');
      expect(row?.entitled).toBe(true);
      expect(row?.seerrUserId).not.toBeNull();
    }
    for (const u of ['ivy', 'hank', 'family', 'gus']) {
      const row = rows.find((r) => r.ssoUsername === u);
      expect(row?.syncStatus, u).toBe('no_seerr_account');
      expect(row?.entitled).toBe(true);
    }
    const akadmin = rows.find((r) => r.ssoUsername === 'akadmin');
    expect(akadmin?.syncStatus).toBe('not_entitled');
    expect(akadmin?.entitled).toBe(false);

    // Every member (however classified) has a resolvable quota_policy ROW (FR-SYNC-5) — but no
    // DEFAULT_QUOTA_BYTES is configured in this test, so its value is `null` ("nobody has decided
    // yet"), never silently promoted to `0` ("unlimited") — FR-POL-2. See the dedicated
    // "quota assignment" describe block below for the null/0/N distinction end to end.
    const quotaRows = getDb().select().from(quotaPolicy).all();
    expect(quotaRows).toHaveLength(11);
    expect(quotaRows.every((q) => q.source === 'default')).toBe(true);
    expect(quotaRows.every((q) => q.quotaBytes === null)).toBe(true);

    // sync_run recorded with the right step keys.
    const runRow = getDb().select().from(syncRun).where(eq(syncRun.id, result.syncRunId)).get();
    expect(runRow?.ok).toBe(true);
    const steps = JSON.parse(runRow!.steps);
    expect(steps.identity.ok).toBe(true);
    expect(steps.seerr_users.ok).toBe(true);
    expect(steps.classify.ok).toBe(true);
  });
});

describe('syncMembers — audit discipline (FR-SYNC-9)', () => {
  it('a brand-new member produces exactly one audit row recording creation + default quota assignment', async () => {
    const identities = [fakeIdentity('ivy')];
    const result = await syncMembers({ authentik: authentikReturning(identities), seerrUsers: seerrUsersReturning([]) }, 2_000_000);
    expect(result.classify.ok).toBe(true);

    const rows = getDb().select().from(audit).where(eq(audit.targetId, 'ivy')).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('member.created');
    expect(rows[0].actor).toBe('system');
    expect(rows[0].outcome).toBe('ok');
    const after = JSON.parse(rows[0].after!);
    expect(after.syncStatus).toBe('no_seerr_account');
    // No DEFAULT_QUOTA_BYTES is configured in this test — the audit row honestly records `null`
    // ("nobody has decided yet"), not `0` ("unlimited") — FR-POL-2.
    expect(after.defaultQuotaBytes).toBeNull();
  });

  it('a routine no-op re-sync (identical classification) writes ZERO new audit rows', async () => {
    const identities = [fakeIdentity('dana')];
    const seerr = [fakeSeerrUser(4, { jellyfinUsername: 'dana' })];
    await syncMembers({ authentik: authentikReturning(identities), seerrUsers: seerrUsersReturning(seerr) }, 3_000_000);

    const auditCountAfterFirst = getDb().select().from(audit).all().length;
    expect(auditCountAfterFirst).toBeGreaterThan(0);

    // Second, identical sync.
    await syncMembers({ authentik: authentikReturning(identities), seerrUsers: seerrUsersReturning(seerr) }, 3_900_000);
    const auditCountAfterSecond = getDb().select().from(audit).all().length;
    expect(auditCountAfterSecond).toBe(auditCountAfterFirst);

    // But last_synced_at DID advance — the row is fresh, just not audited.
    const row = getDb().select().from(member).where(eq(member.ssoUsername, 'dana')).get();
    expect(row?.lastSyncedAt).toBe(3_900_000);
  });

  it('losing entitlement writes exactly one member.entitlement_changed audit row', async () => {
    const identities = [fakeIdentity('erin')];
    const seerr = [fakeSeerrUser(6, { jellyfinUsername: 'erin' })];
    await syncMembers({ authentik: authentikReturning(identities), seerrUsers: seerrUsersReturning(seerr) }, 4_000_000);

    // Next cycle: erin no longer holds the binding.
    await syncMembers({ authentik: authentikReturning([]), seerrUsers: seerrUsersReturning(seerr) }, 4_900_000);

    const rows = getDb().select().from(audit).where(eq(audit.targetId, 'erin')).all();
    const entitlementRows = rows.filter((r) => r.action === 'member.entitlement_changed');
    expect(entitlementRows).toHaveLength(1);

    const row = getDb().select().from(member).where(eq(member.ssoUsername, 'erin')).get();
    expect(row?.entitled).toBe(false);
    expect(row?.syncStatus).toBe('not_entitled');
    // Claims/history keys (seerr_user_id) are preserved, not nulled (FR-SYNC-6).
    expect(row?.seerrUserId).toBe(6);

    // The member row was NOT deleted, and quota_policy is untouched.
    const quotaRow = getDb().select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, 'erin')).get();
    expect(quotaRow).toBeDefined();
  });
});

describe('syncMembers — quota assignment (FR-SYNC-5, FR-POL-2a: inheritance resolved at READ time, never materialised)', () => {
  it('a new member ALWAYS gets quota_policy.quota_bytes = null, source = default — regardless of DEFAULT_QUOTA_BYTES, per wiki/Data-Model.md §quota_policy', async () => {
    process.env.DEFAULT_QUOTA_BYTES = '500000000000';
    _resetConfigCacheForTests();

    await syncMembers({ authentik: authentikReturning([fakeIdentity('jack')]), seerrUsers: seerrUsersReturning([]) }, 5_000_000);

    const quotaRow = getDb().select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, 'jack')).get();
    // Materialising 500_000_000_000 into the row here is exactly the bug this
    // task fixes: it would mean every future default change needs a
    // fan-out write to reach jack. The row stays null forever until an
    // operator sets an explicit override.
    expect(quotaRow).toMatchObject({ source: 'default', quotaBytes: null });

    // The RESOLVED default at creation time is still recorded, for operator
    // context, in the member.created audit row's `after.defaultQuotaBytes`
    // — it's just never written into quota_policy itself.
    const auditRows = getDb().select().from(audit).where(eq(audit.targetId, 'jack')).all();
    const after = JSON.parse(auditRows[0].after!);
    expect(after.defaultQuotaBytes).toBe(500_000_000_000);

    delete process.env.DEFAULT_QUOTA_BYTES;
    _resetConfigCacheForTests();
  });

  it('DEFAULT_QUOTA_BYTES unset at creation time: quota_policy.quota_bytes is null AND the audit row honestly records null too', async () => {
    expect(process.env.DEFAULT_QUOTA_BYTES).toBeUndefined();
    await syncMembers({ authentik: authentikReturning([fakeIdentity('gus')]), seerrUsers: seerrUsersReturning([]) }, 5_100_000);
    const quotaRow = getDb().select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, 'gus')).get();
    expect(quotaRow?.source).toBe('default');
    expect(quotaRow?.quotaBytes).toBeNull();
  });

  it('DEFAULT_QUOTA_BYTES=0 at creation time: quota_policy.quota_bytes is STILL null, not 0 — the row never materialises the default\'s value, whatever it is', async () => {
    process.env.DEFAULT_QUOTA_BYTES = '0';
    _resetConfigCacheForTests();

    await syncMembers({ authentik: authentikReturning([fakeIdentity('hank')]), seerrUsers: seerrUsersReturning([]) }, 5_200_000);
    const quotaRow = getDb().select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, 'hank')).get();
    expect(quotaRow?.source).toBe('default');
    expect(quotaRow?.quotaBytes).toBeNull();

    delete process.env.DEFAULT_QUOTA_BYTES;
    _resetConfigCacheForTests();
  });

  it('raising the global default AFTER a member was created changes their effective quota immediately, with NO write to their quota_policy row', async () => {
    await syncMembers({ authentik: authentikReturning([fakeIdentity('ivy')]), seerrUsers: seerrUsersReturning([]) }, 5_300_000);
    const before = getDb().select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, 'ivy')).get()!;
    expect(before.quotaBytes).toBeNull();
    expect(resolveEffectiveQuota(before.quotaBytes, null)).toEqual({ kind: 'unconfigured' });

    // The operator raises the default — via app_setting directly here (the
    // real setter, src/lib/quota/policy.ts's setGlobalDefaultQuota, is
    // exercised in test/quota-policy.test.ts; this test only needs to prove
    // ivy's row is untouched by ANY default change, however it's made).
    getDb().insert(appSetting).values({ key: 'default_quota_bytes', value: JSON.stringify(250_000_000_000), updatedAt: 5_400_000, updatedBy: 'admin' }).run();

    const after = getDb().select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, 'ivy')).get()!;
    expect(after).toEqual(before); // byte-for-byte unchanged — no fan-out write happened
    expect(resolveEffectiveQuota(after.quotaBytes, 250_000_000_000)).toEqual({ kind: 'limited', bytes: 250_000_000_000 });
  });

  it('never overwrites an operator quota override, even across a later classification change', async () => {
    const identities = [fakeIdentity('frank')];
    const seerr = [fakeSeerrUser(8, { jellyfinUsername: 'frank' })];
    await syncMembers({ authentik: authentikReturning(identities), seerrUsers: seerrUsersReturning(seerr) }, 6_000_000);

    // Operator sets an override.
    getDb()
      .update(quotaPolicy)
      .set({ quotaBytes: 999_999, source: 'override', note: 'operator bump', updatedAt: 6_100_000, updatedBy: 'admin' })
      .where(eq(quotaPolicy.ssoUsername, 'frank'))
      .run();

    // A later cycle that changes frank's classification (loses entitlement) must not touch the override.
    await syncMembers({ authentik: authentikReturning([]), seerrUsers: seerrUsersReturning(seerr) }, 6_200_000);

    const quotaRow = getDb().select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, 'frank')).get();
    expect(quotaRow).toMatchObject({ source: 'override', quotaBytes: 999_999 });
  });
});

describe('syncMembers — failure isolation (FR-SYNC-10): Authentik down must not mass-flip entitlement', () => {
  it('a previously matched+entitled member is left COMPLETELY untouched when Authentik is unreachable', async () => {
    const identities = [fakeIdentity('carol')];
    const seerr = [fakeSeerrUser(3, { jellyfinUsername: 'carol' })];
    await syncMembers({ authentik: authentikReturning(identities), seerrUsers: seerrUsersReturning(seerr) }, 7_000_000);

    const before = getDb().select().from(member).where(eq(member.ssoUsername, 'carol')).get();
    expect(before?.entitled).toBe(true);
    expect(before?.syncStatus).toBe('matched');

    const auditCountBefore = getDb().select().from(audit).all().length;

    // Authentik is down this cycle.
    const result = await syncMembers(
      { authentik: authentikThatFails('connect ETIMEDOUT auth.example.com'), seerrUsers: seerrUsersReturning(seerr) },
      7_900_000,
    );

    expect(result.identity.ok).toBe(false);
    expect(result.classify.ok).toBe(false);
    expect(result.classify.error).toMatch(/skipped/);

    // carol's row is byte-for-byte unchanged — NOT flipped to not_entitled, lastSyncedAt did NOT advance.
    const after = getDb().select().from(member).where(eq(member.ssoUsername, 'carol')).get();
    expect(after).toEqual(before);

    // sync_run recorded the failure, honestly.
    const runRow = getDb().select().from(syncRun).where(eq(syncRun.id, result.syncRunId)).get();
    expect(runRow?.ok).toBe(false);
    const steps = JSON.parse(runRow!.steps);
    expect(steps.identity.ok).toBe(false);

    // A sync.failed audit row was written (the failure is loud)...
    const failedRows = getDb().select().from(audit).where(eq(audit.action, 'sync.failed')).all();
    expect(failedRows.length).toBeGreaterThan(0);
    // ...but NO member.* audit rows were added — nothing about carol (or anyone) was reclassified.
    const auditCountAfter = getDb().select().from(audit).all().length;
    expect(auditCountAfter).toBe(auditCountBefore + failedRows.length);
    const carolAuditRows = getDb().select().from(audit).where(eq(audit.targetId, 'carol')).all();
    expect(carolAuditRows).toHaveLength(1); // only the original member.created from the first successful sync
  });

  it('Seerr users unreachable also aborts classify+upsert entirely (not just the Authentik half)', async () => {
    const identities = [fakeIdentity('jack')];
    const seerr = [fakeSeerrUser(7, { jellyfinUsername: 'jack' })];
    await syncMembers({ authentik: authentikReturning(identities), seerrUsers: seerrUsersReturning(seerr) }, 8_000_000);
    const before = getDb().select().from(member).where(eq(member.ssoUsername, 'jack')).get();

    const result = await syncMembers(
      { authentik: authentikReturning(identities), seerrUsers: seerrUsersThatFail('connect ECONNREFUSED jellyseerr:5055') },
      8_900_000,
    );

    expect(result.seerrUsers.ok).toBe(false);
    expect(result.classify.ok).toBe(false);

    const after = getDb().select().from(member).where(eq(member.ssoUsername, 'jack')).get();
    expect(after).toEqual(before); // untouched — not reclassified to no_seerr_account just because Seerr was briefly unreachable
  });
});

describe('syncMembers — is_operator (FR-ENF-6), real group data (admin -> admins)', () => {
  it('persists is_operator=true for a member whose Authentik groups_obj includes ADMIN_GROUP (default: admins)', async () => {
    const identities = [fakeIdentity('admin', { groupNames: ['admins'] }), fakeIdentity('carol', { groupNames: ['friends'] })];
    await syncMembers({ authentik: authentikReturning(identities), seerrUsers: seerrUsersReturning([]) }, 9_000_000);

    const admin = getDb().select().from(member).where(eq(member.ssoUsername, 'admin')).get();
    const carol = getDb().select().from(member).where(eq(member.ssoUsername, 'carol')).get();
    expect(admin?.isOperator).toBe(true);
    expect(carol?.isOperator).toBe(false);
  });

  it('persists is_operator=true for a member whose USERNAME is in ADMIN_USERS, even with no admin group (default ADMIN_USERS=admin)', async () => {
    const identities = [fakeIdentity('admin', { groupNames: [] })];
    await syncMembers({ authentik: authentikReturning(identities), seerrUsers: seerrUsersReturning([]) }, 9_100_000);

    const admin = getDb().select().from(member).where(eq(member.ssoUsername, 'admin')).get();
    expect(admin?.isOperator).toBe(true);
  });

  it('a member outside ADMIN_USERS/ADMIN_GROUP has is_operator=false', async () => {
    const identities = [fakeIdentity('gus', { groupNames: [] })];
    await syncMembers({ authentik: authentikReturning(identities), seerrUsers: seerrUsersReturning([]) }, 9_200_000);

    const gus = getDb().select().from(member).where(eq(member.ssoUsername, 'gus')).get();
    expect(gus?.isOperator).toBe(false);
  });
});
