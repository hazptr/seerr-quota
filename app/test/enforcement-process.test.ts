import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { UpstreamError } from '@/lib/http/client';
import { MediaRequestStatus } from '@/lib/seerr/types';
import type { EnforcementSeerrActions } from '@/lib/enforcement/seerrActions';
import type { EnforcementNotifier, NotifyResult } from '@/lib/enforcement/notify';

// Isolated throwaway DB file — same pattern as test/members-sync.test.ts /
// test/library-sync.test.ts. Must be set BEFORE `@/lib/db` (transitively
// imported by `@/lib/enforcement/process`) is imported.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-enforcement-process-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const { getDb, _resetDbForTests } = await import('@/lib/db');
const { appSetting, member, quotaPolicy, claim, title, syncRun, requestDecision, audit } = await import('@/lib/db/schema');
const { _resetConfigCacheForTests } = await import('@/lib/config');
const { processPendingRequest } = await import('@/lib/enforcement/process');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const NOW = 1_800_000_000; // fixed unix-seconds instant, entirely arbitrary but stable across the suite

beforeEach(() => {
  _resetDbForTests();
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(`${tmpDbPath}-wal`, { force: true });
  fs.rmSync(`${tmpDbPath}-shm`, { force: true });
  delete process.env.ENFORCEMENT_ENABLED;
  delete process.env.GRACE_BYTES;
  delete process.env.STALE_SNAPSHOT_MAX_AGE_S;
  delete process.env.HOLD_MAX_DAYS;
  _resetConfigCacheForTests();
});

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function seedMember(opts: {
  ssoUsername: string;
  seerrUserId: number;
  isOperator?: boolean;
  syncStatus?: 'matched' | 'no_seerr_account' | 'not_entitled' | 'ambiguous';
  quotaBytes?: number | null;
}): void {
  const db = getDb();
  db.insert(member)
    .values({
      ssoUsername: opts.ssoUsername,
      authentikUuid: null,
      displayName: opts.ssoUsername,
      email: `${opts.ssoUsername}@example.com`,
      entitled: true,
      isOperator: opts.isOperator ?? false,
      seerrUserId: opts.seerrUserId,
      jellyfinUserId: null,
      syncStatus: opts.syncStatus ?? 'matched',
      syncNote: null,
      firstSeenAt: NOW - 1000,
      lastSyncedAt: NOW - 10,
    })
    .run();
  if (opts.quotaBytes !== undefined) {
    db.insert(quotaPolicy)
      .values({ ssoUsername: opts.ssoUsername, quotaBytes: opts.quotaBytes, source: 'default', note: null, updatedAt: NOW - 10, updatedBy: 'system' })
      .run();
  }
}

let claimIdCounter = 0;
/** Seeds both the `title` row (FK target) and the `claim` row that charges its bytes to `ssoUsername`. */
function seedClaim(ssoUsername: string, chargedBytes: number): void {
  claimIdCounter += 1;
  const titleId = `movie:${claimIdCounter}`;
  const db = getDb();
  db.insert(title)
    .values({
      id: titleId,
      mediaType: 'movie',
      arrInstance: 'radarr',
      arrId: claimIdCounter,
      tmdbId: claimIdCounter,
      tvdbId: null,
      title: `Fixture Movie ${claimIdCounter}`,
      year: 2020,
      sizeBytes: chargedBytes,
      path: `/data/media/movies/fixture-${claimIdCounter}`,
      addedAt: NOW - 600,
      lastSyncedAt: NOW - 30,
    })
    .run();
  db.insert(claim)
    .values({
      titleId,
      ssoUsername,
      seerrRequestId: null,
      chargedBytes,
      active: true,
      createdAt: NOW - 500,
    })
    .run();
}

/** A fresh, successful attribution snapshot — required for `decide()` to get past the staleness gate. */
function seedFreshSnapshot(finishedAt: number = NOW - 30): void {
  getDb()
    .insert(syncRun)
    .values({ startedAt: finishedAt - 5, finishedAt, steps: JSON.stringify({ attribution: { ok: true, count: 1, ms: 5 } }), ok: true })
    .run();
}

interface FakeSeerrRequest {
  id: number;
  status: number;
  requestedBySeerrUserId: number;
}

interface FakeSeerrOptions {
  approveShouldFail?: boolean;
  declineShouldFail?: boolean;
}

