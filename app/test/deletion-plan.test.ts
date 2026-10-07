import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-deletion-plan-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;
process.env.DELETE_RECENT_PLAY_DAYS = '14';

const { getDb, _resetDbForTests } = await import('@/lib/db');
const { member, title, claim, playback, audit, syncRun } = await import('@/lib/db/schema');
const { _resetConfigCacheForTests } = await import('@/lib/config');
const { planDeletionItems } = await import('@/lib/deletion/plan');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const NOW = 1_800_000_000;
const DAY = 86_400;

/**
 * FR-DEL-21: every playback-dependent guard now blocks (unavailable: true)
 * unless a RECENT, SUCCESSFUL playback sync is on record — see
 * `test/deletion-guards.test.ts` for the guard-level unit tests, and the
 * "FR-DEL-21" describe block below for the tests that specifically exercise
 * the ABSENCE of this seed. Every other test in this file seeds a healthy
 * sync so its guard-evaluation scenarios exercise what they were originally
 * written to exercise, not the (now correct) fail-safe block.
 */
function seedHealthyPlaybackSync(finishedAtSeconds = NOW - 60): void {
  getDb()
    .insert(syncRun)
    .values({ startedAt: finishedAtSeconds - 5, finishedAt: finishedAtSeconds, steps: JSON.stringify({ playback: { ok: true, count: 1, ms: 5 } }), ok: true })
    .run();
}

