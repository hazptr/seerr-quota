import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { UpstreamError } from '@/lib/http/client';
import type { RadarrDeleteClient } from '@/lib/deletion/arrActions';
import type { SonarrDeleteClient } from '@/lib/deletion/arrActions';
import type { SeerrCleanupClient } from '@/lib/deletion/seerrCleanup';

// Isolated throwaway DB — same pattern as test/enforcement-process.test.ts.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-deletion-execute-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;
process.env.DELETE_RECENT_PLAY_DAYS = '14';
process.env.DELETE_MAX_PER_HOUR = '25';

const { getDb, _resetDbForTests } = await import('@/lib/db');
const { member, title, claim, deletion, audit, playback, syncRun } = await import('@/lib/db/schema');
const { _resetConfigCacheForTests } = await import('@/lib/config');
const { executeDeletionBatch } = await import('@/lib/deletion/execute');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const NOW = 1_800_000_000;
const DAY = 86_400;

/**
 * FR-DEL-21: every playback-dependent guard now blocks (unavailable: true)
 * unless a RECENT, SUCCESSFUL playback sync is on record — see
 * `test/deletion-guards.test.ts` for the guard-level unit tests. Every other
 * test in this file seeds a healthy sync in `beforeEach` so its
 * guard-evaluation scenarios exercise what they were originally written to
 * exercise, not the (now correct) fail-safe block; the dedicated
 * "FR-DEL-21" describe block below overrides this to exercise its absence.
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
  process.env.DELETE_RECENT_PLAY_DAYS = '14';
  process.env.DELETE_MAX_PER_HOUR = '25';
  _resetConfigCacheForTests();
  seedHealthyPlaybackSync();
});

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function seedMember(ssoUsername: string, isOperator = false): void {
  getDb()
    .insert(member)
    .values({ ssoUsername, entitled: true, isOperator, syncStatus: 'matched', firstSeenAt: NOW - 1000, lastSyncedAt: NOW - 10 })
    .run();
}

function seedTitle(
  id: string,
  opts: Partial<{
    sizeBytes: number;
    protectedTitle: boolean;
    protectedReason: string | null;
    watchedByAnyone: boolean;
    lastPlayedAnyAt: number | null;
    arrInstance: 'radarr' | 'sonarr';
    arrId: number;
  }> = {},
): void {
  getDb()
    .insert(title)
    .values({
      id,
      mediaType: opts.arrInstance === 'sonarr' ? 'tv' : 'movie',
      arrInstance: opts.arrInstance ?? 'radarr',
      arrId: opts.arrId ?? 1,
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

function seedClaim(titleId: string, ssoUsername: string, chargedBytes = 1000, seerrRequestId: number | null = null): number {
  const row = getDb()
    .insert(claim)
    .values({ titleId, ssoUsername, seerrRequestId, chargedBytes, active: true, createdAt: NOW - 500 })
    .returning({ id: claim.id })
    .get();
  return row.id;
}

interface FakeArrCalls {
  radarrDeleteMovie: number[];
  sonarrDeleteSeries: number[];
}

function createFakeArrClients(opts: { radarrFailIds?: Set<number>; sonarrFailIds?: Set<number> } = {}) {
  const calls: FakeArrCalls = { radarrDeleteMovie: [], sonarrDeleteSeries: [] };
  const radarr = {
    async deleteMovie(id: number) {
      calls.radarrDeleteMovie.push(id);
      if (opts.radarrFailIds?.has(id)) {
        throw new UpstreamError('http_error', 'radarr', 'DELETE', `/api/v3/movie/${id}`, 'radarr DELETE -> HTTP 500', { status: 500 });
      }
      return { status: 200 };
    },
  };
  const sonarr = {
    async deleteSeries(id: number) {
      calls.sonarrDeleteSeries.push(id);
      if (opts.sonarrFailIds?.has(id)) {
        throw new UpstreamError('http_error', 'sonarr', 'DELETE', `/api/v3/series/${id}`, 'sonarr DELETE -> HTTP 500', { status: 500 });
      }
      return { status: 200 };
    },
  };
  return {
    radarr: radarr as unknown as RadarrDeleteClient,
    sonarr: sonarr as unknown as SonarrDeleteClient,
    calls,
  };
}

function createFakeSeerrCleanup(opts: { failRequestIds?: Set<number> } = {}) {
  const calls: number[] = [];
  const seerr = {
    async deleteRequest(id: number) {
      calls.push(id);
      if (opts.failRequestIds?.has(id)) {
        throw new UpstreamError('http_error', 'seerr', 'DELETE', `/api/v1/request/${id}`, 'seerr DELETE -> HTTP 500', { status: 500 });
      }
      return { status: 204 };
    },
  };
  return { seerr: seerr as unknown as SeerrCleanupClient, calls };
}

function auditRowsFor(titleId: string): Array<{ action: string; outcome: string; correlationId: string }> {
  return getDb()
    .select({ action: audit.action, outcome: audit.outcome, correlationId: audit.correlationId })
    .from(audit)
    .where(eq(audit.targetId, titleId))
    .all();
}

function claimRow(titleId: string, ssoUsername: string) {
  return getDb()
    .select()
    .from(claim)
    .where(eq(claim.titleId, titleId))
    .all()
    .find((c) => c.ssoUsername === ssoUsername);
}

// ---------------------------------------------------------------------------
// FR-DEL-1 / FR-DEL-14 — the IDOR guard
// ---------------------------------------------------------------------------

describe('executeDeletionBatch — the IDOR guard (FR-DEL-1 / FR-DEL-14)', () => {
  it('a member cannot delete a title they do not claim, by directly POSTing its id — 403-equivalent, nothing deleted, one audit row', async () => {
    seedMember('frank');
    seedMember('dana');
    seedTitle('movie:1', { sizeBytes: 5000 });
    seedClaim('movie:1', 'dana', 5000); // frank has NO claim

    const { radarr, sonarr, calls } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();

    const result = await executeDeletionBatch(
      { username: 'frank', isOperator: false },
      [{ titleId: 'movie:1', requestedMode: 'delete_files' }],
      { radarr, sonarr, seerr },
      { nowSeconds: NOW },
    );

    expect(result.items[0]).toMatchObject({ titleId: 'movie:1', outcome: 'unauthorized' });
    expect(calls.radarrDeleteMovie).toHaveLength(0);
    // dana's claim is completely untouched.
    expect(claimRow('movie:1', 'dana')?.active).toBe(true);
    expect(claimRow('movie:1', 'dana')?.chargedBytes).toBe(5000);

    const rows = auditRowsFor('movie:1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'access.denied', outcome: 'denied' });
  });

  it('a guessed/fabricated title id that does not exist at all produces the SAME unauthorized outcome — no information leak about validity', async () => {
    seedMember('frank');
    const { radarr, sonarr } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();

    const result = await executeDeletionBatch(
      { username: 'frank', isOperator: false },
      [{ titleId: 'movie:does-not-exist', requestedMode: 'delete_files' }],
      { radarr, sonarr, seerr },
      { nowSeconds: NOW },
    );

    expect(result.items[0]).toMatchObject({ outcome: 'unauthorized' });
    const rows = auditRowsFor('movie:does-not-exist');
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('access.denied');
  });

  it('re-derives authorization fresh at execute time — a claim active at "review" but released before "confirm" is unauthorized at execute, not honored from a stale plan', async () => {
    seedMember('frank');
    seedTitle('movie:2', { sizeBytes: 1000 });
    const claimId = seedClaim('movie:2', 'frank', 1000);
    // Simulates the claim having been released between review and confirm.
    getDb().update(claim).set({ active: false, releasedAt: NOW - 10, releasedBy: 'frank' }).where(eq(claim.id, claimId)).run();

    const { radarr, sonarr, calls } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();

    const result = await executeDeletionBatch(
      { username: 'frank', isOperator: false },
      [{ titleId: 'movie:2', requestedMode: 'delete_files' }],
      { radarr, sonarr, seerr },
      { nowSeconds: NOW },
    );

    expect(result.items[0].outcome).toBe('unauthorized');
    expect(calls.radarrDeleteMovie).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// FR-DEL-15 — fail closed on an unrecognised mode. The exact defect a
// review demonstrated: a SOLE claimant sending `requestedMode: 'release'`
// (a typo for `'release_claim'`) fell through the old
// `if (requestedMode === 'release_claim') {...} else {...delete_files...}`
// shape straight into the destructive branch, and their files were deleted.
// ---------------------------------------------------------------------------

describe('executeDeletionBatch — FR-DEL-15: unrecognised mode fails closed, never falls through to delete_files', () => {
  it("a sole claimant's typo'd mode ('release' instead of 'release_claim') is REFUSED — files are NOT deleted", async () => {
    seedMember('frank');
    seedTitle('movie:typo', { sizeBytes: 5000, arrId: 1 });
    seedClaim('movie:typo', 'frank', 5000);

    const { radarr, sonarr, calls } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();

    const result = await executeDeletionBatch(
      { username: 'frank', isOperator: false },
      [{ titleId: 'movie:typo', requestedMode: 'release' as unknown as 'release_claim' }],
      { radarr, sonarr, seerr },
      { nowSeconds: NOW },
    );

    expect(result.items[0].outcome).toBe('invalid_mode');
    // The whole point: NO *arr call, ever, for an unrecognised instruction.
    expect(calls.radarrDeleteMovie).toHaveLength(0);
    expect(calls.sonarrDeleteSeries).toHaveLength(0);
    // Her claim is completely untouched — neither deleted nor released.
    expect(claimRow('movie:typo', 'frank')?.active).toBe(true);
    expect(claimRow('movie:typo', 'frank')?.chargedBytes).toBe(5000);

    // Audited as a denial, no deletion row at all (no delete.requested).
    const rows = auditRowsFor('movie:typo');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'access.denied', outcome: 'denied' });
    const [deletionRows] = [getDb().select().from(deletion).where(eq(deletion.titleId, 'movie:typo')).all()];
    expect(deletionRows).toHaveLength(0);
  });

  it('an OMITTED requestedMode is ALSO refused, not defaulted to delete — same sole-claimant scenario', async () => {
    seedMember('frank');
    seedTitle('movie:missing-mode', { sizeBytes: 5000, arrId: 1 });
    seedClaim('movie:missing-mode', 'frank', 5000);

    const { radarr, sonarr, calls } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();

    const result = await executeDeletionBatch(
      { username: 'frank', isOperator: false },
      [{ titleId: 'movie:missing-mode' } as unknown as { titleId: string; requestedMode: 'delete_files' }],
      { radarr, sonarr, seerr },
      { nowSeconds: NOW },
    );

    expect(result.items[0].outcome).toBe('invalid_mode');
    expect(calls.radarrDeleteMovie).toHaveLength(0);
    expect(claimRow('movie:missing-mode', 'frank')?.active).toBe(true);
  });

  it('an invalid mode is refused even for the OPERATOR, and even with no claim at all (D-6 does not extend to malformed instructions)', async () => {
    seedMember('admin', true);
    seedTitle('movie:op-typo', { sizeBytes: 5000, arrId: 1 });

    const { radarr, sonarr, calls } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();

    const result = await executeDeletionBatch(
      { username: 'admin', isOperator: true },
      [{ titleId: 'movie:op-typo', requestedMode: 'DELETE_FILES' as unknown as 'delete_files' }],
      { radarr, sonarr, seerr },
      { nowSeconds: NOW },
    );

    expect(result.items[0].outcome).toBe('invalid_mode');
    expect(calls.radarrDeleteMovie).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// CONTROL — carried forward from the reviewer's scratch file: duplicate
// titleIds in one batch with MIXED requestedMode values must not let a
// blocked mode be evaded by also listing a different mode for the same id.
// De-dupe is "first occurrence wins" (FR-DEL-8) — pinned explicitly here so
// this doesn't quietly regress into "last occurrence wins" or "process both".
// ---------------------------------------------------------------------------

describe('executeDeletionBatch — CONTROL: duplicate ids with mixed modes', () => {
  it('a sole claimant listing the SAME id twice with DIFFERENT modes (release_claim first, delete_files second) is decided ONCE, on the FIRST occurrence — blocked, never falls through to the second entry\'s delete', async () => {
    seedMember('frank');
    seedTitle('movie:mixed-modes', { sizeBytes: 2000, arrId: 1 });
    seedClaim('movie:mixed-modes', 'frank', 2000);

    const { radarr, sonarr, calls } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();

    const result = await executeDeletionBatch(
      { username: 'frank', isOperator: false },
      [
        { titleId: 'movie:mixed-modes', requestedMode: 'release_claim' },
        { titleId: 'movie:mixed-modes', requestedMode: 'delete_files' },
      ],
      { radarr, sonarr, seerr },
      { nowSeconds: NOW },
    );

    // Exactly one result — the duplicate is deduped, not processed twice.
    expect(result.items).toHaveLength(1);
    // First occurrence (release_claim) wins, and since she's the SOLE
    // claimant, that is blocked (D-3) — it must NOT silently fall through
    // to the second entry's delete_files.
    expect(result.items[0]).toMatchObject({ outcome: 'blocked', blockedReason: 'sole_claimant_cannot_release' });
    expect(calls.radarrDeleteMovie).toHaveLength(0);
    expect(claimRow('movie:mixed-modes', 'frank')?.active).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sole claimant may never release
// ---------------------------------------------------------------------------

describe('executeDeletionBatch — a sole claimant cannot release (D-3 invariant)', () => {
  it('blocks the release, mutates nothing, writes delete.blocked (denied)', async () => {
    seedMember('frank');
    seedTitle('movie:3', { sizeBytes: 2000 });
    seedClaim('movie:3', 'frank', 2000);

    const { radarr, sonarr, calls } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();

    const result = await executeDeletionBatch(
      { username: 'frank', isOperator: false },
      [{ titleId: 'movie:3', requestedMode: 'release_claim' }],
      { radarr, sonarr, seerr },
      { nowSeconds: NOW },
    );

    expect(result.items[0]).toMatchObject({ outcome: 'blocked', blockedReason: 'sole_claimant_cannot_release' });
    expect(calls.radarrDeleteMovie).toHaveLength(0);
    expect(claimRow('movie:3', 'frank')?.active).toBe(true); // still fully charged
    const rows = auditRowsFor('movie:3');
    expect(rows.map((r) => r.action)).toEqual(['delete.blocked']);
    expect(rows[0].outcome).toBe('denied');
  });

  it('an OPERATOR cannot release a sole claim either — the rule is not member-specific', async () => {
    seedMember('dana');
    seedMember('admin', true);
    seedTitle('movie:3b', { sizeBytes: 2000 });
    seedClaim('movie:3b', 'dana', 2000);

    const { radarr, sonarr } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();

    const result = await executeDeletionBatch(
      { username: 'admin', isOperator: true },
      [{ titleId: 'movie:3b', requestedMode: 'release_claim' }],
      { radarr, sonarr, seerr },
      { nowSeconds: NOW, onBehalfOf: 'dana' },
    );

    expect(result.items[0]).toMatchObject({ outcome: 'blocked', blockedReason: 'sole_claimant_cannot_release' });
    expect(claimRow('movie:3b', 'dana')?.active).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Co-claimant release: touches no file, doesn't move the OTHER claimant's usage
// ---------------------------------------------------------------------------

describe("executeDeletionBatch — co-claimant release touches no file, doesn't move the other claimant's usage", () => {
  it('releasing frank\'s claim leaves the file untouched and dana\'s claim exactly as it was (D-3: no re-split)', async () => {
    seedMember('frank');
    seedMember('dana');
    seedTitle('movie:4', { sizeBytes: 12_000_000_000 });
    seedClaim('movie:4', 'frank', 12_000_000_000, 501);
    seedClaim('movie:4', 'dana', 12_000_000_000, 502);

    const { radarr, sonarr, calls } = createFakeArrClients();
    const { seerr, calls: seerrCalls } = createFakeSeerrCleanup();

    const result = await executeDeletionBatch(
      { username: 'frank', isOperator: false },
      [{ titleId: 'movie:4', requestedMode: 'release_claim' }],
      { radarr, sonarr, seerr },
      { nowSeconds: NOW },
    );

    expect(result.items[0]).toMatchObject({ outcome: 'released', finalMode: 'release_claim', downgradedFromDelete: false });
    // No file touched:
    expect(calls.radarrDeleteMovie).toHaveLength(0);
    expect(calls.sonarrDeleteSeries).toHaveLength(0);
    expect(seerrCalls).toHaveLength(0);
    // frank's own claim is released:
    expect(claimRow('movie:4', 'frank')?.active).toBe(false);
    // dana's claim is COMPLETELY unaffected — still active, still the FULL size (no re-split, D-3):
    const danaClaim = claimRow('movie:4', 'dana')!;
    expect(danaClaim.active).toBe(true);
    expect(danaClaim.chargedBytes).toBe(12_000_000_000);

    const rows = auditRowsFor('movie:4');
    expect(rows.map((r) => r.action)).toEqual(['claim.released']);
  });
});

// ---------------------------------------------------------------------------
// protected / recent-play guards
// ---------------------------------------------------------------------------

describe('executeDeletionBatch — protected titles (FR-DEL-3)', () => {
  it('blocks a member, sole claimant, from deleting a protected title', async () => {
    seedMember('frank');
    seedTitle('movie:5', { sizeBytes: 1000, protectedTitle: true, protectedReason: 'Maintainerr manages this one' });
    seedClaim('movie:5', 'frank', 1000);

    const { radarr, sonarr, calls } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();

    const result = await executeDeletionBatch(
      { username: 'frank', isOperator: false },
      [{ titleId: 'movie:5', requestedMode: 'delete_files' }],
      { radarr, sonarr, seerr },
      { nowSeconds: NOW },
    );

    expect(result.items[0]).toMatchObject({ outcome: 'blocked', blockedReason: 'protected' });
    expect(calls.radarrDeleteMovie).toHaveLength(0);
    const rows = auditRowsFor('movie:5');
    expect(rows.map((r) => r.action)).toEqual(['delete.requested', 'delete.blocked']);
  });

  it('the operator CAN delete a protected title with NO claim at all (D-6 no-claim path) — bytesFreed reflects the real title size, not a zero charge', async () => {
    seedMember('admin', true);
    seedTitle('movie:5b', { sizeBytes: 1000, protectedTitle: true, protectedReason: 'pinned' });
    // Deliberately no seedClaim() — nobody claims this title at all.

    const { radarr, sonarr, calls } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();

    const result = await executeDeletionBatch(
      { username: 'admin', isOperator: true },
      [{ titleId: 'movie:5b', requestedMode: 'delete_files' }],
      { radarr, sonarr, seerr },
      { nowSeconds: NOW },
    );

    expect(result.items[0].outcome).toBe('deleted');
    expect(result.items[0].bytesFreed).toBe(1000); // NOT 0 — chargedBytes would be 0 here since nobody claims it
    expect(calls.radarrDeleteMovie).toEqual([1]);
  });
});

describe('executeDeletionBatch — recently-played guard (FR-DEL-4)', () => {
  it('blocks a member deleting a title played 4 days ago, with the reason surfaced', async () => {
    seedMember('frank');
    seedMember('erin');
    seedTitle('movie:6', { sizeBytes: 1000, watchedByAnyone: true, lastPlayedAnyAt: NOW - 4 * DAY });
    seedClaim('movie:6', 'frank', 1000);

    const { radarr, sonarr, calls } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();

    const result = await executeDeletionBatch(
      { username: 'frank', isOperator: false },
      [{ titleId: 'movie:6', requestedMode: 'delete_files' }],
      { radarr, sonarr, seerr },
      { nowSeconds: NOW },
    );

    expect(result.items[0]).toMatchObject({ outcome: 'blocked', blockedReason: 'guard' });
    expect(result.items[0].guardMessages?.[0]).not.toContain('erin');
    expect(calls.radarrDeleteMovie).toHaveLength(0);
  });

  it('the operator can override the guard with an explicit flag', async () => {
    seedMember('admin', true);
    seedTitle('movie:6b', { sizeBytes: 1000, watchedByAnyone: true, lastPlayedAnyAt: NOW - 4 * DAY });

    const { radarr, sonarr, calls } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();

    const blockedFirst = await executeDeletionBatch(
      { username: 'admin', isOperator: true },
      [{ titleId: 'movie:6b', requestedMode: 'delete_files' }],
      { radarr, sonarr, seerr },
      { nowSeconds: NOW },
    );
    expect(blockedFirst.items[0].outcome).toBe('blocked');

    const overridden = await executeDeletionBatch(
      { username: 'admin', isOperator: true },
      [{ titleId: 'movie:6b', requestedMode: 'delete_files' }],
      { radarr, sonarr, seerr },
      { nowSeconds: NOW, overrideGuards: true },
    );
    expect(overridden.items[0].outcome).toBe('deleted');
    expect(calls.radarrDeleteMovie).toEqual([1]);
  });

  it('a member cannot self-grant the override flag — it is silently ignored for a non-operator actor', async () => {
    seedMember('frank');
    seedTitle('movie:6c', { sizeBytes: 1000, watchedByAnyone: true, lastPlayedAnyAt: NOW - 4 * DAY });
    seedClaim('movie:6c', 'frank', 1000);

    const { radarr, sonarr, calls } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();

    const result = await executeDeletionBatch(
      { username: 'frank', isOperator: false },
      [{ titleId: 'movie:6c', requestedMode: 'delete_files' }],
      { radarr, sonarr, seerr },
      { nowSeconds: NOW, overrideGuards: true },
    );

    expect(result.items[0].outcome).toBe('blocked');
    expect(calls.radarrDeleteMovie).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// already gone
// ---------------------------------------------------------------------------

describe('executeDeletionBatch — already gone', () => {
  it('sizeBytes 0 reports already_gone per-title, without calling arr, and is NOT an error', async () => {
    seedMember('frank');
    seedTitle('movie:7', { sizeBytes: 0 });
    seedClaim('movie:7', 'frank', 0);

    const { radarr, sonarr, calls } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();

    const result = await executeDeletionBatch(
      { username: 'frank', isOperator: false },
      [{ titleId: 'movie:7', requestedMode: 'delete_files' }],
      { radarr, sonarr, seerr },
      { nowSeconds: NOW },
    );

    expect(result.items[0]).toMatchObject({ outcome: 'already_gone', bytesFreed: 0 });
    expect(calls.radarrDeleteMovie).toHaveLength(0);
    const rows = auditRowsFor('movie:7');
    expect(rows.map((r) => r.action)).toEqual(['delete.requested', 'delete.executed']);
  });
});

// ---------------------------------------------------------------------------
// FR-DEL-8 — partial batch failure
// ---------------------------------------------------------------------------

describe('executeDeletionBatch — partial batch failure (FR-DEL-8)', () => {
  it('six titles, the fourth arr call 500s: five succeed, one fails, batch is NOT aborted, per-title audit rows exist for all six, sharing one correlationId', async () => {
    seedMember('frank');
    const titleIds = ['movie:b1', 'movie:b2', 'movie:b3', 'movie:b4', 'movie:b5', 'movie:b6'];
    for (const [i, id] of titleIds.entries()) {
      seedTitle(id, { sizeBytes: 1000, arrId: i + 1 });
      seedClaim(id, 'frank', 1000);
    }

    const { radarr, sonarr, calls } = createFakeArrClients({ radarrFailIds: new Set([4]) }); // movie:b4 -> arrId 4
    const { seerr } = createFakeSeerrCleanup();

    const result = await executeDeletionBatch(
      { username: 'frank', isOperator: false },
      titleIds.map((titleId) => ({ titleId, requestedMode: 'delete_files' as const })),
      { radarr, sonarr, seerr },
      { nowSeconds: NOW },
    );

    expect(result.items).toHaveLength(6);
    expect(result.summary).toMatchObject({ total: 6, deleted: 5, failed: 1 });
    const failedItem = result.items.find((i) => i.titleId === 'movie:b4')!;
    expect(failedItem.outcome).toBe('failed');
    expect(calls.radarrDeleteMovie).toEqual([1, 2, 3, 4, 5, 6]); // every id was attempted — one failure did not stop the rest

    // Every title has its own audit trail, and ALL rows across the whole
    // batch share ONE correlationId (wiki/Feature-08-Audit-Log.md's own
    // acceptance criterion).
    const allCorrelationIds = new Set<string>();
    for (const id of titleIds) {
      const rows = auditRowsFor(id);
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const r of rows) allCorrelationIds.add(r.correlationId);
    }
    expect(allCorrelationIds.size).toBe(1);
    expect([...allCorrelationIds][0]).toBe(result.correlationId);

    const failedRows = auditRowsFor('movie:b4');
    expect(failedRows.map((r) => r.action)).toEqual(['delete.requested', 'delete.failed']);
  });
});

// ---------------------------------------------------------------------------
// FR-DEL-18 — the batch loop must be exception-safe: an exception from work
// OUTSIDE the per-item arr-call try (guard evaluation, a DB read/write, the
// rate-limit reservation) must not abort the batch or silence any item.
// ---------------------------------------------------------------------------

/**
 * Wraps a real `SeerrQuotaDb` handle so its `.transaction()` method throws
 * once, on its Nth call, instead of running — simulating a DB error (e.g.
 * `SQLITE_BUSY`) at exactly the point `reserveFileDeletionSlot`
 * (`deletionStore.ts`) reserves a `delete_files` item's rate-limit slot.
 * That call sits OUTSIDE the per-item arr-call `try`/`catch` in
 * `execute.ts` — before this fix, nothing there caught it, so it escaped
 * `executeDeletionBatch` entirely and aborted the whole batch.
 */