function createFakeSeerrActions(initial: FakeSeerrRequest[], opts: FakeSeerrOptions = {}) {
  const store = new Map<number, FakeSeerrRequest>(initial.map((r) => [r.id, { ...r }]));
  const calls = { getRequestById: 0, approveRequest: 0, declineRequest: 0 };

  const client = {
    async getRequestById(id: number) {
      calls.getRequestById += 1;
      const r = store.get(id);
      if (!r) {
        throw new UpstreamError('http_error', 'seerr', 'GET', `/api/v1/request/${id}`, `seerr GET -> HTTP 404`, { status: 404 });
      }
      return { id: r.id, status: r.status, requestedBySeerrUserId: r.requestedBySeerrUserId };
    },
    async approveRequest(id: number) {
      calls.approveRequest += 1;
      if (opts.approveShouldFail) {
        throw new UpstreamError('http_error', 'seerr', 'POST', `/api/v1/request/${id}/approve`, 'seerr POST -> HTTP 500', { status: 500 });
      }
      const r = store.get(id);
      if (r) r.status = MediaRequestStatus.APPROVED;
    },
    async declineRequest(id: number) {
      calls.declineRequest += 1;
      if (opts.declineShouldFail) {
        throw new UpstreamError('http_error', 'seerr', 'POST', `/api/v1/request/${id}/decline`, 'seerr POST -> HTTP 500', { status: 500 });
      }
      const r = store.get(id);
      if (r) r.status = MediaRequestStatus.DECLINED;
    },
  };

  return { client: client as unknown as EnforcementSeerrActions, calls, store };
}

function createFakeNotifier(sent: boolean) {
  const calls = { notifyHeld: 0, notifyApproved: 0, notifyDeclined: 0 };
  const order: string[] = [];
  const result: NotifyResult = { sent };
  const notifier: EnforcementNotifier = {
    async notifyHeld() {
      calls.notifyHeld += 1;
      order.push('notifyHeld');
      return result;
    },
    async notifyApproved() {
      calls.notifyApproved += 1;
      order.push('notifyApproved');
      return result;
    },
    async notifyDeclined() {
      calls.notifyDeclined += 1;
      order.push('notifyDeclined');
      return result;
    },
  };
  return { notifier, calls, order };
}

function decisionRow(seerrRequestId: number) {
  return getDb().select().from(requestDecision).where(eq(requestDecision.seerrRequestId, seerrRequestId)).get();
}

