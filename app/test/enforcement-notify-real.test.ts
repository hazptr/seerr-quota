import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { UpstreamError } from '@/lib/http/client';
import { MediaRequestStatus } from '@/lib/seerr/types';
import type { EnforcementSeerrActions } from '@/lib/enforcement/seerrActions';
import type { MailMessage, MailTransport } from '@/lib/mail';

/**
 * The P2-9 real `EnforcementNotifier` (`src/lib/enforcement/notify.ts`'s
 * `createEnforcementNotifier`). No test here opens a real SMTP connection or
 * sends real mail — every test injects a fake `MailTransport`
 * (`createFakeTransport` below), per this task's testing constraint.
 *
 * Two layers of coverage:
 *   1. Unit-level, against `createEnforcementNotifier` directly: cooldown
 *      throttling (`FR-ENF-14`), the no-email surfacing (`FR-ENF-13`), SMTP
 *      failure handling, and the held-count figure.
 *   2. Integration-level, against the REAL `processPendingRequest` (not
 *      mocked) wired to a REAL `createEnforcementNotifier`: proves the two
 *      hardest acceptance criteria end-to-end — an SMTP failure leaves the
 *      decision/audit row intact and never sets `notifiedAt`, and the
 *      approved-after-hold notification actually fires through the real
 *      seam, not just against a fake `EnforcementNotifier` (which is all
 *      `test/enforcement-process.test.ts` proves — that file owns
 *      `./process.ts`'s own orchestration and deliberately uses a fake
 *      notifier throughout, since P2-9 hadn't shipped yet when it was
 *      written).
 */

// Isolated throwaway DB file — same pattern as every other enforcement test.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-enforcement-notify-real-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const { getDb, _resetDbForTests } = await import('@/lib/db');
const { appSetting, audit, claim, member, quotaPolicy, requestDecision, syncRun, title } = await import('@/lib/db/schema');
const { _resetConfigCacheForTests } = await import('@/lib/config');
const { createEnforcementNotifier } = await import('@/lib/enforcement/notify');
const { processPendingRequest } = await import('@/lib/enforcement/process');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const NOW = 1_800_000_000; // fixed unix-seconds instant, arbitrary but stable