function wrapDbThrowingOnNthTransaction<T extends object>(realDb: T, n: number, message: string): T {
  let call = 0;
  return new Proxy(realDb, {
    get(target, prop, _receiver) {
      if (prop === 'transaction') {
        return (...args: unknown[]) => {
          call += 1;
          if (call === n) {
            throw new Error(message);
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (target as any).transaction(...args);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('executeDeletionBatch — FR-DEL-18: the batch loop is exception-safe', () => {
  it('a DB error (e.g. SQLITE_BUSY) mid-batch on ONE item does not abort the batch — earlier items stay done, the failing item gets its own outcome + audit row, LATER items still get processed', async () => {
    seedMember('frank');
    seedTitle('movie:exc-1', { sizeBytes: 1000, arrId: 1 });
    seedClaim('movie:exc-1', 'frank', 1000);
    seedTitle('movie:exc-2', { sizeBytes: 1000, arrId: 2 });
    seedClaim('movie:exc-2', 'frank', 1000);
    seedTitle('movie:exc-3', { sizeBytes: 1000, arrId: 3 });
    seedClaim('movie:exc-3', 'frank', 1000);

    const { radarr, sonarr, calls } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();

    // Only movie:exc-1 and movie:exc-3 are delete_files attempts that reach
    // reserveFileDeletionSlot's db.transaction() call in order — throw on
    // the SECOND such call (movie:exc-2's reservation).
    const flakyDb = wrapDbThrowingOnNthTransaction(getDb(), 2, 'SQLITE_BUSY: simulated for FR-DEL-18 test');

    const result = await executeDeletionBatch(
      { username: 'frank', isOperator: false },
      [
        { titleId: 'movie:exc-1', requestedMode: 'delete_files' },
        { titleId: 'movie:exc-2', requestedMode: 'delete_files' },
        { titleId: 'movie:exc-3', requestedMode: 'delete_files' },
      ],
      { db: flakyDb, radarr, sonarr, seerr },
      { nowSeconds: NOW },
    );

    // Nothing was silently dropped — all three items have a result.
    expect(result.items).toHaveLength(3);

    // Item 1 (before the exception) completed normally.
    expect(result.items[0]).toMatchObject({ titleId: 'movie:exc-1', outcome: 'deleted' });
    // Item 2 (where the exception hit) is reported as its own failure —
    // never silently swallowed, never reported as a success.
    expect(result.items[1]).toMatchObject({ titleId: 'movie:exc-2', outcome: 'failed' });
    expect(result.items[1].error).toContain('SQLITE_BUSY');
    // Item 3 (AFTER the exception) was STILL PROCESSED — this is the crux
    // of FR-DEL-18: an exception on item 2 must not silence item 3.
    expect(result.items[2]).toMatchObject({ titleId: 'movie:exc-3', outcome: 'deleted' });

    expect(calls.radarrDeleteMovie).toEqual([1, 3]); // item 2 never reached the arr call at all

    // Every item has SOME audit trail — including the one that hit the
    // exception (FR-DEL-18 explicitly: "the remaining items get neither an
    // outcome nor an audit row" is exactly the failure mode this closes).
    expect(auditRowsFor('movie:exc-1').length).toBeGreaterThan(0);
    expect(auditRowsFor('movie:exc-2').length).toBeGreaterThan(0);
    expect(auditRowsFor('movie:exc-3').length).toBeGreaterThan(0);

    const exc3Rows = auditRowsFor('movie:exc-3');
    expect(exc3Rows.map((r) => r.action)).toEqual(['delete.requested', 'delete.executed']);
  });
});

// ---------------------------------------------------------------------------
// FR-DEL-12 — rate limit
// ---------------------------------------------------------------------------

describe('executeDeletionBatch — rate limit (FR-DEL-12)', () => {
  it('a member who already deleted 25 titles in the last hour is denied a 26th, with an audit row, and no arr call', async () => {
    seedMember('frank');
    const db = getDb();
    for (let i = 0; i < 25; i++) {
      seedTitle(`movie:already-${i}`);
      db.insert(deletion)
        .values({ ssoUsername: 'frank', titleId: `movie:already-${i}`, mode: 'delete_files', state: 'done', bytesClaimed: 1, requestedAt: NOW - 60 })
        .run();
    }
    seedTitle('movie:26', { sizeBytes: 1000 });
    seedClaim('movie:26', 'frank', 1000);

    const { radarr, sonarr, calls } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();

    const result = await executeDeletionBatch(
      { username: 'frank', isOperator: false },
      [{ titleId: 'movie:26', requestedMode: 'delete_files' }],
      { radarr, sonarr, seerr },
      { nowSeconds: NOW },
    );

    expect(result.items[0].outcome).toBe('rate_limited');
    expect(calls.radarrDeleteMovie).toHaveLength(0);
    const rows = auditRowsFor('movie:26');
    expect(rows.map((r) => r.action)).toEqual(['delete.requested', 'access.denied']);
  });

  it('does NOT count blocked or release_claim rows toward the limit', async () => {
    seedMember('frank');
    seedMember('dana');
    const db = getDb();
    for (let i = 0; i < 25; i++) {
      seedTitle(`movie:blocked-${i}`);
      db.insert(deletion)
        .values({ ssoUsername: 'frank', titleId: `movie:blocked-${i}`, mode: 'delete_files', state: 'blocked', bytesClaimed: 1, requestedAt: NOW - 60 })
        .run();
    }
    seedTitle('movie:27', { sizeBytes: 1000 });
    seedClaim('movie:27', 'frank', 1000);

    const { radarr, sonarr, calls } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();

    const result = await executeDeletionBatch(
      { username: 'frank', isOperator: false },
      [{ titleId: 'movie:27', requestedMode: 'delete_files' }],
      { radarr, sonarr, seerr },
      { nowSeconds: NOW },
    );

    expect(result.items[0].outcome).toBe('deleted');
    expect(calls.radarrDeleteMovie).toEqual([1]);
  });

  it('the running count increments WITHIN one batch — item 26 in a single 26-item batch is rate-limited even though the DB had zero prior deletions', async () => {
    process.env.DELETE_MAX_PER_HOUR = '2';
    _resetConfigCacheForTests();
    seedMember('frank');
    const titleIds = ['movie:r1', 'movie:r2', 'movie:r3'];
    for (const [i, id] of titleIds.entries()) {
      seedTitle(id, { sizeBytes: 1000, arrId: i + 1 });
      seedClaim(id, 'frank', 1000);
    }
    const { radarr, sonarr, calls } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();

    const result = await executeDeletionBatch(
      { username: 'frank', isOperator: false },
      titleIds.map((titleId) => ({ titleId, requestedMode: 'delete_files' as const })),
      { radarr, sonarr, seerr },
      { nowSeconds: NOW },
    );

    expect(result.summary).toMatchObject({ deleted: 2, rateLimited: 1 });
    expect(calls.radarrDeleteMovie).toHaveLength(2);
  });

  it('FR-DEL-17: the limit holds across two CONCURRENT batches for the same subject — one batch\'s write is never invisible to the other', async () => {
    // The proven bug: the old code read `countRecentFileDeletions` ONCE at
    // the top of `executeDeletionBatch` into a local variable, then only
    // ever incremented that LOCAL variable per item — never re-reading the
    // DB. Two batches interleaved via `await` (batch A has 2 items, so
    // there's a real await gap between item 1 and item 2; batch B writes
    // its own item during that gap) each track their own budget in
    // isolation, so the true total can exceed DELETE_MAX_PER_HOUR even
    // though every individual batch "looks" correctly rate-limited from its
    // own point of view. This test forces exactly that interleaving with
    // manually-controlled gates on the arr call, and proves the fixed code
    // (atomic count-and-reserve per item, `reserveFileDeletionSlot`) never
    // lets the true total exceed the limit — the SECOND item of the first
    // batch must observe the OTHER batch's already-reserved slot.
    process.env.DELETE_MAX_PER_HOUR = '2';
    _resetConfigCacheForTests();
    seedMember('frank');
    seedTitle('movie:race-a1', { sizeBytes: 1000, arrId: 1 });
    seedClaim('movie:race-a1', 'frank', 1000);
    seedTitle('movie:race-a2', { sizeBytes: 1000, arrId: 2 });
    seedClaim('movie:race-a2', 'frank', 1000);
    seedTitle('movie:race-b1', { sizeBytes: 1000, arrId: 3 });
    seedClaim('movie:race-b1', 'frank', 1000);

    const gates: Array<() => void> = [];
    const arrCalls: number[] = [];
    const radarr = {
      async deleteMovie(id: number) {
        arrCalls.push(id);
        await new Promise<void>((resolve) => gates.push(resolve));
        return { status: 200 };
      },
    } as unknown as RadarrDeleteClient;
    const sonarr = {
      async deleteSeries() {
        throw new Error('test bug: no title in this test routes to sonarr');
      },
    } as unknown as SonarrDeleteClient;
    const { seerr } = createFakeSeerrCleanup(); // seerrRequestId is null for every claim above — no Seerr call to gate.

    async function drainUntilSettled(promises: Array<Promise<unknown>>): Promise<void> {
      const settled = promises.map(() => false);
      promises.forEach((p, i) => {
        p.then(() => {
          settled[i] = true;
        });
      });
      for (let iter = 0; iter < 50 && !settled.every(Boolean); iter++) {
        while (gates.length > 0) gates.shift()!();
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    const pA = executeDeletionBatch(
      { username: 'frank', isOperator: false },
      [
        { titleId: 'movie:race-a1', requestedMode: 'delete_files' },
        { titleId: 'movie:race-a2', requestedMode: 'delete_files' },
      ],
      { radarr, sonarr, seerr },
      { nowSeconds: NOW },
    );
    const pB = executeDeletionBatch(
      { username: 'frank', isOperator: false },
      [{ titleId: 'movie:race-b1', requestedMode: 'delete_files' }],
      { radarr, sonarr, seerr },
      { nowSeconds: NOW },
    );

    await drainUntilSettled([pA, pB]);
    const [resultA, resultB] = await Promise.all([pA, pB]);

    const totalDeleted = resultA.summary.deleted + resultB.summary.deleted;
    const totalRateLimited = resultA.summary.rateLimited + resultB.summary.rateLimited;
    // Exactly DELETE_MAX_PER_HOUR (2) total deletions across BOTH batches for
    // this subject, never 3 — the third attempt (whichever one lost the
    // race) must come back rate_limited, not silently succeed.
    expect(totalDeleted).toBe(2);
    expect(totalRateLimited).toBe(1);
    expect(new Set(arrCalls).size).toBe(2); // the arr client itself was only ever called twice
  });
});

// ---------------------------------------------------------------------------
// FR-DEL-9 — Seerr cleanup, including the partial-failure case
// ---------------------------------------------------------------------------

describe('executeDeletionBatch — FR-DEL-9 Seerr cleanup', () => {
  it('deletes files then removes the Seerr request', async () => {
    seedMember('frank');
    seedTitle('movie:8', { sizeBytes: 1000 });
    seedClaim('movie:8', 'frank', 1000, 900);

    const { radarr, sonarr } = createFakeArrClients();
    const { seerr, calls: seerrCalls } = createFakeSeerrCleanup();

    const result = await executeDeletionBatch(
      { username: 'frank', isOperator: false },
      [{ titleId: 'movie:8', requestedMode: 'delete_files' }],
      { radarr, sonarr, seerr },
      { nowSeconds: NOW },
    );

    expect(result.items[0]).toMatchObject({ outcome: 'deleted', partial: false });
    expect(seerrCalls).toEqual([900]);

    // FR-DEL-16 — the Seerr DELETE is a remote effect too, and MUST be
    // audited exactly like the arr call: an intent row before it, an
    // outcome row after, sharing the batch's correlationId. Before this
    // fix, a successful Seerr cleanup left NO trace at all — this is the
    // exact asymmetry that let FR-DEL-16 slip through review the first
    // time (the success path here asserted the Seerr call happened, but
    // never asserted anything about the audit log).
    const rows = auditRowsFor('movie:8');
    expect(rows.map((r) => r.action)).toEqual(['delete.requested', 'delete.executed', 'delete.requested', 'delete.executed']);
    expect(new Set(rows.map((r) => r.correlationId))).toEqual(new Set([result.correlationId]));
  });

  it('a Seerr cleanup failure AFTER a successful file delete is a PARTIAL failure — surfaced, never swallowed, never reported as a plain success', async () => {
    seedMember('frank');
    seedTitle('movie:9', { sizeBytes: 1000 });
    seedClaim('movie:9', 'frank', 1000, 901);

    const { radarr, sonarr } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup({ failRequestIds: new Set([901]) });

    const result = await executeDeletionBatch(
      { username: 'frank', isOperator: false },
      [{ titleId: 'movie:9', requestedMode: 'delete_files' }],
      { radarr, sonarr, seerr },
      { nowSeconds: NOW },
    );

    expect(result.items[0]).toMatchObject({ outcome: 'deleted', partial: true });
    expect(result.items[0].warning).toBeTruthy();

    // FR-DEL-16: the Seerr cleanup attempt gets its OWN intent row before
    // the call, not just a bare failure row after — a crash between the two
    // must leave evidence the call may have happened, same as the arr call.
    const rows = auditRowsFor('movie:9');
    expect(rows.map((r) => r.action)).toEqual(['delete.requested', 'delete.executed', 'delete.requested', 'delete.failed']);
    expect(new Set(rows.map((r) => r.correlationId))).toEqual(new Set([result.correlationId]));

    const [deletionRow] = getDb().select().from(deletion).where(eq(deletion.titleId, 'movie:9')).all();
    expect(deletionRow.state).toBe('done'); // files WERE removed — never demoted to 'failed'
    expect(deletionRow.error).toContain('seerr cleanup failed');
  });

  it('skips the Seerr call entirely for an operator-assigned claim (no seerrRequestId) — not an error', async () => {
    seedMember('frank');
    seedTitle('movie:10', { sizeBytes: 1000 });
    seedClaim('movie:10', 'frank', 1000, null);

    const { radarr, sonarr } = createFakeArrClients();
    const { seerr, calls: seerrCalls } = createFakeSeerrCleanup();

    const result = await executeDeletionBatch(
      { username: 'frank', isOperator: false },
      [{ titleId: 'movie:10', requestedMode: 'delete_files' }],
      { radarr, sonarr, seerr },
      { nowSeconds: NOW },
    );

    expect(result.items[0]).toMatchObject({ outcome: 'deleted', partial: false });
    expect(seerrCalls).toHaveLength(0);
    // No Seerr call happened, so no Seerr-cleanup intent/outcome rows either
    // — FR-DEL-16 only audits a remote effect that was actually attempted.
    const rows = auditRowsFor('movie:10');
    expect(rows.map((r) => r.action)).toEqual(['delete.requested', 'delete.executed']);
  });
});

// ---------------------------------------------------------------------------
// Downgrade: co-claimant asking to delete gets a release instead, honestly logged
// ---------------------------------------------------------------------------

describe('executeDeletionBatch — downgrade delete->release must not happen silently', () => {
  it('a co-claimant requesting delete_files gets release_claim, with delete.requested + claim.released both on record', async () => {
    seedMember('frank');
    seedMember('dana');
    seedTitle('movie:11', { sizeBytes: 1000 });
    seedClaim('movie:11', 'frank', 1000);
    seedClaim('movie:11', 'dana', 1000);

    const { radarr, sonarr, calls } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();

    const result = await executeDeletionBatch(
      { username: 'frank', isOperator: false },
      [{ titleId: 'movie:11', requestedMode: 'delete_files' }],
      { radarr, sonarr, seerr },
      { nowSeconds: NOW },
    );

    expect(result.items[0]).toMatchObject({ outcome: 'released', finalMode: 'release_claim', downgradedFromDelete: true });
    expect(calls.radarrDeleteMovie).toHaveLength(0); // never touched the file
    expect(claimRow('movie:11', 'dana')?.active).toBe(true); // dana unaffected

    const rows = auditRowsFor('movie:11');
    expect(rows.map((r) => r.action)).toEqual(['delete.requested', 'claim.released']);
  });
});

// ---------------------------------------------------------------------------
// on_behalf_of + operator source
// ---------------------------------------------------------------------------

describe('executeDeletionBatch — operator acting on_behalf_of a member', () => {
  it('records actor=operator, on_behalf_of=member on every audit row for the batch', async () => {
    seedMember('frank');
    seedMember('admin', true);
    seedTitle('movie:12', { sizeBytes: 1000 });
    seedClaim('movie:12', 'frank', 1000);

    const { radarr, sonarr } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();

    await executeDeletionBatch(
      { username: 'admin', isOperator: true },
      [{ titleId: 'movie:12', requestedMode: 'delete_files' }],
      { radarr, sonarr, seerr },
      { nowSeconds: NOW, onBehalfOf: 'frank' },
    );

    const rows = getDb().select().from(audit).where(eq(audit.targetId, 'movie:12')).all();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.actor).toBe('admin');
      expect(r.actorRole).toBe('operator');
      expect(r.onBehalfOf).toBe('frank');
    }
  });

  it('a member actor cannot set on_behalf_of — it is ignored, and the member acts only on their own claims', async () => {
    seedMember('frank');
    seedMember('dana');
    seedTitle('movie:13', { sizeBytes: 1000 });
    seedClaim('movie:13', 'dana', 1000); // frank has no claim; onBehalfOf tries to impersonate dana

    const { radarr, sonarr, calls } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();

    const result = await executeDeletionBatch(
      { username: 'frank', isOperator: false },
      [{ titleId: 'movie:13', requestedMode: 'delete_files' }],
      { radarr, sonarr, seerr },
      { nowSeconds: NOW, onBehalfOf: 'dana' },
    );

    expect(result.items[0].outcome).toBe('unauthorized');
    expect(calls.radarrDeleteMovie).toHaveLength(0);
    expect(claimRow('movie:13', 'dana')?.active).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sonarr routing + duplicate-id de-dupe
// ---------------------------------------------------------------------------

describe('executeDeletionBatch — Sonarr routing and de-dupe', () => {
  it('routes a sonarr title to SonarrDeleteClient, not Radarr', async () => {
    seedMember('frank');
    seedTitle('series:1', { sizeBytes: 4000, arrInstance: 'sonarr', arrId: 77 });
    seedClaim('series:1', 'frank', 4000);

    const { radarr, sonarr, calls } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();

    const result = await executeDeletionBatch(
      { username: 'frank', isOperator: false },
      [{ titleId: 'series:1', requestedMode: 'delete_files' }],
      { radarr, sonarr, seerr },
      { nowSeconds: NOW },
    );

    expect(result.items[0].outcome).toBe('deleted');
    expect(calls.sonarrDeleteSeries).toEqual([77]);
    expect(calls.radarrDeleteMovie).toHaveLength(0);
  });

  it('a duplicate titleId in one batch is processed exactly once', async () => {
    seedMember('frank');
    seedTitle('movie:14', { sizeBytes: 1000 });
    seedClaim('movie:14', 'frank', 1000);

    const { radarr, sonarr, calls } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();

    const result = await executeDeletionBatch(
      { username: 'frank', isOperator: false },
      [
        { titleId: 'movie:14', requestedMode: 'delete_files' },
        { titleId: 'movie:14', requestedMode: 'delete_files' },
      ],
      { radarr, sonarr, seerr },
      { nowSeconds: NOW },
    );

    expect(result.items).toHaveLength(1);
    expect(calls.radarrDeleteMovie).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// FR-DEL-21 — missing/stale playback data blocks, never silently allows
// ---------------------------------------------------------------------------

describe('executeDeletionBatch — FR-DEL-21: missing/stale playback data blocks, never silently allows', () => {
  it('an unwatched, sole-claimant title is BLOCKED (not deleted) when no playback sync has ever run — the exact shape of the deployed bug', async () => {
    getDb().delete(syncRun).run(); // undo beforeEach's healthy seed
    seedMember('frank');
    seedTitle('movie:fo-1', { sizeBytes: 1000, watchedByAnyone: false, lastPlayedAnyAt: null });
    seedClaim('movie:fo-1', 'frank', 1000);

    const { radarr, sonarr, calls } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();

    const result = await executeDeletionBatch(
      { username: 'frank', isOperator: false },
      [{ titleId: 'movie:fo-1', requestedMode: 'delete_files' }],
      { radarr, sonarr, seerr },
      { nowSeconds: NOW },
    );

    expect(result.items[0]).toMatchObject({ outcome: 'blocked', blockedReason: 'guard' });
    expect(calls.radarrDeleteMovie).toHaveLength(0); // no arr call — this is the whole point of FR-DEL-21
  });

  it('BLOCKED when the only sync_run on record is a FAILED playback step (readonly-database error, reproduced verbatim)', async () => {
    getDb().delete(syncRun).run();
    getDb()
      .insert(syncRun)
      .values({
        startedAt: NOW - 65,
        finishedAt: NOW - 60,
        steps: JSON.stringify({ playback: { ok: false, count: 0, ms: 5, error: 'attempt to write a readonly database' } }),
        ok: false,
      })
      .run();
    seedMember('frank');
    seedTitle('movie:fo-2', { sizeBytes: 1000 });
    seedClaim('movie:fo-2', 'frank', 1000);

    const { radarr, sonarr, calls } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();
    const result = await executeDeletionBatch({ username: 'frank', isOperator: false }, [{ titleId: 'movie:fo-2', requestedMode: 'delete_files' }], { radarr, sonarr, seerr }, { nowSeconds: NOW });

    expect(result.items[0].outcome).toBe('blocked');
    expect(calls.radarrDeleteMovie).toHaveLength(0);
  });

  it('BLOCKED when the last successful sync is older than STALE_SNAPSHOT_MAX_AGE_S', async () => {
    process.env.STALE_SNAPSHOT_MAX_AGE_S = '3600';
    _resetConfigCacheForTests();
    getDb().delete(syncRun).run();
    seedHealthyPlaybackSync(NOW - 7200); // 2h old — stale
    seedMember('frank');
    seedTitle('movie:fo-3', { sizeBytes: 1000 });
    seedClaim('movie:fo-3', 'frank', 1000);

    const { radarr, sonarr, calls } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();
    const result = await executeDeletionBatch({ username: 'frank', isOperator: false }, [{ titleId: 'movie:fo-3', requestedMode: 'delete_files' }], { radarr, sonarr, seerr }, { nowSeconds: NOW });

    expect(result.items[0].outcome).toBe('blocked');
    expect(calls.radarrDeleteMovie).toHaveLength(0);
    delete process.env.STALE_SNAPSHOT_MAX_AGE_S;
  });

  it('a genuinely-fresh, successful sync that observed zero playback still allows deletion — the fix does not block forever', async () => {
    // beforeEach already seeded a fresh healthy sync_run.
    seedMember('frank');
    seedTitle('movie:fo-4', { sizeBytes: 1000 });
    seedClaim('movie:fo-4', 'frank', 1000);

    const { radarr, sonarr, calls } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();
    const result = await executeDeletionBatch({ username: 'frank', isOperator: false }, [{ titleId: 'movie:fo-4', requestedMode: 'delete_files' }], { radarr, sonarr, seerr }, { nowSeconds: NOW });

    expect(result.items[0].outcome).toBe('deleted');
    expect(calls.radarrDeleteMovie).toEqual([1]);
  });

  it('an operator override does NOT bypass FR-DEL-21 as a shortcut — overrideGuards genuinely overrides the guard, not the unavailability, but IS the documented escape hatch (FR-DEL-4: operator MAY override)', async () => {
    getDb().delete(syncRun).run();
    seedMember('admin', true);
    seedTitle('movie:fo-5', { sizeBytes: 1000 });

    const { radarr, sonarr, calls } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();

    const blocked = await executeDeletionBatch(
      { username: 'admin', isOperator: true },
      [{ titleId: 'movie:fo-5', requestedMode: 'delete_files' }],
      { radarr, sonarr, seerr },
      { nowSeconds: NOW },
    );
    expect(blocked.items[0].outcome).toBe('blocked');

    const overridden = await executeDeletionBatch(
      { username: 'admin', isOperator: true },
      [{ titleId: 'movie:fo-5', requestedMode: 'delete_files' }],
      { radarr, sonarr, seerr },
      { nowSeconds: NOW, overrideGuards: true },
    );
    expect(overridden.items[0].outcome).toBe('deleted');
    expect(calls.radarrDeleteMovie).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// in_progress guard (FR-DEL-4)
// ---------------------------------------------------------------------------

describe('executeDeletionBatch — in_progress guard (FR-DEL-4)', () => {
  it('a movie with a resume position and not marked played is blocked, with a member message that never names who', async () => {
    seedMember('frank');
    seedMember('erin');
    seedTitle('movie:ip-1', { sizeBytes: 1000 });
    seedClaim('movie:ip-1', 'frank', 1000);
    getDb()
      .insert(playback)
      .values({ titleId: 'movie:ip-1', jellyfinUserId: 'erinjf', playCount: 1, played: false, positionTicks: 12_345, lastPlayedAt: NOW - 5 * DAY, lastSyncedAt: NOW })
      .run();

    const { radarr, sonarr, calls } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();
    const result = await executeDeletionBatch({ username: 'frank', isOperator: false }, [{ titleId: 'movie:ip-1', requestedMode: 'delete_files' }], { radarr, sonarr, seerr }, { nowSeconds: NOW });

    expect(result.items[0]).toMatchObject({ outcome: 'blocked', blockedReason: 'guard' });
    expect(result.items[0].guardMessages?.[0]).not.toContain('erin');
    expect(calls.radarrDeleteMovie).toHaveLength(0);
  });

  it('a series with some but not all episodes watched is blocked, even outside the recently_played window (169-in-progress case this guard exists for)', async () => {
    seedMember('frank');
    seedMember('erin');
    seedTitle('series:ip-2', { sizeBytes: 5000, arrInstance: 'sonarr', arrId: 55, watchedByAnyone: true, lastPlayedAnyAt: NOW - 200 * DAY });
    seedClaim('series:ip-2', 'frank', 5000);
    getDb()
      .insert(playback)
      .values({
        titleId: 'series:ip-2',
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

    const { radarr, sonarr, calls } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();
    const result = await executeDeletionBatch({ username: 'frank', isOperator: false }, [{ titleId: 'series:ip-2', requestedMode: 'delete_files' }], { radarr, sonarr, seerr }, { nowSeconds: NOW });

    expect(result.items[0]).toMatchObject({ outcome: 'blocked', blockedReason: 'guard' });
    expect(calls.sonarrDeleteSeries).toHaveLength(0);
  });

  it('a series where a user watched every episode does not trigger in_progress', async () => {
    seedMember('frank');
    seedTitle('series:ip-3', { sizeBytes: 5000, arrInstance: 'sonarr', arrId: 56, watchedByAnyone: true, lastPlayedAnyAt: NOW - 200 * DAY });
    seedClaim('series:ip-3', 'frank', 5000);
    getDb()
      .insert(playback)
      .values({
        titleId: 'series:ip-3',
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

    const { radarr, sonarr, calls } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();
    const result = await executeDeletionBatch({ username: 'frank', isOperator: false }, [{ titleId: 'series:ip-3', requestedMode: 'delete_files' }], { radarr, sonarr, seerr }, { nowSeconds: NOW });

    expect(result.items[0].outcome).toBe('deleted');
    expect(calls.sonarrDeleteSeries).toEqual([56]);
  });

  it('unfinished progress outside DELETE_IN_PROGRESS_DAYS does not block', async () => {
    seedMember('frank');
    seedTitle('movie:ip-4', { sizeBytes: 1000 });
    seedClaim('movie:ip-4', 'frank', 1000);
    getDb()
      .insert(playback)
      .values({ titleId: 'movie:ip-4', jellyfinUserId: 'somebodyjf', playCount: 1, played: false, positionTicks: 500, lastPlayedAt: NOW - 91 * DAY, lastSyncedAt: NOW })
      .run();

    const { radarr, sonarr, calls } = createFakeArrClients();
    const { seerr } = createFakeSeerrCleanup();
    const result = await executeDeletionBatch({ username: 'frank', isOperator: false }, [{ titleId: 'movie:ip-4', requestedMode: 'delete_files' }], { radarr, sonarr, seerr }, { nowSeconds: NOW });

    expect(result.items[0].outcome).toBe('deleted');
    expect(calls.radarrDeleteMovie).toEqual([1]);
  });
});