function auditActionsFor(targetId: string): string[] {
  return getDb()
    .select({ action: audit.action, outcome: audit.outcome })
    .from(audit)
    .where(eq(audit.targetId, targetId))
    .all()
    .map((r) => `${r.action}:${r.outcome}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processPendingRequest — exactly-at-quota approves, over-quota holds (FR-ENF-2)', () => {
  it('approves a member exactly at quota, calling Seerr approve exactly once', async () => {
    process.env.ENFORCEMENT_ENABLED = 'true';
    _resetConfigCacheForTests();
    seedMember({ ssoUsername: 'frank', seerrUserId: 8, quotaBytes: 500 });
    seedClaim('frank', 500); // usage == quota exactly
    seedFreshSnapshot();
    const { client, calls } = createFakeSeerrActions([{ id: 201, status: MediaRequestStatus.PENDING, requestedBySeerrUserId: 8 }]);

    const outcome = await processPendingRequest(201, 'poller', { seerrActions: client }, NOW);

    expect(outcome).toEqual({ kind: 'decided', seerrRequestId: 201, decision: 'approve', reason: 'under_quota' });
    expect(calls.approveRequest).toBe(1);
    expect(calls.declineRequest).toBe(0);
    expect(decisionRow(201)).toMatchObject({ decision: 'approve', reason: 'under_quota', seerrStatus: 200 });
  });

  it('holds (no Seerr call) a member one byte over quota', async () => {
    process.env.ENFORCEMENT_ENABLED = 'true';
    _resetConfigCacheForTests();
    seedMember({ ssoUsername: 'erin', seerrUserId: 9, quotaBytes: 500 });
    seedClaim('erin', 501);
    seedFreshSnapshot();
    const { client, calls } = createFakeSeerrActions([{ id: 202, status: MediaRequestStatus.PENDING, requestedBySeerrUserId: 9 }]);

    const outcome = await processPendingRequest(202, 'poller', { seerrActions: client }, NOW);

    expect(outcome).toEqual({ kind: 'decided', seerrRequestId: 202, decision: 'hold', reason: 'over_quota' });
    expect(calls.approveRequest).toBe(0);
    expect(calls.declineRequest).toBe(0);
    expect(decisionRow(202)).toMatchObject({ decision: 'hold', reason: 'over_quota', seerrStatus: null, heldSince: NOW });
  });
});

describe('processPendingRequest — FR-ENF-4: stale snapshot skips, never holds', () => {
  it('skips an over-quota member with no attribution snapshot at all, and never calls Seerr', async () => {
    process.env.ENFORCEMENT_ENABLED = 'true';
    _resetConfigCacheForTests();
    seedMember({ ssoUsername: 'dana', seerrUserId: 10, quotaBytes: 500 });
    seedClaim('dana', 999); // wildly over quota
    // no seedFreshSnapshot() — no sync_run row exists yet
    const { client, calls } = createFakeSeerrActions([{ id: 203, status: MediaRequestStatus.PENDING, requestedBySeerrUserId: 10 }]);

    const outcome = await processPendingRequest(203, 'poller', { seerrActions: client }, NOW);

    expect(outcome).toEqual({ kind: 'decided', seerrRequestId: 203, decision: 'skip', reason: 'stale_snapshot' });
    expect(calls.approveRequest).toBe(0);
    expect(calls.declineRequest).toBe(0);
    expect(decisionRow(203)).toMatchObject({ decision: 'skip', reason: 'stale_snapshot', heldSince: null });
  });

  it('skips (not holds) when the snapshot exists but is older than STALE_SNAPSHOT_MAX_AGE_S', async () => {
    process.env.ENFORCEMENT_ENABLED = 'true';
    process.env.STALE_SNAPSHOT_MAX_AGE_S = '60';
    _resetConfigCacheForTests();
    seedMember({ ssoUsername: 'jack', seerrUserId: 11, quotaBytes: 500 });
    seedClaim('jack', 999);
    seedFreshSnapshot(NOW - 3600); // 1 hour stale, threshold is 60s
    const { client } = createFakeSeerrActions([{ id: 204, status: MediaRequestStatus.PENDING, requestedBySeerrUserId: 11 }]);

    const outcome = await processPendingRequest(204, 'poller', { seerrActions: client }, NOW);
    expect(outcome).toEqual({ kind: 'decided', seerrRequestId: 204, decision: 'skip', reason: 'stale_snapshot' });
  });
});

describe('processPendingRequest — FR-ENF-5: enforcement_enabled=false makes zero Seerr calls, but keeps the TRUE reason', () => {
  it('records the shadow verdict with its true reason (over_quota) and enforced:false — never an "enforcement_disabled" reason', async () => {
    // ENFORCEMENT_ENABLED left unset -> config default is false (ships off).
    _resetConfigCacheForTests();
    seedMember({ ssoUsername: 'frank', seerrUserId: 8, quotaBytes: 500 });
    seedClaim('frank', 999); // wildly over quota
    seedFreshSnapshot();
    const { client, calls } = createFakeSeerrActions([{ id: 205, status: MediaRequestStatus.PENDING, requestedBySeerrUserId: 8 }]);
    const { notifier, calls: notifyCalls } = createFakeNotifier(true);

    const outcome = await processPendingRequest(205, 'poller', { seerrActions: client, notifier }, NOW);

    // The dashboard's whole reason for running shadow mode is to see WHY a
    // request would have been held — "would have held (over quota)", not
    // just "would have held" — so `reason` must stay the true one.
    expect(outcome).toEqual({ kind: 'decided', seerrRequestId: 205, decision: 'hold', reason: 'over_quota' });
    // The Seerr write client is never invoked at all — only the read (getRequestById) call happens.
    expect(calls.approveRequest).toBe(0);
    expect(calls.declineRequest).toBe(0);
    expect(notifyCalls.notifyHeld).toBe(0);
    expect(notifyCalls.notifyApproved).toBe(0);
    expect(notifyCalls.notifyDeclined).toBe(0);
    expect(decisionRow(205)).toMatchObject({
      decision: 'hold',
      reason: 'over_quota',
      enforced: false,
      seerrStatus: null,
      notifiedAt: null,
      usageBytes: 999,
      quotaBytes: 500,
    });
  });

  it('an under-quota member also gets zero Seerr calls while disabled, reason stays under_quota, enforced:false', async () => {
    _resetConfigCacheForTests();
    seedMember({ ssoUsername: 'ivy', seerrUserId: 12, quotaBytes: 500 });
    seedClaim('ivy', 10);
    seedFreshSnapshot();
    const { client, calls } = createFakeSeerrActions([{ id: 206, status: MediaRequestStatus.PENDING, requestedBySeerrUserId: 12 }]);

    const outcome = await processPendingRequest(206, 'poller', { seerrActions: client }, NOW);

    expect(outcome).toEqual({ kind: 'decided', seerrRequestId: 206, decision: 'approve', reason: 'under_quota' });
    expect(calls.approveRequest).toBe(0);
    expect(decisionRow(206)).toMatchObject({ decision: 'approve', reason: 'under_quota', enforced: false, seerrStatus: null });
  });
});

describe('processPendingRequest — FR-ENF-7: duplicate webhook produces at most one action', () => {
  it('two CONCURRENT calls for the same request id result in exactly one Seerr approve call', async () => {
    process.env.ENFORCEMENT_ENABLED = 'true';
    _resetConfigCacheForTests();
    seedMember({ ssoUsername: 'frank', seerrUserId: 8, quotaBytes: 500 });
    seedClaim('frank', 10);
    seedFreshSnapshot();
    const { client, calls } = createFakeSeerrActions([{ id: 207, status: MediaRequestStatus.PENDING, requestedBySeerrUserId: 8 }]);

    const [a, b] = await Promise.all([
      processPendingRequest(207, 'webhook', { seerrActions: client }, NOW),
      processPendingRequest(207, 'webhook', { seerrActions: client }, NOW),
    ]);

    expect(a).toEqual(b); // both callers got the SAME evaluation (in-process de-dupe)
    expect(calls.approveRequest).toBe(1);
    expect(calls.getRequestById).toBe(1);
  });

  it('a SECOND, later webhook delivery for an already-approved request is a clean not_pending no-op — still exactly one Seerr call total', async () => {
    process.env.ENFORCEMENT_ENABLED = 'true';
    _resetConfigCacheForTests();
    seedMember({ ssoUsername: 'frank', seerrUserId: 8, quotaBytes: 500 });
    seedClaim('frank', 10);
    seedFreshSnapshot();
    const { client, calls } = createFakeSeerrActions([{ id: 208, status: MediaRequestStatus.PENDING, requestedBySeerrUserId: 8 }]);

    const first = await processPendingRequest(208, 'webhook', { seerrActions: client }, NOW);
    expect(first).toEqual({ kind: 'decided', seerrRequestId: 208, decision: 'approve', reason: 'under_quota' });

    const second = await processPendingRequest(208, 'webhook', { seerrActions: client }, NOW + 5);
    expect(second).toEqual({ kind: 'not_pending', seerrRequestId: 208 });

    expect(calls.approveRequest).toBe(1);
  });
});

describe('processPendingRequest — FR-ENF-8: the payload cannot redirect the verdict', () => {
  it('the decision for a given request id ALWAYS reflects that request\'s real, live requester — there is no payload channel to spoof it through', async () => {
    process.env.ENFORCEMENT_ENABLED = 'true';
    _resetConfigCacheForTests();
    // Two members: one deep over quota, one comfortably under.
    seedMember({ ssoUsername: 'overQuotaMember', seerrUserId: 20, quotaBytes: 500 });
    seedClaim('overQuotaMember', 999);
    seedMember({ ssoUsername: 'underQuotaMember', seerrUserId: 21, quotaBytes: 500 });
    seedClaim('underQuotaMember', 10);
    seedFreshSnapshot();
    // request 301 REALLY belongs to the over-quota member; request 302
    // REALLY belongs to the under-quota member. processPendingRequest's
    // entire input surface is (seerrRequestId, source) — there is no field
    // for a caller to claim a different requester, so the only way to test
    // "a forged payload can't redirect the verdict" is to prove each id
    // independently resolves to ITS OWN real owner's real state, which is
    // exactly what a forged `requestedBy_*` field in a webhook body would be
    // powerless to change (`./process.ts` never reads the payload at all).
    const { client } = createFakeSeerrActions([
      { id: 301, status: MediaRequestStatus.PENDING, requestedBySeerrUserId: 20 },
      { id: 302, status: MediaRequestStatus.PENDING, requestedBySeerrUserId: 21 },
    ]);

    const overQuotaOutcome = await processPendingRequest(301, 'webhook', { seerrActions: client }, NOW);
    const underQuotaOutcome = await processPendingRequest(302, 'webhook', { seerrActions: client }, NOW);

    expect(overQuotaOutcome).toEqual({ kind: 'decided', seerrRequestId: 301, decision: 'hold', reason: 'over_quota' });
    expect(underQuotaOutcome).toEqual({ kind: 'decided', seerrRequestId: 302, decision: 'approve', reason: 'under_quota' });
    expect(decisionRow(301)?.ssoUsername).toBe('overQuotaMember');
    expect(decisionRow(302)?.ssoUsername).toBe('underQuotaMember');
  });
});

describe('processPendingRequest — FR-ENF-10: unrecognised requester', () => {
  it('skips (unknown_member) and stores the seerr:{id} placeholder when no member row matches', async () => {
    process.env.ENFORCEMENT_ENABLED = 'true';
    _resetConfigCacheForTests();
    seedFreshSnapshot();
    const { client } = createFakeSeerrActions([{ id: 209, status: MediaRequestStatus.PENDING, requestedBySeerrUserId: 999 }]);

    const outcome = await processPendingRequest(209, 'poller', { seerrActions: client }, NOW);

    expect(outcome).toEqual({ kind: 'decided', seerrRequestId: 209, decision: 'skip', reason: 'unknown_member' });
    expect(decisionRow(209)).toMatchObject({ decision: 'skip', reason: 'unknown_member', enforced: true, ssoUsername: 'seerr:999' });
  });
});

describe('processPendingRequest — FR-POL-2a: a member with no override inherits the CURRENT global default, resolved at decision time, with no write to quota_policy', () => {
  it('quota_bytes=null + no global default configured -> quota_unconfigured (skip), never held', async () => {
    process.env.ENFORCEMENT_ENABLED = 'true';
    _resetConfigCacheForTests();
    seedMember({ ssoUsername: 'inherits1', seerrUserId: 40, quotaBytes: null }); // explicit null row, source=default
    seedClaim('inherits1', 999); // would be wildly over quota IF a limit applied
    seedFreshSnapshot();
    const { client } = createFakeSeerrActions([{ id: 230, status: MediaRequestStatus.PENDING, requestedBySeerrUserId: 40 }]);

    const outcome = await processPendingRequest(230, 'poller', { seerrActions: client }, NOW);
    expect(outcome).toEqual({ kind: 'decided', seerrRequestId: 230, decision: 'skip', reason: 'quota_unconfigured' });
  });

  it('quota_bytes=null + a global default IS configured (in app_setting) -> the SAME member is now held over it, with NO write to their quota_policy row', async () => {
    process.env.ENFORCEMENT_ENABLED = 'true';
    _resetConfigCacheForTests();
    seedMember({ ssoUsername: 'inherits2', seerrUserId: 41, quotaBytes: null });
    seedClaim('inherits2', 999);
    seedFreshSnapshot();
    // Operator raises the global default — via app_setting directly (the
    // real setter, src/lib/quota/policy.ts's setGlobalDefaultQuota, is
    // covered in test/quota-policy.test.ts).
    getDb().insert(appSetting).values({ key: 'default_quota_bytes', value: JSON.stringify(500), updatedAt: NOW - 5, updatedBy: 'admin' }).run();
    const { client, calls } = createFakeSeerrActions([{ id: 231, status: MediaRequestStatus.PENDING, requestedBySeerrUserId: 41 }]);

    const outcome = await processPendingRequest(231, 'poller', { seerrActions: client }, NOW);

    expect(outcome).toEqual({ kind: 'decided', seerrRequestId: 231, decision: 'hold', reason: 'over_quota' });
    expect(calls.approveRequest).toBe(0);
    expect(decisionRow(231)).toMatchObject({ decision: 'hold', reason: 'over_quota', quotaBytes: 500, usageBytes: 999 });

    // The member's own quota_policy row is untouched — inheritance was
    // resolved at decision time, never materialised into the row.
    const row = getDb().select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, 'inherits2')).get();
    expect(row?.quotaBytes).toBeNull();
  });

  it('an explicit override always wins over the default, regardless of what the default is', async () => {
    process.env.ENFORCEMENT_ENABLED = 'true';
    _resetConfigCacheForTests();
    seedMember({ ssoUsername: 'inherits3', seerrUserId: 42, quotaBytes: 0 }); // explicit unlimited override
    seedClaim('inherits3', 999_999_999);
    seedFreshSnapshot();
    // A very tight global default that would otherwise hold everyone.
    getDb().insert(appSetting).values({ key: 'default_quota_bytes', value: JSON.stringify(1), updatedAt: NOW - 5, updatedBy: 'admin' }).run();
    const { client, calls } = createFakeSeerrActions([{ id: 232, status: MediaRequestStatus.PENDING, requestedBySeerrUserId: 42 }]);

    const outcome = await processPendingRequest(232, 'poller', { seerrActions: client }, NOW);

    expect(outcome).toEqual({ kind: 'decided', seerrRequestId: 232, decision: 'approve', reason: 'under_quota' });
    expect(calls.approveRequest).toBe(1);
  });
});

describe('processPendingRequest — FR-ENF-4: each of the four fail-open skip reasons is produced by its OWN condition, never collapsed', () => {
  it('member_not_matched: a member row exists but sync_status is not matched (e.g. ambiguous)', async () => {
    process.env.ENFORCEMENT_ENABLED = 'true';
    _resetConfigCacheForTests();
    seedMember({ ssoUsername: 'hank', seerrUserId: 30, syncStatus: 'ambiguous', quotaBytes: 500 });
    seedFreshSnapshot();
    const { client } = createFakeSeerrActions([{ id: 220, status: MediaRequestStatus.PENDING, requestedBySeerrUserId: 30 }]);

    const outcome = await processPendingRequest(220, 'poller', { seerrActions: client }, NOW);

    expect(outcome).toEqual({ kind: 'decided', seerrRequestId: 220, decision: 'skip', reason: 'member_not_matched' });
    expect(decisionRow(220)).toMatchObject({ decision: 'skip', reason: 'member_not_matched', enforced: true, ssoUsername: 'hank' });
  });

  it('quota_unconfigured: a matched member with NO quota_policy row at all — quota_bytes round-trips as null, not 0', async () => {
    process.env.ENFORCEMENT_ENABLED = 'true';
    _resetConfigCacheForTests();
    // seedMember with quotaBytes omitted -> no quota_policy row is inserted at all.
    seedMember({ ssoUsername: 'gus', seerrUserId: 31 });
    seedClaim('gus', 250); // usage IS computable — only the quota is unconfigured
    seedFreshSnapshot();
    const { client } = createFakeSeerrActions([{ id: 221, status: MediaRequestStatus.PENDING, requestedBySeerrUserId: 31 }]);

    const outcome = await processPendingRequest(221, 'poller', { seerrActions: client }, NOW);

    expect(outcome).toEqual({ kind: 'decided', seerrRequestId: 221, decision: 'skip', reason: 'quota_unconfigured' });
    const row = decisionRow(221);
    expect(row).toMatchObject({ decision: 'skip', reason: 'quota_unconfigured', enforced: true });
    expect(row!.quotaBytes).toBeNull(); // NOT 0 — 0 would mean "unlimited" (FR-POL-2a)
    expect(row!.usageBytes).toBe(250); // usage was perfectly computable; only the quota was undecided
  });

  it('usage_unavailable (pure-function branch): decide() skips with usage_unavailable when usageBytes is null — the exact input process.ts produces on a caught getMemberUsageBytes failure', async () => {
    // Exercising the real DB-failure path in process.ts would mean poisoning
    // the shared `db` handle that member/quota/snapshot lookups ALSO use in
    // the same call, which would corrupt those lookups too, not just usage.
    // decide()'s own branching for this exact input (`usageBytes: null` with
    // an otherwise-healthy matched member) is already pinned precisely in
    // test/enforcement-decide.test.ts; process.ts's `try { getMemberUsageBytes
    // } catch { usageBytes = null }` (src/lib/enforcement/process.ts) is what
    // guarantees decide() only ever SEES that shape after a real failure.
    const { decide } = await import('@/lib/enforcement/decide');
    const result = decide({
      enforcementEnabled: true,
      memberRecognized: true,
      memberSyncStatus: 'matched',
      isOperator: false,
      quota: { kind: 'limited', bytes: 500 },
      usageBytes: null,
      graceBytes: 0,
      snapshotAgeS: 30,
      staleSnapshotMaxAgeS: 3600,
      isAlreadyHeld: false,
      holdAgeS: null,
      holdMaxDays: 30,
    });
    expect(result).toEqual({ decision: 'skip', reason: 'usage_unavailable', enforced: true });
  });
});