beforeEach(() => {
  _resetDbForTests();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${tmpDbPath}${suffix}`, { force: true });
  _resetConfigCacheForTests();
  seedHealthyPlaybackSync();
});

function seedMember(ssoUsername: string): void {
  getDb()
    .insert(member)
    .values({ ssoUsername, entitled: true, isOperator: false, syncStatus: 'matched', firstSeenAt: NOW - 1000, lastSyncedAt: NOW - 10 })
    .run();
}

function seedTitle(id: string, opts: Partial<{ sizeBytes: number; protectedTitle: boolean; watchedByAnyone: boolean; lastPlayedAnyAt: number | null }> = {}): void {
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
      watchedByAnyone: opts.watchedByAnyone ?? false,
      lastPlayedAnyAt: opts.lastPlayedAnyAt ?? null,
      lastSyncedAt: NOW - 30,
    })
    .run();
}

function seedClaim(titleId: string, ssoUsername: string, chargedBytes = 1000): void {
  getDb().insert(claim).values({ titleId, ssoUsername, seerrRequestId: null, chargedBytes, active: true, createdAt: NOW - 500 }).run();
}

describe('planDeletionItems — read-only preview (FR-DEL-1/14, FR-DEL-4a)', () => {
  it('an unknown title id is found:false with no metadata leaked', () => {
    const [item] = planDeletionItems({ username: 'frank', isOperator: false }, [{ titleId: 'movie:ghost', requestedMode: 'delete_files' }], { nowSeconds: NOW });
    expect(item).toEqual({ titleId: 'movie:ghost', found: false, outcome: 'unauthorized' });
  });

  it('a real title the member does not claim is ALSO found:false — indistinguishable from an unknown id', () => {
    seedMember('dana');
    seedTitle('movie:1', { sizeBytes: 5000 });
    seedClaim('movie:1', 'dana');

    const [item] = planDeletionItems({ username: 'frank', isOperator: false }, [{ titleId: 'movie:1', requestedMode: 'delete_files' }], { nowSeconds: NOW });
    expect(item).toEqual({ titleId: 'movie:1', found: false, outcome: 'unauthorized' });
  });

  it('sole claimant previews as deletable, with full metadata', () => {
    seedMember('frank');
    seedTitle('movie:2', { sizeBytes: 12_000_000_000 });
    seedClaim('movie:2', 'frank', 12_000_000_000);

    const [item] = planDeletionItems({ username: 'frank', isOperator: false }, [{ titleId: 'movie:2', requestedMode: 'delete_files' }], { nowSeconds: NOW });
    expect(item.found).toBe(true);
    expect(item.outcome).toBe('delete');
    expect(item.sizeBytes).toBe(12_000_000_000);
    expect(item.otherActiveClaimants).toBe(0);
  });

  it('co-claimant previews the delete request as a release (downgraded), never as a silent delete', () => {
    seedMember('frank');
    seedMember('dana');
    seedTitle('movie:3');
    seedClaim('movie:3', 'frank');
    seedClaim('movie:3', 'dana');

    const [item] = planDeletionItems({ username: 'frank', isOperator: false }, [{ titleId: 'movie:3', requestedMode: 'delete_files' }], { nowSeconds: NOW });
    expect(item.outcome).toBe('release');
    expect(item.downgradedFromDelete).toBe(true);
    expect(item.otherActiveClaimants).toBe(1);
  });

  it('sole claimant previewing a release is blocked, with the reason surfaced', () => {
    seedMember('frank');
    seedTitle('movie:4');
    seedClaim('movie:4', 'frank');

    const [item] = planDeletionItems({ username: 'frank', isOperator: false }, [{ titleId: 'movie:4', requestedMode: 'release_claim' }], { nowSeconds: NOW });
    expect(item.outcome).toBe('blocked');
    expect(item.blockedReason).toBe('sole_claimant_cannot_release');
  });

  it('a recently-played title previews as blocked, with a member message that never names who', () => {
    seedMember('frank');
    seedMember('erin');
    seedTitle('movie:5', { watchedByAnyone: true, lastPlayedAnyAt: NOW - 2 * DAY });
    seedClaim('movie:5', 'frank');

    const [item] = planDeletionItems({ username: 'frank', isOperator: false }, [{ titleId: 'movie:5', requestedMode: 'delete_files' }], { nowSeconds: NOW });
    expect(item.outcome).toBe('blocked');
    expect(item.blockedReason).toBe('guard');
    expect(item.guardMessages?.[0]).toBeDefined();
    expect(item.guardMessages?.[0]).not.toContain('erin');
  });

  it('the SAME recently-played title, previewed by an operator, includes who (FR-DEL-4a)', () => {
    seedMember('frank');
    seedMember('erin');
    seedTitle('movie:6', { watchedByAnyone: true, lastPlayedAnyAt: NOW - 2 * DAY });
    seedClaim('movie:6', 'frank');
    getDb()
      .insert(playback)
      .values({ titleId: 'movie:6', jellyfinUserId: 'erinjf', playCount: 1, lastPlayedAt: NOW - 2 * DAY, lastSyncedAt: NOW })
      .run();
    getDb().update(member).set({ jellyfinUserId: 'erinjf' }).where(eq(member.ssoUsername, 'erin')).run();

    const [item] = planDeletionItems({ username: 'admin', isOperator: true }, [{ titleId: 'movie:6', requestedMode: 'delete_files' }], { nowSeconds: NOW });
    expect(item.outcome).toBe('blocked');
    expect(item.guardMessages?.[0]).toContain('erin');
  });

  it('already-gone (sizeBytes 0) previews distinctly, not as an error', () => {
    seedMember('frank');
    seedTitle('movie:7', { sizeBytes: 0 });
    seedClaim('movie:7', 'frank', 0);

    const [item] = planDeletionItems({ username: 'frank', isOperator: false }, [{ titleId: 'movie:7', requestedMode: 'delete_files' }], { nowSeconds: NOW });
    expect(item.outcome).toBe('already_gone');
  });

  it('operator previewing on_behalf_of a member sees that member state, not their own', () => {
    seedMember('frank');
    seedMember('admin');
    seedTitle('movie:8');
    seedClaim('movie:8', 'frank');

    const [item] = planDeletionItems({ username: 'admin', isOperator: true }, [{ titleId: 'movie:8', requestedMode: 'delete_files' }], {
      nowSeconds: NOW,
      onBehalfOf: 'frank',
    });
    expect(item.outcome).toBe('delete');
  });

  it('never writes an audit row (nothing has happened yet)', () => {
    seedMember('frank');
    seedTitle('movie:9');
    seedClaim('movie:9', 'frank');
    planDeletionItems({ username: 'frank', isOperator: false }, [{ titleId: 'movie:9', requestedMode: 'delete_files' }, { titleId: 'movie:ghost', requestedMode: 'delete_files' }], {
      nowSeconds: NOW,
    });
    const rows = getDb().select().from(audit).all();
    expect(rows).toHaveLength(0);
  });
});

describe('planDeletionItems — FR-DEL-21: missing/stale playback data blocks, never silently allows', () => {
  it('an unwatched title previews as BLOCKED (not deletable) when no playback sync has ever run — the exact shape of the deployed bug', () => {
    getDb().delete(syncRun).run(); // undo beforeEach's healthy seed
    seedMember('frank');
    seedTitle('movie:fo-1', { watchedByAnyone: false, lastPlayedAnyAt: null });
    seedClaim('movie:fo-1', 'frank');

    const [item] = planDeletionItems({ username: 'frank', isOperator: false }, [{ titleId: 'movie:fo-1', requestedMode: 'delete_files' }], { nowSeconds: NOW });
    expect(item.outcome).toBe('blocked');
    expect(item.blockedReason).toBe('guard');
    expect(item.guardMessages?.length).toBeGreaterThan(0);
  });

  it('an unwatched title previews as BLOCKED when the only sync_run on record is a FAILED playback step', () => {
    getDb().delete(syncRun).run();
    getDb()
      .insert(syncRun)
      .values({ startedAt: NOW - 65, finishedAt: NOW - 60, steps: JSON.stringify({ playback: { ok: false, count: 0, ms: 5, error: 'attempt to write a readonly database' } }), ok: false })
      .run();
    seedMember('frank');
    seedTitle('movie:fo-2', { watchedByAnyone: false, lastPlayedAnyAt: null });
    seedClaim('movie:fo-2', 'frank');

    const [item] = planDeletionItems({ username: 'frank', isOperator: false }, [{ titleId: 'movie:fo-2', requestedMode: 'delete_files' }], { nowSeconds: NOW });
    expect(item.outcome).toBe('blocked');
  });

  it('an unwatched title previews as BLOCKED when the last successful sync is older than STALE_SNAPSHOT_MAX_AGE_S', () => {
    process.env.STALE_SNAPSHOT_MAX_AGE_S = '3600';
    _resetConfigCacheForTests();
    getDb().delete(syncRun).run();
    seedHealthyPlaybackSync(NOW - 7200); // 2 hours old — stale
    seedMember('frank');
    seedTitle('movie:fo-3', { watchedByAnyone: false, lastPlayedAnyAt: null });
    seedClaim('movie:fo-3', 'frank');

    const [item] = planDeletionItems({ username: 'frank', isOperator: false }, [{ titleId: 'movie:fo-3', requestedMode: 'delete_files' }], { nowSeconds: NOW });
    expect(item.outcome).toBe('blocked');
    delete process.env.STALE_SNAPSHOT_MAX_AGE_S;
  });

  it('a genuinely-fresh, successful sync that observed zero playback is TRUSTED — the fix does not block forever', () => {
    // beforeEach already seeded a fresh healthy sync_run; no override needed.
    seedMember('frank');
    seedTitle('movie:fo-4', { watchedByAnyone: false, lastPlayedAnyAt: null });
    seedClaim('movie:fo-4', 'frank');

    const [item] = planDeletionItems({ username: 'frank', isOperator: false }, [{ titleId: 'movie:fo-4', requestedMode: 'delete_files' }], { nowSeconds: NOW });
    expect(item.outcome).toBe('delete');
  });
});

describe('planDeletionItems — in_progress guard (FR-DEL-4)', () => {
  it('a movie with a resume position and not marked played previews as blocked', () => {
    seedMember('frank');
    seedMember('erin');
    seedTitle('movie:ip-1');
    seedClaim('movie:ip-1', 'frank');
    getDb()
      .insert(playback)
      .values({ titleId: 'movie:ip-1', jellyfinUserId: 'erinjf', playCount: 1, played: false, positionTicks: 12_345, lastPlayedAt: NOW - 5 * DAY, lastSyncedAt: NOW })
      .run();

    const [item] = planDeletionItems({ username: 'frank', isOperator: false }, [{ titleId: 'movie:ip-1', requestedMode: 'delete_files' }], { nowSeconds: NOW });
    expect(item.outcome).toBe('blocked');
    expect(item.blockedReason).toBe('guard');
  });

  it('a movie that is fully played (played: true) does NOT trigger in_progress, even with a nonzero positionTicks left over from a prior watch', () => {
    seedMember('frank');
    seedTitle('movie:ip-2');
    seedClaim('movie:ip-2', 'frank');
    getDb()
      .insert(playback)
      .values({ titleId: 'movie:ip-2', jellyfinUserId: 'someonejf', playCount: 1, played: true, positionTicks: 0, lastPlayedAt: NOW - 100 * DAY, lastSyncedAt: NOW })
      .run();

    const [item] = planDeletionItems({ username: 'frank', isOperator: false }, [{ titleId: 'movie:ip-2', requestedMode: 'delete_files' }], { nowSeconds: NOW });
    expect(item.outcome).toBe('delete');
  });

  it('a series with some but not all episodes watched previews as blocked, with a member message that never names who', () => {
    seedMember('frank');
    seedMember('erin');
    getDb()
      .insert(title)
      .values({
        id: 'series:ip-3',
        mediaType: 'tv',
        arrInstance: 'sonarr',
        arrId: 99,
        title: 'Series ip-3',
        year: 2020,
        sizeBytes: 5000,
        path: '/data/media/tv/series-ip-3',
        watchedByAnyone: true,
        lastPlayedAnyAt: NOW - 200 * DAY, // outside recently_played's window — only in_progress should fire
        lastSyncedAt: NOW - 30,
      })
      .run();
    seedClaim('series:ip-3', 'frank', 5000);
    getDb()
      .insert(playback)
      .values({
        titleId: 'series:ip-3',
        jellyfinUserId: 'erinjf',
        playCount: 3,
        played: true,
        positionTicks: 0,
        episodesPlayed: 3,
        episodesTotal: 10,
        lastPlayedAt: NOW - 10 * DAY,
        lastSyncedAt: NOW,
      })
      .run();

    const [item] = planDeletionItems({ username: 'frank', isOperator: false }, [{ titleId: 'series:ip-3', requestedMode: 'delete_files' }], { nowSeconds: NOW });
    expect(item.outcome).toBe('blocked');
    expect(item.blockedReason).toBe('guard');
    expect(item.guardMessages?.some((m) => m.toLowerCase().includes('partway'))).toBe(true);
    expect(item.guardMessages?.every((m) => !m.includes('erin'))).toBe(true);
  });

  it('a series where the SAME user watched every episode (episodesPlayed === episodesTotal) does NOT trigger in_progress', () => {
    seedMember('frank');
    getDb()
      .insert(title)
      .values({
        id: 'series:ip-4',
        mediaType: 'tv',
        arrInstance: 'sonarr',
        arrId: 98,
        title: 'Series ip-4',
        year: 2020,
        sizeBytes: 5000,
        path: '/data/media/tv/series-ip-4',
        watchedByAnyone: true,
        lastPlayedAnyAt: NOW - 200 * DAY,
        lastSyncedAt: NOW - 30,
      })
      .run();
    seedClaim('series:ip-4', 'frank', 5000);
    getDb()
      .insert(playback)
      .values({
        titleId: 'series:ip-4',
        jellyfinUserId: 'someonejf',
        playCount: 5,
        played: true,
        positionTicks: 0,
        episodesPlayed: 5,
        episodesTotal: 5,
        lastPlayedAt: NOW - 10 * DAY,
        lastSyncedAt: NOW,
      })
      .run();

    const [item] = planDeletionItems({ username: 'frank', isOperator: false }, [{ titleId: 'series:ip-4', requestedMode: 'delete_files' }], { nowSeconds: NOW });
    expect(item.outcome).toBe('delete');
  });

  it('the SAME in-progress title, previewed by an operator, names who (FR-DEL-4a)', () => {
    seedMember('admin');
    getDb()
      .insert(title)
      .values({
        id: 'series:ip-5',
        mediaType: 'tv',
        arrInstance: 'sonarr',
        arrId: 97,
        title: 'Series ip-5',
        year: 2020,
        sizeBytes: 5000,
        path: '/data/media/tv/series-ip-5',
        watchedByAnyone: true,
        lastPlayedAnyAt: NOW - 200 * DAY,
        lastSyncedAt: NOW - 30,
      })
      .run();
    getDb()
      .insert(playback)
      .values({
        titleId: 'series:ip-5',
        jellyfinUserId: 'erinjf',
        playCount: 3,
        played: true,
        positionTicks: 0,
        episodesPlayed: 3,
        episodesTotal: 10,
        lastPlayedAt: NOW - 10 * DAY,
        lastSyncedAt: NOW,
      })
      .run();
    seedMember('erin');
    getDb().update(member).set({ jellyfinUserId: 'erinjf' }).where(eq(member.ssoUsername, 'erin')).run();

    const [item] = planDeletionItems({ username: 'admin', isOperator: true }, [{ titleId: 'series:ip-5', requestedMode: 'delete_files' }], { nowSeconds: NOW });
    expect(item.outcome).toBe('blocked');
    expect(item.guardMessages?.some((m) => m.includes('erin'))).toBe(true);
  });
});
