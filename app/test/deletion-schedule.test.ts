/**
 * `FR-DEL-22`/`23`/`27` — confirming a deletion SCHEDULES it. Nothing in this
 * file may cause an arr `DELETE`: the fake clients are wired in precisely so
 * that a regression which starts deleting at confirm time fails loudly here
 * rather than in production.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { RadarrDeleteClient, SonarrDeleteClient } from '@/lib/deletion/arrActions';
import type { SeerrCleanupClient } from '@/lib/deletion/seerrCleanup';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-deletion-schedule-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const { getDb, _resetDbForTests } = await import('@/lib/db');
const { member, title, claim, deletion, audit, syncRun } = await import('@/lib/db/schema');
const { _resetConfigCacheForTests } = await import('@/lib/config');
const { scheduleDeletionBatch } = await import('@/lib/deletion/schedule');
const { getEffectiveUsageBytes, getMemberUsageBytes } = await import('@/lib/enforcement/usage');

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const NOW = 1_800_000_000;
const GRACE = 24 * 60 * 60;

beforeEach(() => {
  _resetDbForTests();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${tmpDbPath}${suffix}`, { force: true });
  process.env.DELETE_RECENT_PLAY_DAYS = '14';
  process.env.DELETE_MAX_PER_HOUR = '25';
  process.env.DELETE_GRACE_PERIOD = '24h';
  _resetConfigCacheForTests();
  getDb()
    .insert(syncRun)
    .values({ startedAt: NOW - 65, finishedAt: NOW - 60, steps: JSON.stringify({ playback: { ok: true, count: 1, ms: 5 } }), ok: true })
    .run();
});

function seedMember(ssoUsername: string, isOperator = false): void {
  getDb().insert(member).values({ ssoUsername, entitled: true, isOperator, syncStatus: 'matched', firstSeenAt: NOW - 1000, lastSyncedAt: NOW - 10 }).run();
}

function seedTitle(id: string, opts: Partial<{ sizeBytes: number; protectedTitle: boolean; watchedByAnyone: boolean; lastPlayedAnyAt: number | null }> = {}): void {
  getDb()
    .insert(title)
    .values({
      id,
      mediaType: 'movie',
      arrInstance: 'radarr',
      arrId: Number(id.replace(/\D/g, '')) || 1,
      title: `Title ${id}`,
      year: 2020,
      sizeBytes: opts.sizeBytes ?? 1000,
      path: `/data/media/movies/${id}`,
      protected: opts.protectedTitle ?? false,
      protectedReason: null,
      watchedByAnyone: opts.watchedByAnyone ?? false,
      lastPlayedAnyAt: opts.lastPlayedAnyAt ?? null,
      lastSyncedAt: NOW - 30,
    })
    .run();
}

function seedClaim(titleId: string, ssoUsername: string, chargedBytes = 1000): void {
  getDb().insert(claim).values({ titleId, ssoUsername, seerrRequestId: null, chargedBytes, active: true, createdAt: NOW - 500 }).run();
}

/** Every arr/seerr method throws — any call at all is a test failure, which is the point. */
function forbiddenClients() {
  const boom = (what: string) => () => {
    throw new Error(`scheduling must never call ${what}`);
  };
  return {
    radarr: { deleteMovie: boom('radarr.deleteMovie') } as unknown as RadarrDeleteClient,
    sonarr: { deleteSeries: boom('sonarr.deleteSeries') } as unknown as SonarrDeleteClient,
    seerr: { deleteRequest: boom('seerr.deleteRequest') } as unknown as SeerrCleanupClient,
  };
}

function actions(titleId: string): string[] {
  return getDb().select({ action: audit.action }).from(audit).where(eq(audit.targetId, titleId)).all().map((r) => r.action);
}