beforeEach(() => {
  _resetDbForTests();
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(`${tmpDbPath}-wal`, { force: true });
  fs.rmSync(`${tmpDbPath}-shm`, { force: true });
  delete process.env.ENFORCEMENT_ENABLED;
  delete process.env.NOTIFY_COOLDOWN_S;
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  _resetConfigCacheForTests();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function seedMember(opts: { ssoUsername: string; seerrUserId: number; email?: string | null; lastHoldNotifiedAt?: number | null }): void {
  getDb()
    .insert(member)
    .values({
      ssoUsername: opts.ssoUsername,
      authentikUuid: null,
      displayName: opts.ssoUsername,
      email: opts.email === undefined ? `${opts.ssoUsername}@example.com` : opts.email,
      entitled: true,
      isOperator: false,
      seerrUserId: opts.seerrUserId,
      jellyfinUserId: null,
      syncStatus: 'matched',
      syncNote: null,
      lastHoldNotifiedAt: opts.lastHoldNotifiedAt ?? null,
      firstSeenAt: NOW - 1000,
      lastSyncedAt: NOW - 10,
    })
    .run();
  getDb()
    .insert(quotaPolicy)
    .values({ ssoUsername: opts.ssoUsername, quotaBytes: 500, source: 'default', note: null, updatedAt: NOW - 10, updatedBy: 'system' })
    .run();
}

function memberRow(ssoUsername: string) {
  return getDb().select().from(member).where(eq(member.ssoUsername, ssoUsername)).get();
}

/** Seeds an existing `request_decision` row with `decision = 'hold'`, for the "held count" and "declines/no-op" fixtures. */
function seedHoldDecision(seerrRequestId: number, ssoUsername: string, heldSince: number = NOW - 1000): void {
  getDb()
    .insert(requestDecision)
    .values({
      seerrRequestId,
      ssoUsername,
      decision: 'hold',
      reason: 'over_quota',
      usageBytes: 999,
      quotaBytes: 500,
      source: 'poller',
      seerrStatus: null,
      heldSince,
      notifiedAt: heldSince,
      decidedAt: heldSince,
    })
    .run();
}

let claimIdCounter = 0;
function seedClaim(ssoUsername: string, chargedBytes: number): void {
  claimIdCounter += 1;
  const titleId = `movie:${claimIdCounter}`;
  getDb()
    .insert(title)
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
  getDb()
    .insert(claim)
    .values({ titleId, ssoUsername, seerrRequestId: null, chargedBytes, active: true, createdAt: NOW - 500 })
    .run();
}

function seedFreshSnapshot(finishedAt: number = NOW - 30): void {
  getDb()
    .insert(syncRun)
    .values({ startedAt: finishedAt - 5, finishedAt, steps: JSON.stringify({ attribution: { ok: true, count: 1, ms: 5 } }), ok: true })
    .run();
}

function setCooldownSetting(seconds: number): void {
  getDb()
    .insert(appSetting)
    .values({ key: 'notify_cooldown_s', value: JSON.stringify(seconds), updatedAt: NOW, updatedBy: 'system' })
    .run();
}

interface FakeSeerrRequest {
  id: number;
  status: number;
  requestedBySeerrUserId: number;
}

function createFakeSeerrActions(initial: FakeSeerrRequest[]): { client: EnforcementSeerrActions; calls: { approveRequest: number; declineRequest: number } } {
  const store = new Map<number, FakeSeerrRequest>(initial.map((r) => [r.id, { ...r }]));
  const calls = { approveRequest: 0, declineRequest: 0 };
  const client = {
    async getRequestById(id: number) {
      const r = store.get(id);
      if (!r) throw new UpstreamError('http_error', 'seerr', 'GET', `/api/v1/request/${id}`, 'seerr GET -> HTTP 404', { status: 404 });
      return { id: r.id, status: r.status, requestedBySeerrUserId: r.requestedBySeerrUserId };
    },
    async approveRequest(id: number) {
      calls.approveRequest += 1;
      const r = store.get(id);
      if (r) r.status = MediaRequestStatus.APPROVED;
    },
    async declineRequest(id: number) {
      calls.declineRequest += 1;
      const r = store.get(id);
      if (r) r.status = MediaRequestStatus.DECLINED;
    },
  };
  return { client: client as unknown as EnforcementSeerrActions, calls };
}

/** A fake `MailTransport` — no real socket, ever. Optionally throws to simulate an SMTP failure. */
function createFakeTransport(opts: { shouldFail?: boolean } = {}): { transport: MailTransport; sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  const transport: MailTransport = {
    async send(message: MailMessage) {
      if (opts.shouldFail) throw new Error('ECONNREFUSED mail.example.com:25 (fake transport)');
      sent.push(message);
    },
  };
  return { transport, sent };
}

function auditRowsFor(targetId: string) {
  return getDb().select().from(audit).where(eq(audit.targetId, targetId)).all();
}

function decisionRow(seerrRequestId: number) {
  return getDb().select().from(requestDecision).where(eq(requestDecision.seerrRequestId, seerrRequestId)).get();
}

// ---------------------------------------------------------------------------
// Unit-level: notifyHeld — FR-ENF-14 cooldown, FR-ENF-13 no-email surfacing
// ---------------------------------------------------------------------------

describe('createEnforcementNotifier — notifyHeld', () => {
  it('sends the held email with the real numbers and stamps member.last_hold_notified_at', async () => {
    seedMember({ ssoUsername: 'frank', seerrUserId: 8 });
    const { transport, sent } = createFakeTransport();
    const notifier = createEnforcementNotifier({ source: 'poller', transport, now: () => NOW });

    const result = await notifier.notifyHeld({ ssoUsername: 'frank', seerrRequestId: 401, usageBytes: 600_000_000_000, quotaBytes: 500_000_000_000, shortfallBytes: 100_000_000_000 });

    expect(result).toEqual({ sent: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('frank@example.com');
    expect(sent[0].text).toContain('600.00 GB');
    expect(sent[0].text).toContain('500.00 GB');
    expect(sent[0].text).toContain('100.00 GB');
    expect(memberRow('frank')?.lastHoldNotifiedAt).toBe(NOW);
  });

  it('FR-ENF-14: a member with three held requests in one day gets exactly one email — the cooldown holds across many held requests', async () => {
    seedMember({ ssoUsername: 'dana', seerrUserId: 10 });
    const { transport, sent } = createFakeTransport();
    const notifier = createEnforcementNotifier({ source: 'poller', transport, now: () => NOW });

    const first = await notifier.notifyHeld({ ssoUsername: 'dana', seerrRequestId: 501, usageBytes: 600, quotaBytes: 500, shortfallBytes: 100 });
    const second = await notifier.notifyHeld({ ssoUsername: 'dana', seerrRequestId: 502, usageBytes: 700, quotaBytes: 500, shortfallBytes: 200 });
    const third = await notifier.notifyHeld({ ssoUsername: 'dana', seerrRequestId: 503, usageBytes: 800, quotaBytes: 500, shortfallBytes: 300 });

    expect(first).toEqual({ sent: true });
    expect(second).toEqual({ sent: false });
    expect(third).toEqual({ sent: false });
    expect(sent).toHaveLength(1);
  });

  it('sends again once the cooldown window has elapsed', async () => {
    seedMember({ ssoUsername: 'erin', seerrUserId: 9, lastHoldNotifiedAt: NOW - 90_000 }); // > default 86400s cooldown
    const { transport, sent } = createFakeTransport();
    const notifier = createEnforcementNotifier({ source: 'poller', transport, now: () => NOW });

    const result = await notifier.notifyHeld({ ssoUsername: 'erin', seerrRequestId: 601, usageBytes: 600, quotaBytes: 500, shortfallBytes: 100 });

    expect(result).toEqual({ sent: true });
    expect(sent).toHaveLength(1);
  });

  it('honours an app_setting notify_cooldown_s override over the config default', async () => {
    seedMember({ ssoUsername: 'ivy', seerrUserId: 12, lastHoldNotifiedAt: NOW - 20 }); // 20s ago — well within the 86400s config default
    setCooldownSetting(10); // operator shortened the cooldown to 10s
    const { transport, sent } = createFakeTransport();
    const notifier = createEnforcementNotifier({ source: 'poller', transport, now: () => NOW });

    const result = await notifier.notifyHeld({ ssoUsername: 'ivy', seerrRequestId: 701, usageBytes: 600, quotaBytes: 500, shortfallBytes: 100 });

    // 20s have elapsed, which is PAST the 10s DB override, even though it's
    // nowhere near the 86400s config default — proves the DB value, not the
    // config seed, governs.
    expect(result).toEqual({ sent: true });
    expect(sent).toHaveLength(1);
  });

  it('FR-ENF-13: a member with no email on record is surfaced to the operator via an audit row, not silently skipped', async () => {
    seedMember({ ssoUsername: 'family', seerrUserId: 30, email: null });
    const { transport, sent } = createFakeTransport();
    const notifier = createEnforcementNotifier({ source: 'poller', transport, now: () => NOW });

    const result = await notifier.notifyHeld({ ssoUsername: 'family', seerrRequestId: 801, usageBytes: 600, quotaBytes: 500, shortfallBytes: 100 });

    expect(result).toEqual({ sent: false });
    expect(sent).toHaveLength(0);
    const rows = auditRowsFor('801');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'request.notified', outcome: 'error', source: 'poller' });
    expect(JSON.parse(rows[0].detail!)).toMatchObject({ reason: 'no_email_on_record', ssoUsername: 'family', notification: 'held' });
  });

  it('a member row that does not exist at all is surfaced the same way (defensive)', async () => {
    const { transport } = createFakeTransport();
    const notifier = createEnforcementNotifier({ source: 'webhook', transport, now: () => NOW });

    const result = await notifier.notifyHeld({ ssoUsername: 'ghost', seerrRequestId: 802, usageBytes: 600, quotaBytes: 500, shortfallBytes: 100 });

    expect(result).toEqual({ sent: false });
    expect(auditRowsFor('802')[0]).toMatchObject({ outcome: 'error' });
  });

  it('an SMTP failure returns sent:false, writes a failure audit row, and does NOT stamp last_hold_notified_at', async () => {
    seedMember({ ssoUsername: 'jack', seerrUserId: 11 });
    const { transport } = createFakeTransport({ shouldFail: true });
    const notifier = createEnforcementNotifier({ source: 'poller', transport, now: () => NOW });

    const result = await notifier.notifyHeld({ ssoUsername: 'jack', seerrRequestId: 901, usageBytes: 600, quotaBytes: 500, shortfallBytes: 100 });

    expect(result).toEqual({ sent: false });
    expect(memberRow('jack')?.lastHoldNotifiedAt).toBeNull();
    const rows = auditRowsFor('901');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'request.notified', outcome: 'error' });
    const detail = JSON.parse(rows[0].detail!);
    expect(detail.reason).toBe('smtp_send_failed');
    expect(detail.error.message).toContain('ECONNREFUSED');
  });

  it('the held-count figure counts prior holds plus the one just transitioning', async () => {
    seedMember({ ssoUsername: 'overQuota', seerrUserId: 40 });
    seedHoldDecision(1001, 'overQuota');
    seedHoldDecision(1002, 'overQuota');
    // Request 1003's OWN row is not yet in request_decision — this call is
    // for its transition into hold, mirroring ./process.ts's real call order
    // (notifyHeld fires BEFORE the upsert).
    const { transport, sent } = createFakeTransport();
    const notifier = createEnforcementNotifier({ source: 'poller', transport, now: () => NOW });

    await notifier.notifyHeld({ ssoUsername: 'overQuota', seerrRequestId: 1003, usageBytes: 600, quotaBytes: 500, shortfallBytes: 100 });

    expect(sent[0].text).toContain('3 requests are waiting');
  });

  it('two concurrent notifyHeld calls for the same member, across two different notifier instances, send at most once', async () => {
    seedMember({ ssoUsername: 'raceMember', seerrUserId: 50 });
    const { transport, sent } = createFakeTransport();
    // Two SEPARATE instances, as poller.ts/the webhook route each build fresh
    // — sharing only the DB and transport, exactly like two concurrent
    // webhook deliveries would.
    const notifierA = createEnforcementNotifier({ source: 'webhook', transport, now: () => NOW });
    const notifierB = createEnforcementNotifier({ source: 'webhook', transport, now: () => NOW });

    const [a, b] = await Promise.all([
      notifierA.notifyHeld({ ssoUsername: 'raceMember', seerrRequestId: 1101, usageBytes: 600, quotaBytes: 500, shortfallBytes: 100 }),
      notifierB.notifyHeld({ ssoUsername: 'raceMember', seerrRequestId: 1102, usageBytes: 600, quotaBytes: 500, shortfallBytes: 100 }),
    ]);

    expect(sent).toHaveLength(1);
    expect(a).toEqual({ sent: true });
    expect(b).toEqual({ sent: true });
  });
});

