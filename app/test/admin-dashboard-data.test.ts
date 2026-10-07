import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `loadAdminDashboard` (`@/app/admin/_data/dashboard.ts`) — the impure shell
 * behind the P1-9 admin dashboard's main screen. Covers the DB-touching
 * contract `test/admin-logic.test.ts` can't: fleet totals computed over
 * DISTINCT titles (never a per-member sum, `FR-ACCT-3`), the member table
 * excluding non-entitled accounts while fleet totals still include their
 * bytes (`FR-ADM-2`), the "no account" vs "zero usage" distinction, and the
 * `no_data` first-boot empty state.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-admin-dashboard-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const { getDb } = await import('@/lib/db');
const { appSetting, audit, claim, member, quotaPolicy, requestDecision, syncRun, title } = await import('@/lib/db/schema');
const { loadAdminDashboard, readFreeBytes } = await import('@/app/admin/_data/dashboard');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function insertMember(
  ssoUsername: string,
  nowSeconds: number,
  overrides: Partial<{ entitled: boolean; isOperator: boolean; syncStatus: 'matched' | 'no_seerr_account' | 'not_entitled' | 'ambiguous'; syncNote: string | null; displayName: string }> = {},
): void {
  getDb()
    .insert(member)
    .values({
      ssoUsername,
      displayName: overrides.displayName ?? null,
      entitled: overrides.entitled ?? true,
      isOperator: overrides.isOperator ?? false,
      syncStatus: overrides.syncStatus ?? 'matched',
      syncNote: overrides.syncNote ?? null,
      firstSeenAt: nowSeconds,
      lastSyncedAt: nowSeconds,
    })
    .run();
}

function insertQuota(ssoUsername: string, quotaBytes: number | null, source: 'default' | 'override', nowSeconds: number): void {
  getDb().insert(quotaPolicy).values({ ssoUsername, quotaBytes, source, updatedAt: nowSeconds, updatedBy: 'system' }).run();
}

let nextArrId = 1;

function insertTitle(id: string, sizeBytes: number, nowSeconds: number, watchedByAnyone = false): void {
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
      watchedByAnyone,
      lastSyncedAt: nowSeconds,
    })
    .run();
}

function insertClaim(titleId: string, ssoUsername: string, chargedBytes: number, nowSeconds: number, active = true): void {
  getDb().insert(claim).values({ titleId, ssoUsername, chargedBytes, active, createdAt: nowSeconds }).run();
}

function insertSyncRun(steps: Record<string, unknown>, startedAt: number, finishedAt: number | null, ok: boolean | null): void {
  getDb().insert(syncRun).values({ startedAt, finishedAt, steps: JSON.stringify(steps), ok }).run();
}

describe('loadAdminDashboard — no_data before any attribution reconcile has run', () => {
  it('returns no_data when no sync_run exists at all', async () => {
    const result = await loadAdminDashboard(1_000_000);
    expect(result).toEqual({ kind: 'no_data' });
  });

  it('still no_data when other pipelines have run but attribution never has', async () => {
    insertSyncRun({ identity: { ok: true, count: 1, ms: 1 }, seerr_users: { ok: true, count: 1, ms: 1 }, classify: { ok: true, count: 1, ms: 1 } }, 1, 2, true);
    const result = await loadAdminDashboard(1_000_000);
    expect(result.kind).toBe('no_data');
  });
});