describe('request_decision usage_bytes/quota_bytes — null round-trips as null, never coerced to 0', () => {
  it('upsertRequestDecision followed by getRequestDecision returns null for both, verbatim', async () => {
    const { upsertRequestDecision, getRequestDecision } = await import('@/lib/enforcement/requestDecisionStore');
    const db = getDb();
    upsertRequestDecision(db, {
      seerrRequestId: 999_001,
      ssoUsername: 'someone',
      decision: 'skip',
      reason: 'quota_unconfigured',
      enforced: true,
      usageBytes: null,
      quotaBytes: null,
      source: 'poller',
      seerrStatus: null,
      heldSince: null,
      notifiedAt: null,
      decidedAt: NOW,
    });

    const row = getRequestDecision(db, 999_001);
    expect(row).toBeDefined();
    expect(row!.usageBytes).toBeNull();
    expect(row!.quotaBytes).toBeNull();
    // A real, distinguishable non-null value on the SAME column still round-trips too — proves this isn't just SQLite's "0 == falsy" masking a bug.
    upsertRequestDecision(db, {
      seerrRequestId: 999_001,
      ssoUsername: 'someone',
      decision: 'approve',
      reason: 'under_quota',
      enforced: true,
      usageBytes: 0, // a real, decided "zero usage" — distinct from null ("uncomputable")
      quotaBytes: 0, // a real, decided "unlimited" — distinct from null ("unconfigured")
      source: 'poller',
      seerrStatus: 200,
      heldSince: null,
      notifiedAt: null,
      decidedAt: NOW,
    });
    const updated = getRequestDecision(db, 999_001);
    expect(updated!.usageBytes).toBe(0);
    expect(updated!.quotaBytes).toBe(0);
  });
});