// ---------------------------------------------------------------------------
// Unit-level: notifyApproved (FR-ENF-15) / notifyDeclined (FR-ENF-12)
// ---------------------------------------------------------------------------

describe('createEnforcementNotifier — notifyApproved / notifyDeclined', () => {
  it('notifyApproved sends the approved-after-hold email', async () => {
    seedMember({ ssoUsername: 'erin', seerrUserId: 9 });
    const { transport, sent } = createFakeTransport();
    const notifier = createEnforcementNotifier({ source: 'poller', transport, now: () => NOW });

    const result = await notifier.notifyApproved({ ssoUsername: 'erin', seerrRequestId: 212 });

    expect(result).toEqual({ sent: true });
    expect(sent[0].to).toBe('erin@example.com');
    expect(sent[0].text).toContain('#212');
    expect(sent[0].text.toLowerCase()).toContain('approved');
  });

  it('notifyApproved surfaces a missing email rather than skipping silently', async () => {
    seedMember({ ssoUsername: 'family', seerrUserId: 30, email: null });
    const { transport } = createFakeTransport();
    const notifier = createEnforcementNotifier({ source: 'poller', transport, now: () => NOW });

    const result = await notifier.notifyApproved({ ssoUsername: 'family', seerrRequestId: 802 });

    expect(result).toEqual({ sent: false });
    expect(JSON.parse(auditRowsFor('802')[0].detail!)).toMatchObject({ reason: 'no_email_on_record', notification: 'approved' });
  });

  it('notifyDeclined sends the hold_expired email and surfaces an SMTP failure without throwing', async () => {
    seedMember({ ssoUsername: 'erin', seerrUserId: 9 });
    const { transport: okTransport, sent } = createFakeTransport();
    const okNotifier = createEnforcementNotifier({ source: 'poller', transport: okTransport, now: () => NOW });
    await expect(okNotifier.notifyDeclined({ ssoUsername: 'erin', seerrRequestId: 211, reason: 'hold_expired' })).resolves.toEqual({ sent: true });
    expect(sent[0].text).toContain('#211');

    const { transport: failTransport } = createFakeTransport({ shouldFail: true });
    const failNotifier = createEnforcementNotifier({ source: 'poller', transport: failTransport, now: () => NOW });
    await expect(failNotifier.notifyDeclined({ ssoUsername: 'erin', seerrRequestId: 213, reason: 'hold_expired' })).resolves.toEqual({ sent: false });
    expect(JSON.parse(auditRowsFor('213')[0].detail!)).toMatchObject({ reason: 'smtp_send_failed', notification: 'declined' });
  });
});