describe('loadAdminDashboard — ok case', () => {
  const now = 2_000_000;

  beforeAll(() => {
    // Five members: two clean (dana, frank, sharing one title), one operator
    // (admin), one no_seerr_account (ivy), one not_entitled (akadmin).
    insertMember('dana', now);
    insertMember('frank', now);
    insertMember('admin', now, { isOperator: true, displayName: 'Admin User' });
    insertMember('ivy', now, { syncStatus: 'no_seerr_account', syncNote: 'never logged in' });
    insertMember('akadmin', now, { entitled: false, syncStatus: 'not_entitled', syncNote: 'has a Seerr account but no entitlement' });

    insertQuota('dana', 900_000_000_000, 'override', now); // limited
    insertQuota('frank', 0, 'default', now); // unlimited
    // admin: no quota_policy row at all -> unconfigured, but state is 'operator' regardless
    // ivy: no quota row either

    insertTitle('movie:solo', 50_000_000_000, now, false);
    insertTitle('movie:shared', 12_000_000_000, now, false);
    insertTitle('movie:unclaimed', 999_000_000_000, now, false); // in the library, nobody has requested it

    insertClaim('movie:solo', 'dana', 50_000_000_000, now);
    insertClaim('movie:shared', 'dana', 12_000_000_000, now);
    insertClaim('movie:shared', 'frank', 12_000_000_000, now); // co-requested — D-3 full charge to both

    // Skipped decisions, two different reasons.
    getDb()
      .insert(requestDecision)
      .values([
        { seerrRequestId: 901, ssoUsername: 'ivy', decision: 'skip', reason: 'stale_snapshot', enforced: true, source: 'poller', decidedAt: now - 100 },
        { seerrRequestId: 902, ssoUsername: 'ivy', decision: 'skip', reason: 'stale_snapshot', enforced: true, source: 'poller', decidedAt: now - 50 },
        { seerrRequestId: 903, ssoUsername: 'ghost', decision: 'skip', reason: 'unknown_member', enforced: true, source: 'poller', decidedAt: now },
      ])
      .run();

    // An invariant violation, recorded AFTER the attribution run started (so it's "current").
    getDb()
      .insert(audit)
      .values({
        ts: (now + 10) * 1000,
        actor: 'system',
        actorRole: 'system',
        action: 'invariant.violated',
        targetType: 'title',
        targetId: 'movie:solo',
        outcome: 'error',
        source: 'cron',
        correlationId: 'c1',
        detail: JSON.stringify({ ssoUsername: 'dana', chargedBytes: 999, expectedBytes: 50_000_000_000 }),
      })
      .run();
    // An OLDER invariant violation, from before this attribution run — must NOT show up as "current".
    getDb()
      .insert(audit)
      .values({
        ts: (now - 100) * 1000,
        actor: 'system',
        actorRole: 'system',
        action: 'invariant.violated',
        targetType: 'title',
        targetId: 'movie:stale-violation',
        outcome: 'error',
        source: 'cron',
        correlationId: 'c0',
        detail: JSON.stringify({ ssoUsername: 'dana', chargedBytes: 1, expectedBytes: 2 }),
      })
      .run();

    insertSyncRun({ identity: { ok: true, count: 5, ms: 1 }, seerr_users: { ok: true, count: 5, ms: 1 }, classify: { ok: true, count: 5, ms: 1 } }, now - 300, now - 290, true);
    insertSyncRun({ movies: { ok: true, count: 10, ms: 1 }, series: { ok: true, count: 2, ms: 1 }, requests: { ok: true, count: 20, ms: 1 } }, now - 200, now - 190, true);
    insertSyncRun({ playback: { ok: false, count: 0, ms: 1, error: 'jellyfin unreachable' } }, now - 150, now - 140, false);
    insertSyncRun({ requests: { ok: true, count: 20, ms: 1 }, attribution: { ok: true, count: 3, ms: 1 } }, now - 20, now, true);
    insertSyncRun({ pending_sweep: { ok: true, count: 4, ms: 1 } }, now - 10, now - 5, true);

    getDb().insert(appSetting).values({ key: 'stale_snapshot_max_age_s', value: JSON.stringify(3_600), updatedAt: now, updatedBy: 'admin' }).run();
    getDb().insert(appSetting).values({ key: 'enforcement_enabled', value: JSON.stringify(true), updatedAt: now, updatedBy: 'admin' }).run();
  });

  it('fleet totals are computed over DISTINCT titles, not a per-member sum (FR-ACCT-3)', async () => {
    const result = await loadAdminDashboard(now);
    if (result.kind !== 'ok') throw new Error('unreachable');
    // solo(50) + shared(12) = 62GB distinct — NOT dana's 62 + frank's 12 = 74GB naive sum.
    expect(result.fleet.totalAttributedBytes).toBe(62_000_000_000);
    expect(result.fleet.distinctAttributedTitleCount).toBe(2);
    expect(result.fleet.attributedMemberCount).toBe(2); // dana, frank
  });

  it('total library size includes titles nobody has claimed', async () => {
    const result = await loadAdminDashboard(now);
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.fleet.totalLibraryBytes).toBe(50_000_000_000 + 12_000_000_000 + 999_000_000_000);
  });

  it('the member table EXCLUDES the not_entitled member (akadmin) — FR-ADM-2', async () => {
    const result = await loadAdminDashboard(now);
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.members.some((m) => m.ssoUsername === 'akadmin')).toBe(false);
  });

  it('a member with no Seerr account shows null usage (rendered "—"), never 0', async () => {
    const result = await loadAdminDashboard(now);
    if (result.kind !== 'ok') throw new Error('unreachable');
    const ivy = result.members.find((m) => m.ssoUsername === 'ivy')!;
    expect(ivy.usedBytes).toBeNull();
    expect(ivy.neverWatchedBytes).toBeNull();
    expect(ivy.titleCount).toBeNull();
    expect(ivy.state).toBe('no_acct');
  });

  it('the operator row states "operator" regardless of quota', async () => {
    const result = await loadAdminDashboard(now);
    if (result.kind !== 'ok') throw new Error('unreachable');
    const op = result.members.find((m) => m.ssoUsername === 'admin')!;
    expect(op.state).toBe('operator');
    expect(op.quota).toEqual({ kind: 'unconfigured' }); // no quota_policy row at all
  });

  it('dana is charged the full size of the shared title, same as frank (D-3)', async () => {
    const result = await loadAdminDashboard(now);
    if (result.kind !== 'ok') throw new Error('unreachable');
    const dana = result.members.find((m) => m.ssoUsername === 'dana')!;
    const frank = result.members.find((m) => m.ssoUsername === 'frank')!;
    expect(dana.usedBytes).toBe(62_000_000_000); // solo + shared, full charge
    expect(frank.usedBytes).toBe(12_000_000_000); // shared only, full charge
    expect(frank.quota).toEqual({ kind: 'unlimited' });
    expect(frank.state).toBe('exempt');
  });

  it('needs-attention groups skipped decisions by reason, never collapsing them', async () => {
    const result = await loadAdminDashboard(now);
    if (result.kind !== 'ok') throw new Error('unreachable');
    const reasons = result.attention.skipped.map((g) => g.reason);
    expect(reasons).toContain('stale_snapshot');
    expect(reasons).toContain('unknown_member');
    const stale = result.attention.skipped.find((g) => g.reason === 'stale_snapshot')!;
    expect(stale.count).toBe(2);
  });

  it('needs-attention sync drift includes no_seerr_account and not_entitled members', async () => {
    const result = await loadAdminDashboard(now);
    if (result.kind !== 'ok') throw new Error('unreachable');
    const driftUsernames = result.attention.syncDrift.map((d) => d.ssoUsername);
    expect(driftUsernames).toContain('ivy');
    expect(driftUsernames).toContain('akadmin');
    expect(driftUsernames).not.toContain('dana');
  });

  it('needs-attention invariant violations are scoped to the CURRENT attribution run, excluding older ones', async () => {
    const result = await loadAdminDashboard(now);
    if (result.kind !== 'ok') throw new Error('unreachable');
    const titleIds = result.attention.invariantViolations.map((v) => v.titleId);
    expect(titleIds).toContain('movie:solo');
    expect(titleIds).not.toContain('movie:stale-violation');
  });

  it('unresolved-attribution reporting is honestly "unavailable" — the current attribution/sync.ts does not persist those counts', async () => {
    const result = await loadAdminDashboard(now);
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.attention.unresolvedAttribution.available).toBe(false);
  });

  it('pipeline statuses classify all five pipelines and report per-step results', async () => {
    const result = await loadAdminDashboard(now);
    if (result.kind !== 'ok') throw new Error('unreachable');
    const byKind = new Map(result.pipelines.map((p) => [p.kind, p]));
    expect(byKind.get('members')?.overallOk).toBe(true);
    expect(byKind.get('playback')?.overallOk).toBe(false);
    expect(byKind.get('playback')?.steps[0]).toMatchObject({ stepKey: 'playback', ok: false, error: 'jellyfin unreachable' });
    expect(byKind.get('attribution')?.finishedAt).toBe(now);
  });

  it('carries the attribution snapshot timestamp and the app_setting-overridden enforcement flag', async () => {
    const result = await loadAdminDashboard(now);
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.attributionSnapshotAt).toBe(now);
    expect(result.enforcementEnabled).toBe(true);
    expect(result.staleAfterSeconds).toBe(3_600);
  });
});

describe('readFreeBytes', () => {
  it('returns a positive free-byte figure for a real, existing directory', () => {
    const result = readFreeBytes(tmpDir);
    expect(result.freeBytesError).toBeNull();
    expect(typeof result.freeBytes).toBe('number');
    expect(result.freeBytes as number).toBeGreaterThan(0);
  });

  it('degrades to an error, not a thrown exception, for a path that does not exist', () => {
    const result = readFreeBytes('/definitely/not/a/real/path/seerr-quota-test');
    expect(result.freeBytes).toBeNull();
    expect(typeof result.freeBytesError).toBe('string');
  });
});
