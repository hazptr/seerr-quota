/**
 * `FR-DEL-24` (who may cancel) and `FR-DEL-28` (the quota interlock). Nothing
 * here touches an upstream — cancelling is a local state change by design.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-deletion-cancel-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const { getDb, _resetDbForTests } = await import('@/lib/db');
const { member, title, claim, deletion, audit, appSetting, quotaPolicy } = await import('@/lib/db/schema');
const { _resetConfigCacheForTests } = await import('@/lib/config');
const { cancelScheduledDeletion } = await import('@/lib/deletion/cancel');
const { getEffectiveUsageBytes } = await import('@/lib/enforcement/usage');

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const NOW = 1_800_000_000;

beforeEach(() => {
  _resetDbForTests();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${tmpDbPath}${suffix}`, { force: true });
  _resetConfigCacheForTests();
});

function seedMember(ssoUsername: string, isOperator = false): void {
  getDb().insert(member).values({ ssoUsername, entitled: true, isOperator, syncStatus: 'matched', firstSeenAt: NOW - 1000, lastSyncedAt: NOW - 10 }).run();
}

function seedTitle(id: string, sizeBytes = 1000): void {
  getDb()
    .insert(title)
    .values({
      id, mediaType: 'movie', arrInstance: 'radarr', arrId: 1, title: `Title ${id}`, year: 2020,
      sizeBytes, path: `/data/${id}`, protected: false, protectedReason: null,
      watchedByAnyone: false, lastPlayedAnyAt: null, lastSyncedAt: NOW - 30,
    })
    .run();
}

function seedClaim(titleId: string, ssoUsername: string, chargedBytes = 1000): void {
  getDb().insert(claim).values({ titleId, ssoUsername, seerrRequestId: null, chargedBytes, active: true, createdAt: NOW - 500 }).run();
}

function seedScheduled(ssoUsername: string, titleId: string, bytesClaimed = 1000, scheduledFor = NOW + 3600): number {
  return getDb()
    .insert(deletion)
    .values({ ssoUsername, titleId, mode: 'delete_files', state: 'scheduled', bytesClaimed, requestedAt: NOW - 60, scheduledFor })
    .returning({ id: deletion.id })
    .get().id;
}

function setDefaultQuota(bytes: number): void {
  getDb().insert(appSetting).values({ key: 'default_quota_bytes', value: String(bytes), updatedAt: NOW, updatedBy: 'test' }).run();
}

describe('cancelScheduledDeletion — FR-DEL-24 authority', () => {
  it('the member who scheduled it can cancel: state -> cancelled, bytes go back onto their books, audit row written', () => {
    seedMember('dana');
    seedTitle('movie:1');
    seedClaim('movie:1', 'dana');
    const id = seedScheduled('dana', 'movie:1');

    expect(getEffectiveUsageBytes(getDb(), 'dana')).toBe(0);

    const result = cancelScheduledDeletion({ username: 'dana', isOperator: false }, id, { nowSeconds: NOW });

    expect(result).toMatchObject({ outcome: 'cancelled', deletionId: id, bytesRestored: 1000 });
    const row = getDb().select().from(deletion).where(eq(deletion.id, id)).get()!;
    expect(row).toMatchObject({ state: 'cancelled', cancelledBy: 'dana', cancelReason: 'owner_cancelled', cancelledAt: NOW });
    expect(getEffectiveUsageBytes(getDb(), 'dana')).toBe(1000);

    const acted = getDb().select({ a: audit.action }).from(audit).all().map((r) => r.a);
    expect(acted).toContain('delete.cancelled');
  });

  it('the operator can cancel someone else’s, and the audit row records whose it was via on_behalf_of', () => {
    seedMember('dana');
    seedMember('admin', true);
    seedTitle('movie:1');
    seedClaim('movie:1', 'dana');
    const id = seedScheduled('dana', 'movie:1');

    const result = cancelScheduledDeletion({ username: 'admin', isOperator: true }, id, { nowSeconds: NOW });

    expect(result.outcome).toBe('cancelled');
    expect(getDb().select().from(deletion).where(eq(deletion.id, id)).get()!.cancelReason).toBe('operator_cancelled');
    const row = getDb().select().from(audit).where(eq(audit.action, 'delete.cancelled')).get()!;
    expect(row.onBehalfOf).toBe('dana');
  });

  it('FR-DEL-14 restated: another member cannot cancel it, and gets the SAME answer as a nonexistent id — no existence leak', () => {
    seedMember('dana');
    seedMember('erin');
    seedTitle('movie:1');
    seedClaim('movie:1', 'dana');
    const id = seedScheduled('dana', 'movie:1');

    const notMine = cancelScheduledDeletion({ username: 'erin', isOperator: false }, id, { nowSeconds: NOW });
    const notReal = cancelScheduledDeletion({ username: 'erin', isOperator: false }, 99_999, { nowSeconds: NOW });

    expect(notMine.outcome).toBe('not_found');
    expect(notReal.outcome).toBe('not_found');
    // And crucially, the pending deletion is untouched.
    expect(getDb().select().from(deletion).where(eq(deletion.id, id)).get()!.state).toBe('scheduled');
  });

  it('a row that already left `scheduled` cannot be cancelled twice', () => {
    seedMember('dana');
    seedTitle('movie:1');
    seedClaim('movie:1', 'dana');
    const id = seedScheduled('dana', 'movie:1');

    expect(cancelScheduledDeletion({ username: 'dana', isOperator: false }, id, { nowSeconds: NOW }).outcome).toBe('cancelled');
    // Second attempt finds nothing still `scheduled` — reported as not_found,
    // never as a second successful cancellation.
    expect(cancelScheduledDeletion({ username: 'dana', isOperator: false }, id, { nowSeconds: NOW }).outcome).toBe('not_found');
  });
});

describe('cancelScheduledDeletion — FR-DEL-28 quota interlock', () => {
  it('refuses a member’s cancel that would put them back over quota, naming the overage, and leaves the row scheduled', () => {
    setDefaultQuota(1500);
    seedMember('dana');
    // 1000 charged and pending deletion, plus 1200 of other claims: effective
    // usage is 1200 (under 1500), but restoring the 1000 would make it 2200.
    seedTitle('movie:1', 1000);
    seedTitle('movie:2', 1200);
    seedClaim('movie:1', 'dana', 1000);
    seedClaim('movie:2', 'dana', 1200);
    const id = seedScheduled('dana', 'movie:1', 1000);

    const result = cancelScheduledDeletion({ username: 'dana', isOperator: false }, id, { nowSeconds: NOW });

    expect(result).toMatchObject({ outcome: 'would_exceed_quota', overageBytes: 700, quotaBytes: 1500 });
    expect(getDb().select().from(deletion).where(eq(deletion.id, id)).get()!.state).toBe('scheduled');
    const denied = getDb().select().from(audit).where(eq(audit.outcome, 'denied')).get()!;
    expect(denied.action).toBe('access.denied');
  });

  it('allows the cancel when it still fits under quota', () => {
    setDefaultQuota(5000);
    seedMember('dana');
    seedTitle('movie:1', 1000);
    seedClaim('movie:1', 'dana', 1000);
    const id = seedScheduled('dana', 'movie:1', 1000);

    expect(cancelScheduledDeletion({ username: 'dana', isOperator: false }, id, { nowSeconds: NOW }).outcome).toBe('cancelled');
  });

  it('the OPERATOR is exempt — undoing a member’s mistaken delete is exactly what the interlock must not block', () => {
    setDefaultQuota(1500);
    seedMember('dana');
    seedMember('admin', true);
    seedTitle('movie:1', 1000);
    seedTitle('movie:2', 1200);
    seedClaim('movie:1', 'dana', 1000);
    seedClaim('movie:2', 'dana', 1200);
    const id = seedScheduled('dana', 'movie:1', 1000);

    expect(cancelScheduledDeletion({ username: 'admin', isOperator: true }, id, { nowSeconds: NOW }).outcome).toBe('cancelled');
  });

  it('an unlimited member (quota_bytes = 0) is never blocked by the interlock', () => {
    setDefaultQuota(1500);
    seedMember('carol');
    getDb().insert(quotaPolicy).values({ ssoUsername: 'carol', quotaBytes: 0, source: 'override', note: null, updatedAt: NOW, updatedBy: 'test' }).run();
    seedTitle('movie:1', 9_000_000);
    seedClaim('movie:1', 'carol', 9_000_000);
    const id = seedScheduled('carol', 'movie:1', 9_000_000);

    expect(cancelScheduledDeletion({ username: 'carol', isOperator: false }, id, { nowSeconds: NOW }).outcome).toBe('cancelled');
  });
});