describe('processPendingRequest — a request no longer PENDING in Seerr is a clean no-op', () => {
  it('does not decide, does not write request_decision, does not audit', async () => {
    process.env.ENFORCEMENT_ENABLED = 'true';
    _resetConfigCacheForTests();
    seedMember({ ssoUsername: 'frank', seerrUserId: 8, quotaBytes: 500 });
    seedFreshSnapshot();
    const { client } = createFakeSeerrActions([{ id: 210, status: MediaRequestStatus.APPROVED, requestedBySeerrUserId: 8 }]);

    const outcome = await processPendingRequest(210, 'poller', { seerrActions: client }, NOW);

    expect(outcome).toEqual({ kind: 'not_pending', seerrRequestId: 210 });
    expect(decisionRow(210)).toBeUndefined();
    expect(auditActionsFor('210')).toEqual([]);
  });
});

describe('processPendingRequest — FR-ENF-12: hold age-out is the only automated decline', () => {
  it('an already-held request past HOLD_MAX_DAYS declines, notifying BEFORE the Seerr call', async () => {
    process.env.ENFORCEMENT_ENABLED = 'true';
    process.env.HOLD_MAX_DAYS = '30';
    _resetConfigCacheForTests();
    seedMember({ ssoUsername: 'erin', seerrUserId: 9, quotaBytes: 500 });
    seedClaim('erin', 999); // still over quota
    seedFreshSnapshot();
    const heldSince = NOW - 31 * 86_400;
    getDb()
      .insert(requestDecision)
      .values({
        seerrRequestId: 211,
        ssoUsername: 'erin',
        decision: 'hold',
        reason: 'over_quota',
        usageBytes: 999,
        quotaBytes: 500,
        source: 'poller',
        seerrStatus: null,
        heldSince,
        notifiedAt: null,
        decidedAt: heldSince,
      })
      .run();
    const { client, calls } = createFakeSeerrActions([{ id: 211, status: MediaRequestStatus.PENDING, requestedBySeerrUserId: 9 }]);
    const { notifier, order } = createFakeNotifier(true);

    const outcome = await processPendingRequest(211, 'poller', { seerrActions: client, notifier }, NOW);

    expect(outcome).toEqual({ kind: 'decided', seerrRequestId: 211, decision: 'decline', reason: 'hold_expired' });
    expect(calls.declineRequest).toBe(1);
    expect(order).toEqual(['notifyDeclined']); // sent before the decline call, per FR-ENF-12
    expect(decisionRow(211)).toMatchObject({ decision: 'decline', reason: 'hold_expired', seerrStatus: 200, heldSince: null, notifiedAt: NOW });
  });
});