// ---------------------------------------------------------------------------
// Integration-level: the REAL processPendingRequest wired to the REAL notifier
// ---------------------------------------------------------------------------

describe('processPendingRequest + createEnforcementNotifier, wired together for real', () => {
  it('an SMTP failure leaves the hold decision and its audit row intact, and does NOT set notifiedAt', async () => {
    process.env.ENFORCEMENT_ENABLED = 'true';
    _resetConfigCacheForTests();
    seedMember({ ssoUsername: 'jack', seerrUserId: 11 });
    seedClaim('jack', 999); // over quota
    seedFreshSnapshot();
    const { client, calls } = createFakeSeerrActions([{ id: 1201, status: MediaRequestStatus.PENDING, requestedBySeerrUserId: 11 }]);
    const { transport: failTransport } = createFakeTransport({ shouldFail: true });
    const notifier = createEnforcementNotifier({ source: 'poller', transport: failTransport, now: () => NOW });

    const outcome = await processPendingRequest(1201, 'poller', { seerrActions: client, notifier }, NOW);

    // The decision itself stands, untouched by the mail failure.
    expect(outcome).toEqual({ kind: 'decided', seerrRequestId: 1201, decision: 'hold', reason: 'over_quota' });
    expect(calls.approveRequest).toBe(0);
    const row = decisionRow(1201);
    expect(row).toMatchObject({ decision: 'hold', reason: 'over_quota', heldSince: NOW });
    // "do not mark a notification as sent when it wasn't"
    expect(row?.notifiedAt).toBeNull();

    // Both the ORDINARY decision audit row and MY failure-surfacing row exist
    // — but never a success `request.notified` row (that's only written by
    // ./process.ts when the notifier reports sent:true).
    const rows = auditRowsFor('1201').map((r) => `${r.action}:${r.outcome}`);
    expect(rows).toContain('request.held:ok');
    expect(rows).toContain('request.notified:error');
    expect(rows).not.toContain('request.notified:ok');
    expect(memberRow('jack')?.lastHoldNotifiedAt).toBeNull();
  });

  it('the approved-after-hold notification fires end-to-end when a held member frees enough space', async () => {
    process.env.ENFORCEMENT_ENABLED = 'true';
    _resetConfigCacheForTests();
    seedMember({ ssoUsername: 'erin', seerrUserId: 9 });
    seedClaim('erin', 100); // freed up — now well under the 500-byte quota
    seedFreshSnapshot();
    seedHoldDecision(1301, 'erin', NOW - 1000);
    const { client, calls } = createFakeSeerrActions([{ id: 1301, status: MediaRequestStatus.PENDING, requestedBySeerrUserId: 9 }]);
    const { transport, sent } = createFakeTransport();
    const notifier = createEnforcementNotifier({ source: 'poller', transport, now: () => NOW });

    const outcome = await processPendingRequest(1301, 'poller', { seerrActions: client, notifier }, NOW);

    expect(outcome).toEqual({ kind: 'decided', seerrRequestId: 1301, decision: 'approve', reason: 'under_quota' });
    expect(calls.approveRequest).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('#1301');
    expect(sent[0].text.toLowerCase()).toContain('approved');
    const row = decisionRow(1301);
    expect(row).toMatchObject({ decision: 'approve', heldSince: null, notifiedAt: NOW });
    const rows = auditRowsFor('1301').map((r) => `${r.action}:${r.outcome}`);
    expect(rows).toContain('request.approved:ok');
    expect(rows).toContain('request.notified:ok');
  });
});
