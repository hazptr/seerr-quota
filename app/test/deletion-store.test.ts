import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-deletion-store-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const { getDb, _resetDbForTests } = await import('@/lib/db');
const { member, title, claim, deletion, audit } = await import('@/lib/db/schema');
const {
  loadFreshTitleClaimStates,
  countRecentFileDeletions,
  insertDeletionRow,
  markDeletionDone,
  markDeletionFailed,
  markDeletionPartialFailure,
  releaseClaimWithAudit,
  reserveFileDeletionSlot,
} = await import('@/lib/deletion/deletionStore');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const NOW = 1_800_000_000;

beforeEach(() => {
  _resetDbForTests();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${tmpDbPath}${suffix}`, { force: true });
});

function seedMember(ssoUsername: string): void {
  getDb()
    .insert(member)
    .values({ ssoUsername, entitled: true, isOperator: false, syncStatus: 'matched', firstSeenAt: NOW - 1000, lastSyncedAt: NOW - 10 })
    .run();
}

function seedTitle(id: string, opts: Partial<{ sizeBytes: number; protectedTitle: boolean; protectedReason: string | null; watchedByAnyone: boolean; lastPlayedAnyAt: number | null }> = {}): void {
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
      watchedByAnyone: opts.watchedByAnyone ?? false,
      lastPlayedAnyAt: opts.lastPlayedAnyAt ?? null,
      lastSyncedAt: NOW - 30,
    })
    .run();
}

function seedClaim(titleId: string, ssoUsername: string, chargedBytes: number, seerrRequestId: number | null = null): number {
  const row = getDb()
    .insert(claim)
    .values({ titleId, ssoUsername, seerrRequestId, chargedBytes, active: true, createdAt: NOW - 500 })
    .returning({ id: claim.id })
    .get();
  return row.id;
}

describe('loadFreshTitleClaimStates', () => {
  it('an unknown title id resolves to exists:false with every other field at its zero value', () => {
    const states = loadFreshTitleClaimStates(getDb(), 'frank', ['movie:missing']);
    const state = states.get('movie:missing')!;
    expect(state.exists).toBe(false);
    expect(state.hasActiveClaim).toBe(false);
    expect(state.activeClaimantCount).toBe(0);
  });

  it('reads the subject own claim and the total active claimant count', () => {
    seedMember('frank');
    seedMember('dana');
    seedTitle('movie:1', { sizeBytes: 5000 });
    seedClaim('movie:1', 'frank', 5000, 42);
    seedClaim('movie:1', 'dana', 5000);

    const states = loadFreshTitleClaimStates(getDb(), 'frank', ['movie:1']);
    const state = states.get('movie:1')!;
    expect(state.exists).toBe(true);
    expect(state.hasActiveClaim).toBe(true);
    expect(state.activeClaimantCount).toBe(2);
    expect(state.chargedBytes).toBe(5000);
    expect(state.seerrRequestId).toBe(42);
  });

  it('a title the subject does not claim has hasActiveClaim:false even though other members claim it', () => {
    seedMember('frank');
    seedMember('dana');
    seedTitle('movie:2');
    seedClaim('movie:2', 'dana', 1000);

    const states = loadFreshTitleClaimStates(getDb(), 'frank', ['movie:2']);
    const state = states.get('movie:2')!;
    expect(state.exists).toBe(true);
    expect(state.hasActiveClaim).toBe(false);
    expect(state.activeClaimantCount).toBe(1); // dana's claim still counts toward the total
  });

  it('a released (inactive) claim is not counted at all', () => {
    seedMember('frank');
    seedTitle('movie:3');
    const claimId = seedClaim('movie:3', 'frank', 1000);
    getDb().update(claim).set({ active: false, releasedAt: NOW, releasedBy: 'frank' }).where(eq(claim.id, claimId)).run();

    const states = loadFreshTitleClaimStates(getDb(), 'frank', ['movie:3']);
    const state = states.get('movie:3')!;
    expect(state.hasActiveClaim).toBe(false);
    expect(state.activeClaimantCount).toBe(0);
  });

  it('reads protected + playback convenience columns', () => {
    seedTitle('movie:4', { protectedTitle: true, protectedReason: 'pinned by operator', watchedByAnyone: true, lastPlayedAnyAt: NOW - 100 });
    const states = loadFreshTitleClaimStates(getDb(), 'frank', ['movie:4']);
    const state = states.get('movie:4')!;
    expect(state.protectedTitle).toBe(true);
    expect(state.protectedReason).toBe('pinned by operator');
    expect(state.watchedByAnyone).toBe(true);
    expect(state.lastPlayedAnyAt).toBe(NOW - 100);
  });
});

// ---------------------------------------------------------------------------
// FR-DEL-20 — claimant counting is over DISTINCT members, and duplicates are
// rejected outright at the DB layer
// ---------------------------------------------------------------------------

describe('FR-DEL-20 — the claim_title_sso_active_unique partial index', () => {
  it('rejects a second ACTIVE claim for the same (title, member) pair outright', () => {
    seedMember('frank');
    seedTitle('movie:dup');
    seedClaim('movie:dup', 'frank', 1000);

    expect(() => seedClaim('movie:dup', 'frank', 1000)).toThrow(/UNIQUE constraint failed/i);
  });

  it('does NOT reject a second claim for the same pair once the first is released (only ACTIVE rows are unique)', () => {
    seedMember('frank');
    seedTitle('movie:reclaim');
    const firstId = seedClaim('movie:reclaim', 'frank', 1000);
    getDb().update(claim).set({ active: false, releasedAt: NOW, releasedBy: 'frank' }).where(eq(claim.id, firstId)).run();

    expect(() => seedClaim('movie:reclaim', 'frank', 1000)).not.toThrow();
  });
});

describe('FR-DEL-20 — loadFreshTitleClaimStates counts DISTINCT active claimants, not rows', () => {
  it('two distinct members each with one active claim count as 2 (sanity — already covered indirectly above, pinned explicitly here)', () => {
    seedMember('frank');
    seedMember('dana');
    seedTitle('movie:two-distinct');
    seedClaim('movie:two-distinct', 'frank', 1000);
    seedClaim('movie:two-distinct', 'dana', 1000);

    const states = loadFreshTitleClaimStates(getDb(), 'frank', ['movie:two-distinct']);
    expect(states.get('movie:two-distinct')!.activeClaimantCount).toBe(2);
  });

  it('a duplicate ACTIVE row for the SAME member is counted ONCE, not twice — defense in depth if the unique index is ever bypassed', () => {
    // The `claim_title_sso_active_unique` partial index above is the primary
    // defense (FR-DEL-20) and makes this state unreachable through this
    // app's own write paths. This test drops that index deliberately, to
    // prove `loadFreshTitleClaimStates`'s counting logic ITSELF does not
    // regress into "count rows" if some future writer or a schema mistake
    // ever lets a duplicate through anyway — a duplicate active row for a
    // SOLE claimant must never present as a co-claimant and hand them the
    // release FR-DEL-2 forbids.
    getDb().run('DROP INDEX claim_title_sso_active_unique');
    seedMember('frank');
    seedTitle('movie:dup-row');
    seedClaim('movie:dup-row', 'frank', 1000);
    seedClaim('movie:dup-row', 'frank', 1000); // a second ACTIVE row for the SAME (title, member) pair

    const rawRows = getDb().select().from(claim).where(eq(claim.titleId, 'movie:dup-row')).all();
    expect(rawRows).toHaveLength(2); // confirms the duplicate really exists at the row level

    const states = loadFreshTitleClaimStates(getDb(), 'frank', ['movie:dup-row']);
    const state = states.get('movie:dup-row')!;
    expect(state.hasActiveClaim).toBe(true);
    expect(state.activeClaimantCount).toBe(1); // ONE distinct member, not 2 rows — sole claimant, not an apparent co-claimant
  });
});

describe('deletion table read/write helpers', () => {
  it('insertDeletionRow + markDeletionDone round-trips', () => {
    seedTitle('movie:5');
    const db = getDb();
    const id = insertDeletionRow(db, { ssoUsername: 'frank', titleId: 'movie:5', mode: 'delete_files', state: 'executing', bytesClaimed: 1000, requestedAt: NOW });
    markDeletionDone(db, id, { bytesFreed: 1000, arrCall: 'http://radarr/api/v3/movie/1', arrStatus: 200, executedAt: NOW + 1 });
    const [row] = db.select().from(deletion).all();
    expect(row.state).toBe('done');
    expect(row.bytesFreed).toBe(1000);
  });

  it('markDeletionFailed sets state=failed and records the error', () => {
    seedTitle('movie:6');
    const db = getDb();
    const id = insertDeletionRow(db, { ssoUsername: 'frank', titleId: 'movie:6', mode: 'delete_files', state: 'executing', bytesClaimed: 1000, requestedAt: NOW });
    markDeletionFailed(db, id, { arrCall: 'http://radarr/api/v3/movie/2', arrStatus: 500, error: 'radarr 500', executedAt: NOW + 1 });
    const [row] = db.select().from(deletion).all();
    expect(row.state).toBe('failed');
    expect(row.error).toBe('radarr 500');
  });

  it('markDeletionPartialFailure keeps state=done (files WERE removed) but records the seerr cleanup error', () => {
    seedTitle('movie:7');
    const db = getDb();
    const id = insertDeletionRow(db, { ssoUsername: 'frank', titleId: 'movie:7', mode: 'delete_files', state: 'executing', bytesClaimed: 1000, requestedAt: NOW });
    markDeletionDone(db, id, { bytesFreed: 1000, arrCall: 'http://radarr/api/v3/movie/3', arrStatus: 200, executedAt: NOW + 1 });
    markDeletionPartialFailure(db, id, 'seerr cleanup failed: 500');
    const [row] = db.select().from(deletion).all();
    expect(row.state).toBe('done'); // NOT failed — this is the whole point
    expect(row.error).toBe('seerr cleanup failed: 500');
    expect(row.bytesFreed).toBe(1000); // untouched
  });

  it('countRecentFileDeletions counts only delete_files rows that reached the arr call, within the window, for that subject', () => {
    for (const id of ['movie:a', 'movie:b', 'movie:c', 'movie:d', 'movie:e', 'movie:f']) seedTitle(id);
    const db = getDb();
    // Counts: executing/done/failed, mode=delete_files, subject=frank, within window.
    insertDeletionRow(db, { ssoUsername: 'frank', titleId: 'movie:a', mode: 'delete_files', state: 'done', bytesClaimed: 1, requestedAt: NOW - 100 });
    const failedId = insertDeletionRow(db, { ssoUsername: 'frank', titleId: 'movie:b', mode: 'delete_files', state: 'executing', bytesClaimed: 1, requestedAt: NOW - 200 });
    markDeletionFailed(db, failedId, { arrCall: null, arrStatus: null, error: 'boom', executedAt: NOW - 199 });
    // Does NOT count: blocked (never reached the arr call).
    insertDeletionRow(db, { ssoUsername: 'frank', titleId: 'movie:c', mode: 'delete_files', state: 'blocked', bytesClaimed: 1, requestedAt: NOW - 50 });
    // Does NOT count: release_claim (not a "title deletion").
    insertDeletionRow(db, { ssoUsername: 'frank', titleId: 'movie:d', mode: 'release_claim', state: 'done', bytesClaimed: 1, requestedAt: NOW - 50 });
    // Does NOT count: outside the window.
    insertDeletionRow(db, { ssoUsername: 'frank', titleId: 'movie:e', mode: 'delete_files', state: 'done', bytesClaimed: 1, requestedAt: NOW - 10_000 });
    // Does NOT count: a different subject.
    insertDeletionRow(db, { ssoUsername: 'dana', titleId: 'movie:f', mode: 'delete_files', state: 'done', bytesClaimed: 1, requestedAt: NOW - 50 });

    const count = countRecentFileDeletions(db, 'frank', NOW - 3600);
    expect(count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// FR-DEL-17 — reserveFileDeletionSlot: count-and-reserve is one atomic unit
// ---------------------------------------------------------------------------

describe('reserveFileDeletionSlot (FR-DEL-17)', () => {
  it('reserves (inserts an executing row) and returns its id when under the limit', () => {
    seedTitle('movie:res-1');
    const db = getDb();
    const id = reserveFileDeletionSlot(db, { ssoUsername: 'frank', titleId: 'movie:res-1', bytesClaimed: 1000, requestedAt: NOW }, NOW - 3600, 5);
    expect(id).not.toBeNull();
    const [row] = db.select().from(deletion).all();
    expect(row.id).toBe(id);
    expect(row.state).toBe('executing');
    expect(row.mode).toBe('delete_files');
  });

  it('returns null and inserts NOTHING when already at the limit', () => {
    seedTitle('movie:res-2');
    const db = getDb();
    insertDeletionRow(db, { ssoUsername: 'frank', titleId: 'movie:res-2', mode: 'delete_files', state: 'done', bytesClaimed: 1, requestedAt: NOW - 10 });
    const before = db.select().from(deletion).all().length;

    const id = reserveFileDeletionSlot(db, { ssoUsername: 'frank', titleId: 'movie:res-2', bytesClaimed: 1000, requestedAt: NOW }, NOW - 3600, 1);

    expect(id).toBeNull();
    expect(db.select().from(deletion).all()).toHaveLength(before); // nothing reserved
  });

  it('each successive call sees the PREVIOUS call\'s reservation — the count is never read stale across calls on the same db handle', () => {
    for (const id of ['movie:res-3a', 'movie:res-3b', 'movie:res-3c']) seedTitle(id);
    const db = getDb();
    const id1 = reserveFileDeletionSlot(db, { ssoUsername: 'frank', titleId: 'movie:res-3a', bytesClaimed: 1, requestedAt: NOW }, NOW - 3600, 2);
    const id2 = reserveFileDeletionSlot(db, { ssoUsername: 'frank', titleId: 'movie:res-3b', bytesClaimed: 1, requestedAt: NOW }, NOW - 3600, 2);
    const id3 = reserveFileDeletionSlot(db, { ssoUsername: 'frank', titleId: 'movie:res-3c', bytesClaimed: 1, requestedAt: NOW }, NOW - 3600, 2);

    expect(id1).not.toBeNull();
    expect(id2).not.toBeNull();
    expect(id3).toBeNull(); // limit 2 already reached by id1 + id2
  });
});

describe('releaseClaimWithAudit', () => {
  it('deactivates the claim and writes exactly one claim.released audit row, sharing the given correlationId, in one transaction', () => {
    seedMember('frank');
    seedTitle('movie:8');
    const claimId = seedClaim('movie:8', 'frank', 1000);

    releaseClaimWithAudit(
      getDb(),
      {
        correlationId: 'batch-xyz',
        actorUsername: 'frank',
        actorRole: 'member',
        source: 'ui',
        titleId: 'movie:8',
        claimId,
        chargedBytes: 1000,
        remainingActiveClaimants: 0,
        downgradedFromDelete: false,
        requestedMode: 'release_claim',
      },
      NOW,
    );

    const [claimRow] = getDb().select().from(claim).all();
    expect(claimRow.active).toBe(false);
    expect(claimRow.releasedAt).toBe(NOW);
    expect(claimRow.releasedBy).toBe('frank');

    const auditRows = getDb().select().from(audit).all();
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].action).toBe('claim.released');
    expect(auditRows[0].correlationId).toBe('batch-xyz');
    expect(auditRows[0].outcome).toBe('ok');
  });

  it('records on_behalf_of when an operator releases for a member', () => {
    seedMember('dana');
    seedTitle('movie:9');
    const claimId = seedClaim('movie:9', 'dana', 1000);

    releaseClaimWithAudit(
      getDb(),
      {
        correlationId: 'batch-op',
        actorUsername: 'admin',
        actorRole: 'operator',
        onBehalfOf: 'dana',
        source: 'ui',
        titleId: 'movie:9',
        claimId,
        chargedBytes: 1000,
        remainingActiveClaimants: 0,
        downgradedFromDelete: false,
        requestedMode: 'release_claim',
      },
      NOW,
    );

    const [auditRow] = getDb().select().from(audit).all();
    expect(auditRow.actor).toBe('admin');
    expect(auditRow.onBehalfOf).toBe('dana');
    // releasedBy records the real actor (the operator), not the subject.
    const [claimRow] = getDb().select().from(claim).all();
    expect(claimRow.releasedBy).toBe('admin');
  });
});