describe('processPendingRequest — self-heal (D-4a): a held member who frees space is approved, and notified', () => {
  it('transitions hold -> approve and calls notifyApproved exactly once', async () => {
    process.env.ENFORCEMENT_ENABLED = 'true';
    _resetConfigCacheForTests();
    seedMember({ ssoUsername: 'erin', seerrUserId: 9, quotaBytes: 500 });
    seedClaim('erin', 100); // freed up — now well under quota
    seedFreshSnapshot();
    getDb()
      .insert(requestDecision)
      .values({
        seerrRequestId: 212,
        ssoUsername: 'erin',
        decision: 'hold',
        reason: 'over_quota',
        usageBytes: 999,
        quotaBytes: 500,
        source: 'poller',
        seerrStatus: null,
        heldSince: NOW - 1000,
        notifiedAt: NOW - 1000,
        decidedAt: NOW - 1000,
      })
      .run();
    const { client, calls } = createFakeSeerrActions([{ id: 212, status: MediaRequestStatus.PENDING, requestedBySeerrUserId: 9 }]);
    const { notifier, calls: notifyCalls } = createFakeNotifier(true);

    const outcome = await processPendingRequest(212, 'poller', { seerrActions: client, notifier }, NOW);

    expect(outcome).toEqual({ kind: 'decided', seerrRequestId: 212, decision: 'approve', reason: 'under_quota' });
    expect(calls.approveRequest).toBe(1);
    expect(notifyCalls.notifyApproved).toBe(1);
    expect(decisionRow(212)).toMatchObject({ decision: 'approve', reason: 'under_quota', heldSince: null, notifiedAt: NOW });
  });
});

