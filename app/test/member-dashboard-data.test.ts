import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `loadMemberDashboard` (`@/app/_data/memberDashboard.ts`) — the impure
 * shell behind the P1-8 member view. Covers exactly the DB-touching
 * contract the pure logic module (`test/member-logic.test.ts`) can't:
 * that a member NEVER sees another member's claims/titles (`FR-POL-6`),
 * that "no reconcile has ever run" produces `no_snapshot` rather than a set
 * of zeros (P1-8 item 6), and that the three `FR-POL-2a` quota states
 * round-trip through a real `quota_policy` row (or its absence).
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-member-dashboard-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const { getDb } = await import('@/lib/db');
const { appSetting, claim, member, quotaPolicy, syncRun, title } = await import('@/lib/db/schema');
const { loadMemberDashboard } = await import('@/app/_data/memberDashboard');

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

function insertTitle(
  id: string,
  sizeBytes: number,
  nowSeconds: number,
  overrides: Partial<{ watchedByAnyone: boolean; lastPlayedAnyAt: number | null; year: number }> = {},
): void {
  getDb()
    .insert(title)
    .values({
      id,
      mediaType: 'movie',
      arrInstance: 'radarr',
      arrId: nextArrId++,
      title: id,
      year: overrides.year ?? 2020,
      sizeBytes,
      path: `/data/media/movies/${id}`,
      addedAt: nowSeconds,
      watchedByAnyone: overrides.watchedByAnyone ?? false,
      lastPlayedAnyAt: overrides.lastPlayedAnyAt ?? null,
      lastSyncedAt: nowSeconds,
    })
    .run();
}

function insertClaim(titleId: string, ssoUsername: string, chargedBytes: number, nowSeconds: number, active = true): void {
  getDb().insert(claim).values({ titleId, ssoUsername, chargedBytes, active, createdAt: nowSeconds }).run();
}

function insertAttributionSyncRun(finishedAt: number, startedAt = finishedAt - 5): void {
  getDb()
    .insert(syncRun)
    .values({ startedAt, finishedAt, steps: JSON.stringify({ requests: { ok: true }, attribution: { ok: true } }), ok: true })
    .run();
}

describe('loadMemberDashboard — no_snapshot before any attribution reconcile has run (P1-8 item 6)', () => {
  it('returns no_snapshot when sync_run is empty', async () => {
    insertMember('freshuser', 1_000_000);
    const result = await loadMemberDashboard('freshuser');
    expect(result).toEqual({ kind: 'no_snapshot' });
  });

  it('still no_snapshot when a sync_run exists but has no attribution step (e.g. only members sync has run)', async () => {
    getDb()
      .insert(syncRun)
      .values({ startedAt: 1, finishedAt: 2, steps: JSON.stringify({ identity: { ok: true } }), ok: true })
      .run();
    const result = await loadMemberDashboard('freshuser');
    expect(result).toEqual({ kind: 'no_snapshot' });
  });
});