describe('scheduleDeletionBatch — FR-DEL-22', () => {
  it('a sole claimant confirming a delete gets a pending row, not a deletion: state=scheduled, scheduled_for = now + grace, and NO arr call', async () => {
    seedMember('dana');
    seedTitle('movie:1', { sizeBytes: 5000 });
    seedClaim('movie:1', 'dana', 5000);

    const result = await scheduleDeletionBatch({ username: 'dana', isOperator: false }, [{ titleId: 'movie:1', requestedMode: 'delete_files' }], forbiddenClients(), {
      nowSeconds: NOW,
    });

    expect(result.summary).toMatchObject({ total: 1, scheduled: 1 });
    expect(result.items[0]).toMatchObject({ titleId: 'movie:1', outcome: 'scheduled', scheduledFor: NOW + GRACE, bytesClaimed: 5000 });

    const rows = getDb().select().from(deletion).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'scheduled', mode: 'delete_files', scheduledFor: NOW + GRACE, executedAt: null, bytesFreed: null });
  });

  it('writes delete.requested AND delete.scheduled, and no delete.executed', async () => {
    seedMember('dana');
    seedTitle('movie:1');
    seedClaim('movie:1', 'dana');

    await scheduleDeletionBatch({ username: 'dana', isOperator: false }, [{ titleId: 'movie:1', requestedMode: 'delete_files' }], forbiddenClients(), { nowSeconds: NOW });

    const acted = actions('movie:1');
    expect(acted).toContain('delete.requested');
    expect(acted).toContain('delete.scheduled');
    expect(acted).not.toContain('delete.executed');
  });

  it('FR-DEL-27: the bytes are credited back immediately — effective usage drops at schedule time while raw claim usage does not', async () => {
    seedMember('dana');
    seedTitle('movie:1', { sizeBytes: 400 });
    seedTitle('movie:2', { sizeBytes: 600 });
    seedClaim('movie:1', 'dana', 400);
    seedClaim('movie:2', 'dana', 600);

    expect(getEffectiveUsageBytes(getDb(), 'dana')).toBe(1000);

    await scheduleDeletionBatch({ username: 'dana', isOperator: false }, [{ titleId: 'movie:2', requestedMode: 'delete_files' }], forbiddenClients(), { nowSeconds: NOW });

    // The claim is untouched — the files are still on disk and attribution
    // still says they are hers. Only the effective number moves.
    expect(getMemberUsageBytes(getDb(), 'dana')).toBe(1000);
    expect(getEffectiveUsageBytes(getDb(), 'dana')).toBe(400);
  });

  it('FR-DEL-23: a release is NOT scheduled — it completes inline and the claim goes inactive immediately', async () => {
    seedMember('dana');
    seedMember('erin');
    seedTitle('movie:1', { sizeBytes: 800 });
    seedClaim('movie:1', 'dana', 800);
    seedClaim('movie:1', 'erin', 800);

    const result = await scheduleDeletionBatch({ username: 'dana', isOperator: false }, [{ titleId: 'movie:1', requestedMode: 'release_claim' }], forbiddenClients(), {
      nowSeconds: NOW,
    });

    expect(result.items[0].outcome).toBe('released');
    const rows = getDb().select().from(deletion).all();
    expect(rows[0]).toMatchObject({ mode: 'release_claim', state: 'done' });
    expect(rows[0].scheduledFor).toBeNull();

    const claims = getDb().select().from(claim).where(eq(claim.ssoUsername, 'dana')).all();
    expect(claims[0].active).toBe(false);
  });

  it('a protected title is blocked at schedule time — no pending row is created', async () => {
    seedMember('dana');
    seedTitle('movie:1', { protectedTitle: true });
    seedClaim('movie:1', 'dana');

    const result = await scheduleDeletionBatch({ username: 'dana', isOperator: false }, [{ titleId: 'movie:1', requestedMode: 'delete_files' }], forbiddenClients(), {
      nowSeconds: NOW,
    });

    expect(result.items[0]).toMatchObject({ outcome: 'blocked', blockedReason: 'protected' });
    expect(getDb().select().from(deletion).all()[0].state).toBe('blocked');
  });

  it('FR-DEL-14: a title the actor does not claim is unauthorized and creates nothing', async () => {
    seedMember('dana');
    seedMember('erin');
    seedTitle('movie:1');
    seedClaim('movie:1', 'erin');

    const result = await scheduleDeletionBatch({ username: 'dana', isOperator: false }, [{ titleId: 'movie:1', requestedMode: 'delete_files' }], forbiddenClients(), {
      nowSeconds: NOW,
    });

    expect(result.items[0].outcome).toBe('unauthorized');
    expect(getDb().select().from(deletion).all()).toHaveLength(0);
    expect(actions('movie:1')).toEqual(['access.denied']);
  });

  it('FR-DEL-15: an unrecognised mode fails closed at schedule time too', async () => {
    seedMember('dana');
    seedTitle('movie:1');
    seedClaim('movie:1', 'dana');

    const result = await scheduleDeletionBatch(
      { username: 'dana', isOperator: false },
      [{ titleId: 'movie:1', requestedMode: 'wipe_everything' as never }],
      forbiddenClients(),
      { nowSeconds: NOW },
    );

    expect(result.items[0].outcome).toBe('invalid_mode');
    expect(getDb().select().from(deletion).all()).toHaveLength(0);
  });

  it('FR-DEL-12: the rate limit is charged at schedule time, and pending rows count toward it', async () => {
    process.env.DELETE_MAX_PER_HOUR = '2';
    _resetConfigCacheForTests();
    seedMember('dana');
    for (const n of [1, 2, 3]) {
      seedTitle(`movie:${n}`);
      seedClaim(`movie:${n}`, 'dana');
    }

    const result = await scheduleDeletionBatch(
      { username: 'dana', isOperator: false },
      [1, 2, 3].map((n) => ({ titleId: `movie:${n}`, requestedMode: 'delete_files' as const })),
      forbiddenClients(),
      { nowSeconds: NOW },
    );

    expect(result.summary.scheduled).toBe(2);
    expect(result.summary.rateLimited).toBe(1);
  });

  it('FR-DEL-8: a duplicate titleId in one batch reserves one pending row, not two', async () => {
    seedMember('dana');
    seedTitle('movie:1');
    seedClaim('movie:1', 'dana');

    const result = await scheduleDeletionBatch(
      { username: 'dana', isOperator: false },
      [
        { titleId: 'movie:1', requestedMode: 'delete_files' },
        { titleId: 'movie:1', requestedMode: 'delete_files' },
      ],
      forbiddenClients(),
      { nowSeconds: NOW },
    );

    expect(result.items).toHaveLength(1);
    expect(getDb().select().from(deletion).all()).toHaveLength(1);
  });

  it('DELETE_GRACE_PERIOD=0 restores immediate-eligibility: scheduled_for equals now, so the very next sweep runs it', async () => {
    process.env.DELETE_GRACE_PERIOD = '0s';
    _resetConfigCacheForTests();
    seedMember('dana');
    seedTitle('movie:1');
    seedClaim('movie:1', 'dana');

    const result = await scheduleDeletionBatch({ username: 'dana', isOperator: false }, [{ titleId: 'movie:1', requestedMode: 'delete_files' }], forbiddenClients(), {
      nowSeconds: NOW,
    });

    expect(result.items[0].scheduledFor).toBe(NOW);
    expect(result.gracePeriodSeconds).toBe(0);
  });
});