describe('processPendingRequest — a Seerr approve failure is recorded as errored, never marked final', () => {
  it('leaves no request_decision row on failure, and a later retry succeeds', async () => {
    process.env.ENFORCEMENT_ENABLED = 'true';
    _resetConfigCacheForTests();
    seedMember({ ssoUsername: 'frank', seerrUserId: 8, quotaBytes: 500 });
    seedClaim('frank', 10);
    seedFreshSnapshot();
    const { client } = createFakeSeerrActions([{ id: 213, status: MediaRequestStatus.PENDING, requestedBySeerrUserId: 8 }], {
      approveShouldFail: true,
    });

    const failed = await processPendingRequest(213, 'poller', { seerrActions: client }, NOW);
    expect(failed.kind).toBe('error');
    expect(decisionRow(213)).toBeUndefined(); // not marked final
    // FR-AUD-8: an intent row (outcome=ok, written before the call) plus an
    // outcome row (outcome=error, written after) — never just the failure.
    expect(auditActionsFor('213')).toEqual(['request.approved:ok', 'request.approved:error']);

    // Next poll: Seerr recovers, the same request (still PENDING) is retried and succeeds.
    const { client: recoveredClient, calls: recoveredCalls } = createFakeSeerrActions([
      { id: 213, status: MediaRequestStatus.PENDING, requestedBySeerrUserId: 8 },
    ]);
    const retried = await processPendingRequest(213, 'poller', { seerrActions: recoveredClient }, NOW + 900);
    expect(retried).toEqual({ kind: 'decided', seerrRequestId: 213, decision: 'approve', reason: 'under_quota' });
    expect(recoveredCalls.approveRequest).toBe(1);
    expect(decisionRow(213)).toMatchObject({ decision: 'approve', seerrStatus: 200 });
  });
});