describe('loadMemberDashboard — ok case, usage/titles/quota', () => {
  const now = 2_000_000;

  beforeAll(() => {
    insertAttributionSyncRun(now);
    insertMember('frank', now);
    insertMember('dana', now);

    insertTitle('movie:unwatched-big', 50_000_000_000, now, { watchedByAnyone: false });
    insertTitle('movie:watched', 5_000_000_000, now, { watchedByAnyone: true, lastPlayedAnyAt: now - 100 });
    insertTitle('movie:shared', 12_000_000_000, now, { watchedByAnyone: false });
    insertTitle('movie:not-mine', 999_000_000_000, now, { watchedByAnyone: false }); // dana-only

    insertClaim('movie:unwatched-big', 'frank', 50_000_000_000, now);
    insertClaim('movie:watched', 'frank', 5_000_000_000, now);
    insertClaim('movie:shared', 'frank', 12_000_000_000, now);
    insertClaim('movie:shared', 'dana', 12_000_000_000, now); // co-requested (D-3: each charged in full)
    insertClaim('movie:not-mine', 'dana', 999_000_000_000, now);
    // A released (inactive) claim for frank must NOT count toward usage or titles.
    insertTitle('movie:released', 77_000_000_000, now);
    insertClaim('movie:released', 'frank', 77_000_000_000, now, false);

    getDb()
      .insert(quotaPolicy)
      .values({
        ssoUsername: 'frank',
        quotaBytes: 100_000_000_000,
        source: 'override',
        note: 'grandfathered',
        updatedAt: now,
        updatedBy: 'admin',
      })
      .run();
  });

  it('usage is SUM(charged_bytes) over this member\'s own ACTIVE claims only', async () => {
    const result = await loadMemberDashboard('frank');
    if (result.kind !== 'ok') throw new Error('unreachable');
    // 50 + 5 + 12 GB — the released 77GB claim and dana's 999GB claim are excluded.
    expect(result.usedBytes).toBe(67_000_000_000);
  });

  it('never includes another member\'s title/claim (FR-POL-6)', async () => {
    const result = await loadMemberDashboard('frank');
    if (result.kind !== 'ok') throw new Error('unreachable');
    const titleIds = result.titles.map((t) => t.titleId).sort();
    expect(titleIds).toEqual(['movie:shared', 'movie:unwatched-big', 'movie:watched']);
    expect(titleIds).not.toContain('movie:not-mine');
  });

  it('excludes a released (inactive) claim entirely — not even as a zeroed row', async () => {
    const result = await loadMemberDashboard('frank');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.titles.some((t) => t.titleId === 'movie:released')).toBe(false);
  });

  it('flags the co-requested title as shared, without naming the other claimant', async () => {
    const result = await loadMemberDashboard('frank');
    if (result.kind !== 'ok') throw new Error('unreachable');
    const shared = result.titles.find((t) => t.titleId === 'movie:shared');
    const solo = result.titles.find((t) => t.titleId === 'movie:unwatched-big');
    expect(shared?.otherActiveClaimants).toBe(1);
    expect(solo?.otherActiveClaimants).toBe(0);
    // charged in FULL, never divided (D-3) — frank's charge equals the title's real size, not a fraction of it.
    expect(shared?.chargedBytes).toBe(12_000_000_000);
  });

  it('carries watched/last-played state per title, independent of the charge', async () => {
    const result = await loadMemberDashboard('frank');
    if (result.kind !== 'ok') throw new Error('unreachable');
    const watched = result.titles.find((t) => t.titleId === 'movie:watched');
    expect(watched?.watchedByAnyone).toBe(true);
    expect(watched?.lastPlayedAnyAt).toBe(now - 100);
    const unwatched = result.titles.find((t) => t.titleId === 'movie:unwatched-big');
    expect(unwatched?.watchedByAnyone).toBe(false);
    expect(unwatched?.lastPlayedAnyAt).toBeNull();
  });

  it('resolves a real override to the "limited" quota state and surfaces the operator note', async () => {
    const result = await loadMemberDashboard('frank');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.quota).toEqual({ kind: 'limited', bytes: 100_000_000_000 });
    expect(result.quotaNote).toBe('grandfathered');
  });

  it('carries the attribution snapshot timestamp', async () => {
    const result = await loadMemberDashboard('frank');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.snapshotAt).toBe(now);
  });

  it('falls back to the config default stale threshold when app_setting has no override (3600s)', async () => {
    const result = await loadMemberDashboard('frank');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.staleAfterSeconds).toBe(3600);
  });
});

describe('loadMemberDashboard — the other FR-POL-2a quota states', () => {
  const now = 3_000_000;

  beforeAll(() => {
    insertAttributionSyncRun(now, now - 5);
  });

  it('no quota_policy row at all -> unconfigured (never silently promoted to unlimited or 0)', async () => {
    insertMember('nopolicy', now);
    const result = await loadMemberDashboard('nopolicy');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.quota).toEqual({ kind: 'unconfigured' });
    expect(result.quotaNote).toBeNull();
  });

  it('quota_policy.quota_bytes = null -> unconfigured', async () => {
    insertMember('nullpolicy', now);
    getDb().insert(quotaPolicy).values({ ssoUsername: 'nullpolicy', quotaBytes: null, source: 'default', updatedAt: now, updatedBy: 'system' }).run();
    const result = await loadMemberDashboard('nullpolicy');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.quota).toEqual({ kind: 'unconfigured' });
  });

  it('quota_policy.quota_bytes = 0 -> unlimited (never conflated with unconfigured)', async () => {
    insertMember('unlimiteduser', now);
    getDb().insert(quotaPolicy).values({ ssoUsername: 'unlimiteduser', quotaBytes: 0, source: 'override', updatedAt: now, updatedBy: 'admin' }).run();
    const result = await loadMemberDashboard('unlimiteduser');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.quota).toEqual({ kind: 'unlimited' });
  });

  it('a member with zero claims still resolves ok, with an empty titles list and zero usage (a real measurement, not a missing one)', async () => {
    insertMember('nousage', now);
    const result = await loadMemberDashboard('nousage');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.usedBytes).toBe(0);
    expect(result.titles).toEqual([]);
  });
});

describe('loadMemberDashboard — stale_snapshot_max_age_s: app_setting DB value wins over the config default', () => {
  const now = 4_000_000;

  beforeAll(() => {
    insertAttributionSyncRun(now, now - 5);
    insertMember('staletest', now);
  });

  it('uses the app_setting override once one is written', async () => {
    getDb().insert(appSetting).values({ key: 'stale_snapshot_max_age_s', value: JSON.stringify(900), updatedAt: now, updatedBy: 'admin' }).run();
    const result = await loadMemberDashboard('staletest');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.staleAfterSeconds).toBe(900);
  });
});
