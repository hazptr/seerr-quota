/**
 * `FR-DEL-25` (the sweeper executes what is due) and `FR-DEL-26` (a deletion
 * that became unsafe DURING the grace window is cancelled, not performed).
 * The second is the whole reason deferral is worth doing, so it gets the most
 * coverage here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { RadarrDeleteClient, SonarrDeleteClient } from '@/lib/deletion/arrActions';
import type { SeerrCleanupClient } from '@/lib/deletion/seerrCleanup';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-deletion-runner-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const { getDb, _resetDbForTests } = await import('@/lib/db');
const { member, title, claim, deletion, audit, syncRun } = await import('@/lib/db/schema');
const { _resetConfigCacheForTests } = await import('@/lib/config');
const { runDueDeletions } = await import('@/lib/deletion/runner');

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const NOW = 1_800_000_000;
const DAY = 86_400;

beforeEach(() => {
  _resetDbForTests();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${tmpDbPath}${suffix}`, { force: true });
  process.env.DELETE_RECENT_PLAY_DAYS = '14';
  process.env.DELETE_MAX_PER_HOUR = '25';
  _resetConfigCacheForTests();
  getDb()
    .insert(syncRun)
    .values({ startedAt: NOW - 65, finishedAt: NOW - 60, steps: JSON.stringify({ playback: { ok: true, count: 1, ms: 5 } }), ok: true })
    .run();
});

function seedMember(ssoUsername: string, isOperator = false): void {
  getDb().insert(member).values({ ssoUsername, entitled: true, isOperator, syncStatus: 'matched', firstSeenAt: NOW - 1000, lastSyncedAt: NOW - 10 }).run();
}

function seedTitle(id: string, opts: Partial<{ sizeBytes: number; protectedTitle: boolean; watchedByAnyone: boolean; lastPlayedAnyAt: number | null; arrId: number }> = {}): void {
  getDb()
    .insert(title)
    .values({
      id, mediaType: 'movie', arrInstance: 'radarr', arrId: opts.arrId ?? 1, title: `Title ${id}`, year: 2020,
      sizeBytes: opts.sizeBytes ?? 1000, path: `/data/${id}`,
      protected: opts.protectedTitle ?? false, protectedReason: null,
      watchedByAnyone: opts.watchedByAnyone ?? false, lastPlayedAnyAt: opts.lastPlayedAnyAt ?? null,
      lastSyncedAt: NOW - 30,
    })
    .run();
}

function seedClaim(titleId: string, ssoUsername: string, chargedBytes = 1000): void {
  getDb().insert(claim).values({ titleId, ssoUsername, seerrRequestId: null, chargedBytes, active: true, createdAt: NOW - 500 }).run();
}

function seedScheduled(ssoUsername: string, titleId: string, scheduledFor: number, bytesClaimed = 1000): number {
  return getDb()
    .insert(deletion)
    .values({ ssoUsername, titleId, mode: 'delete_files', state: 'scheduled', bytesClaimed, requestedAt: scheduledFor - DAY, scheduledFor })
    .returning({ id: deletion.id })
    .get().id;
}

function fakeClients() {
  const calls: number[] = [];
  return {
    calls,
    deps: {
      radarr: { async deleteMovie(id: number) { calls.push(id); return { status: 200 }; } } as unknown as RadarrDeleteClient,
      sonarr: { async deleteSeries() { throw new Error('unused'); } } as unknown as SonarrDeleteClient,
      seerr: { async deleteRequest() { return { status: 204 }; } } as unknown as SeerrCleanupClient,
    },
  };
}

function stateOf(id: number): string {
  return getDb().select({ s: deletion.state }).from(deletion).where(eq(deletion.id, id)).get()!.s;
}

describe('runDueDeletions — FR-DEL-25', () => {
  it('executes a deletion whose grace period has elapsed, and attributes it to the member who scheduled it, not to the sweeper', async () => {
    seedMember('dana');
    seedTitle('movie:1', { arrId: 7, sizeBytes: 4000 });
    seedClaim('movie:1', 'dana', 4000);
    const id = seedScheduled('dana', 'movie:1', NOW - 10);

    const { calls, deps } = fakeClients();
    const result = await runDueDeletions(deps, { nowSeconds: NOW });

    expect(result).toMatchObject({ due: 1, executed: 1 });
    expect(calls).toEqual([7]);
    const row = getDb().select().from(deletion).where(eq(deletion.id, id)).get()!;
    expect(row).toMatchObject({ state: 'done', bytesFreed: 4000, arrStatus: 200, executedAt: NOW });

    const executed = getDb().select().from(audit).where(eq(audit.action, 'delete.executed')).get()!;
    expect(executed.actor).toBe('dana');
    expect(executed.actorRole).toBe('member');
    expect(executed.source).toBe('cron');
  });

  it('leaves a deletion whose grace period has NOT elapsed completely alone — no call, no state change', async () => {
    seedMember('dana');
    seedTitle('movie:1');
    seedClaim('movie:1', 'dana');
    const id = seedScheduled('dana', 'movie:1', NOW + 3600);

    const { calls, deps } = fakeClients();
    const result = await runDueDeletions(deps, { nowSeconds: NOW });

    expect(result.due).toBe(0);
    expect(calls).toEqual([]);
    expect(stateOf(id)).toBe('scheduled');
  });

  it('ignores rows that are no longer `scheduled` (already cancelled), so a cancel really is final', async () => {
    seedMember('dana');
    seedTitle('movie:1');
    seedClaim('movie:1', 'dana');
    const id = seedScheduled('dana', 'movie:1', NOW - 10);
    getDb().update(deletion).set({ state: 'cancelled', cancelledBy: 'dana', cancelledAt: NOW - 5, cancelReason: 'owner_cancelled' }).where(eq(deletion.id, id)).run();

    const { calls, deps } = fakeClients();
    const result = await runDueDeletions(deps, { nowSeconds: NOW });

    expect(result.due).toBe(0);
    expect(calls).toEqual([]);
  });

  it('respects the per-sweep ceiling and drains the oldest-due first', async () => {
    seedMember('dana');
    for (const n of [1, 2, 3]) {
      seedTitle(`movie:${n}`, { arrId: n });
      seedClaim(`movie:${n}`, 'dana');
      seedScheduled('dana', `movie:${n}`, NOW - (10 - n)); // movie:1 oldest-due
    }

    const { calls, deps } = fakeClients();
    const result = await runDueDeletions(deps, { nowSeconds: NOW, limit: 2 });

    expect(result.due).toBe(2);
    expect(calls).toEqual([1, 2]);
  });

  it('groups by owner so two members’ pending deletions are each attributed to their own member', async () => {
    seedMember('dana');
    seedMember('erin');
    seedTitle('movie:1', { arrId: 1 });
    seedTitle('movie:2', { arrId: 2 });
    seedClaim('movie:1', 'dana');
    seedClaim('movie:2', 'erin');
    seedScheduled('dana', 'movie:1', NOW - 20);
    seedScheduled('erin', 'movie:2', NOW - 10);

    const { deps } = fakeClients();
    await runDueDeletions(deps, { nowSeconds: NOW });

    const actors = getDb().select({ a: audit.actor, t: audit.targetId }).from(audit).where(eq(audit.action, 'delete.executed')).all();
    expect(actors).toEqual(expect.arrayContaining([{ a: 'dana', t: 'movie:1' }, { a: 'erin', t: 'movie:2' }]));
  });
});

describe('runDueDeletions — FR-DEL-26: the grace window is a real re-check, not just a delay', () => {
  it('a title someone started watching DURING the window is cancelled, not deleted', async () => {
    seedMember('dana');
    // Scheduled a day ago while nobody had watched it; since then it was played.
    seedTitle('movie:1', { arrId: 5, watchedByAnyone: true, lastPlayedAnyAt: NOW - 3600 });
    seedClaim('movie:1', 'dana');
    const id = seedScheduled('dana', 'movie:1', NOW - 10);

    const { calls, deps } = fakeClients();
    const result = await runDueDeletions(deps, { nowSeconds: NOW });

    expect(calls).toEqual([]);
    expect(result.blocked).toBe(1);
    const row = getDb().select().from(deletion).where(eq(deletion.id, id)).get()!;
    expect(row.state).toBe('cancelled');
    expect(row.cancelledBy).toBe('system');
    expect(row.cancelReason).toMatch(/^guard_blocked_at_execution:/);

    const acted = getDb().select({ a: audit.action }).from(audit).all().map((r) => r.a);
    expect(acted).toContain('delete.cancelled');
    expect(acted).not.toContain('delete.executed');
  });

  it('a title the operator protected during the window is cancelled, not deleted', async () => {
    seedMember('dana');
    seedTitle('movie:1', { arrId: 5, protectedTitle: true });
    seedClaim('movie:1', 'dana');
    const id = seedScheduled('dana', 'movie:1', NOW - 10);

    const { calls, deps } = fakeClients();
    await runDueDeletions(deps, { nowSeconds: NOW });

    expect(calls).toEqual([]);
    expect(stateOf(id)).toBe('cancelled');
  });

  it('FR-DEL-21: if playback data is unavailable at execution time, the deletion is cancelled rather than performed on unknown state', async () => {
    // No successful playback sync on record at all -> every playback-dependent
    // guard fail-safes into blocking.
    getDb().delete(syncRun).run();
    seedMember('dana');
    seedTitle('movie:1', { arrId: 5 });
    seedClaim('movie:1', 'dana');
    const id = seedScheduled('dana', 'movie:1', NOW - 10);

    const { calls, deps } = fakeClients();
    await runDueDeletions(deps, { nowSeconds: NOW });

    expect(calls).toEqual([]);
    expect(stateOf(id)).toBe('cancelled');
  });

  it('a title that gained a second claimant during the window downgrades to a release: the pending DELETE is cancelled and no file is touched', async () => {
    seedMember('dana');
    seedMember('erin');
    seedTitle('movie:1', { arrId: 5 });
    seedClaim('movie:1', 'dana');
    seedClaim('movie:1', 'erin'); // co-requested after dana scheduled hers
    const id = seedScheduled('dana', 'movie:1', NOW - 10);

    const { calls, deps } = fakeClients();
    await runDueDeletions(deps, { nowSeconds: NOW });

    expect(calls).toEqual([]);
    const row = getDb().select().from(deletion).where(eq(deletion.id, id)).get()!;
    expect(row.state).toBe('cancelled');
    expect(row.cancelReason).toBe('downgraded_to_release');
    // Her claim is released instead — she is no longer charged, and erin's is intact.
    const danaClaim = getDb().select().from(claim).where(eq(claim.ssoUsername, 'dana')).get()!;
    expect(danaClaim.active).toBe(false);
    const erinClaim = getDb().select().from(claim).where(eq(claim.ssoUsername, 'erin')).get()!;
    expect(erinClaim.active).toBe(true);
  });

  it('the rate limit is NOT re-charged at execution — a sweep of many due rows is not throttled by the member’s hourly click budget', async () => {
    process.env.DELETE_MAX_PER_HOUR = '1';
    _resetConfigCacheForTests();
    seedMember('dana');
    for (const n of [1, 2, 3]) {
      seedTitle(`movie:${n}`, { arrId: n });
      seedClaim(`movie:${n}`, 'dana');
      seedScheduled('dana', `movie:${n}`, NOW - 10);
    }

    const { calls, deps } = fakeClients();
    const result = await runDueDeletions(deps, { nowSeconds: NOW });

    expect(result.executed).toBe(3);
    expect(calls.sort()).toEqual([1, 2, 3]);
  });
});