describe('processPendingRequest — FR-ENF-3/FR-ENF-14-lite: notify once per hold episode, not every re-decide', () => {
  it('does not re-notify a request that stays held across two consecutive sweeps', async () => {
    process.env.ENFORCEMENT_ENABLED = 'true';
    _resetConfigCacheForTests();
    seedMember({ ssoUsername: 'dana', seerrUserId: 10, quotaBytes: 500 });
    seedClaim('dana', 999);
    seedFreshSnapshot();
    const { client } = createFakeSeerrActions([{ id: 214, status: MediaRequestStatus.PENDING, requestedBySeerrUserId: 10 }]);
    const { notifier, calls: notifyCalls } = createFakeNotifier(true);

    const first = await processPendingRequest(214, 'poller', { seerrActions: client, notifier }, NOW);
    expect(first).toEqual({ kind: 'decided', seerrRequestId: 214, decision: 'hold', reason: 'over_quota' });
    expect(notifyCalls.notifyHeld).toBe(1);

    const second = await processPendingRequest(214, 'poller', { seerrActions: client, notifier }, NOW + 900);
    expect(second).toEqual({ kind: 'decided', seerrRequestId: 214, decision: 'hold', reason: 'over_quota' });
    expect(notifyCalls.notifyHeld).toBe(1); // still 1 — not re-fired on the second sweep
  });
});
