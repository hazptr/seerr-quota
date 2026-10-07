import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// DB_PATH must be set BEFORE `@/lib/db` is imported (getDb() reads it lazily
// on first call, but we still want an isolated, throwaway file rather than
// the default `/db/seerr-quota.db`, which won't exist/be writable here).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-db-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const { getDb } = await import('@/lib/db');
const { member, quotaPolicy, appSetting, title, claim, playback, requestDecision, deletion, syncRun, audit } =
  await import('@/lib/db/schema');
const { sql } = await import('drizzle-orm');

describe('getDb / ensureSchema — idempotent additive migration at first open (wiki/Data-Model.md, AGENTS.md rule 10)', () => {
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates exactly the ten tables from wiki/Data-Model.md', () => {
    const db = getDb();
    const rows = db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'`,
    );
    const tableNames = rows.map((r) => r.name).sort();
    expect(tableNames).toEqual(
      [
        'member',
        'quota_policy',
        'app_setting',
        'title',
        'claim',
        'playback',
        'request_decision',
        'deletion',
        'sync_run',
        'audit',
      ].sort(),
    );
  });

  it('calling getDb() twice returns the same cached instance and does not re-throw on re-migrate (idempotent at boot)', () => {
    const first = getDb();
    const second = getDb();
    expect(second).toBe(first);
  });

  it('re-running ensureSchema against an already-migrated DB is a no-op, not an error', async () => {
    const { ensureSchema } = await import('@/lib/db');
    const db = getDb();
    expect(() => ensureSchema(db)).not.toThrow();
  });

  it('sets WAL journal mode (wiki/Data-Model.md header: "SQLite ... WAL mode")', () => {
    const db = getDb();
    const [row] = db.all<{ journal_mode: string }>(sql`PRAGMA journal_mode`);
    expect(row.journal_mode).toBe('wal');
  });

  it('member round-trips, and quota_policy.quota_bytes distinguishes null (inherit default) from 0 (unlimited)', () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    db.insert(member)
      .values({
        ssoUsername: 'carol',
        entitled: true,
        isOperator: false,
        syncStatus: 'matched',
        firstSeenAt: now,
        lastSyncedAt: now,
      })
      .run();
    const [carolRow] = db.select().from(member).where(sql`sso_username = 'carol'`).all();
    // last_hold_notified_at (D-4a, FR-ENF-14) is nullable and unset until the first hold notification.
    expect(carolRow.lastHoldNotifiedAt).toBeNull();

    db.insert(quotaPolicy)
      .values({ ssoUsername: 'carol', quotaBytes: null, source: 'default', updatedAt: now, updatedBy: 'system' })
      .run();
    const [inherited] = db.select().from(quotaPolicy).where(sql`sso_username = 'carol'`).all();
    expect(inherited.quotaBytes).toBeNull();

    db.update(quotaPolicy)
      .set({ quotaBytes: 0, source: 'override', updatedAt: now, updatedBy: 'admin' })
      .where(sql`sso_username = 'carol'`)
      .run();
    const [unlimited] = db.select().from(quotaPolicy).where(sql`sso_username = 'carol'`).all();
    expect(unlimited.quotaBytes).toBe(0);
    expect(unlimited.quotaBytes).not.toBeNull();
  });

  it('app_setting stores a JSON-encoded value keyed by setting name', () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    db.insert(appSetting)
      .values({ key: 'default_quota_bytes', value: JSON.stringify(500_000_000_000), updatedAt: now, updatedBy: 'admin' })
      .run();
    const [row] = db.select().from(appSetting).where(sql`key = 'default_quota_bytes'`).all();
    expect(JSON.parse(row.value)).toBe(500_000_000_000);
  });

  it('title carries the denormalised watched_by_anyone/last_played_any_at convenience columns', () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    db.insert(title)
      .values({
        id: 'movie:1',
        mediaType: 'movie',
        arrInstance: 'radarr',
        arrId: 1,
        title: 'Test Movie',
        sizeBytes: 1000,
        path: '/mnt/media/movies/Test Movie',
        protected: false,
        watchedByAnyone: false,
        lastSyncedAt: now,
      })
      .run();
    const [row] = db.select().from(title).where(sql`id = 'movie:1'`).all();
    expect(row.watchedByAnyone).toBe(false);
    expect(row.lastPlayedAnyAt).toBeNull();
  });

  it('claim: two active claimants on one title are EACH charged the full size_bytes (D-3, revised — no split)', () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    db.insert(member)
      .values({ ssoUsername: 'frank', entitled: true, isOperator: false, syncStatus: 'matched', firstSeenAt: now, lastSyncedAt: now })
      .run();
    db.insert(member)
      .values({ ssoUsername: 'dana', entitled: true, isOperator: false, syncStatus: 'matched', firstSeenAt: now, lastSyncedAt: now })
      .run();
    db.insert(title)
      .values({
        id: 'movie:2',
        mediaType: 'movie',
        arrInstance: 'radarr',
        arrId: 2,
        title: 'Shared Movie',
        sizeBytes: 1000,
        path: '/mnt/media/movies/Shared Movie',
        protected: false,
        lastSyncedAt: now,
      })
      .run();
    db.insert(claim)
      .values([
        { titleId: 'movie:2', ssoUsername: 'frank', chargedBytes: 1000, active: true, createdAt: now },
        { titleId: 'movie:2', ssoUsername: 'dana', chargedBytes: 1000, active: true, createdAt: now },
      ])
      .run();
    const rows = db.select().from(claim).where(sql`title_id = 'movie:2' AND active = 1`).all();
    // Both claimants carry the title's FULL size — usage overlaps and must
    // NOT be summed for a fleet total (wiki/Data-Model.md: "Fleet totals go
    // over distinct title_id", FR-ACCT-3). This asserts the per-claim value,
    // not a sum, precisely because summing is the wrong operation now.
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.chargedBytes).toBe(1000);
    }
  });

  it('claim has the documented (sso_username, active) and (title_id, active) indexes', () => {
    const db = getDb();
    const indexes = db.all<{ name: string }>(sql`PRAGMA index_list('claim')`);
    const names = indexes.map((i) => i.name);
    expect(names).toContain('claim_sso_active_idx');
    expect(names).toContain('claim_title_active_idx');
  });

  it('audit has the documented indexes on ts/actor/action/target_id/correlation_id', () => {
    const db = getDb();
    const indexes = db.all<{ name: string }>(sql`PRAGMA index_list('audit')`);
    const names = indexes.map((i) => i.name);
    expect(names).toContain('audit_ts_idx');
    expect(names).toContain('audit_actor_idx');
    expect(names).toContain('audit_action_idx');
    expect(names).toContain('audit_target_id_idx');
    expect(names).toContain('audit_correlation_id_idx');
  });

  it('playback has a composite primary key on (title_id, jellyfin_user_id)', () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    db.insert(playback)
      .values({ titleId: 'movie:2', jellyfinUserId: 'abc123', playCount: 1, lastSyncedAt: now })
      .run();
    // A second row for the SAME (title_id, jellyfin_user_id) pair must violate the PK.
    expect(() =>
      db.insert(playback).values({ titleId: 'movie:2', jellyfinUserId: 'abc123', playCount: 2, lastSyncedAt: now }).run(),
    ).toThrow();
    // A different jellyfin_user_id for the same title is fine.
    expect(() =>
      db.insert(playback).values({ titleId: 'movie:2', jellyfinUserId: 'def456', playCount: 1, lastSyncedAt: now }).run(),
    ).not.toThrow();
  });

  it('request_decision is keyed by seerr_request_id (the idempotency key)', () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    db.insert(requestDecision)
      .values({
        seerrRequestId: 42,
        ssoUsername: 'frank',
        decision: 'hold',
        reason: 'over_quota',
        usageBytes: 2000,
        quotaBytes: 1000,
        source: 'webhook',
        heldSince: now,
        decidedAt: now,
      })
      .run();
    expect(() =>
      db
        .insert(requestDecision)
        .values({
          seerrRequestId: 42,
          ssoUsername: 'frank',
          decision: 'approve',
          reason: 'under_quota',
          usageBytes: 0,
          quotaBytes: 1000,
          source: 'poller',
          decidedAt: now,
        })
        .run(),
    ).toThrow(); // the poller must not be able to re-decide something already decided (D-4)
  });

  it('request_decision: over-quota is a HOLD, not a decline (D-4a) — held_since/notified_at track it', () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    db.insert(requestDecision)
      .values({
        seerrRequestId: 43,
        ssoUsername: 'dana',
        decision: 'hold',
        reason: 'over_quota',
        usageBytes: 2000,
        quotaBytes: 1000,
        source: 'poller',
        seerrStatus: null, // a hold makes NO Seerr call — nothing to record
        heldSince: now,
        decidedAt: now,
      })
      .run();
    const [held] = db.select().from(requestDecision).where(sql`seerr_request_id = 43`).all();
    expect(held.decision).toBe('hold');
    expect(held.seerrStatus).toBeNull();
    expect(held.heldSince).toBe(now);
    expect(held.notifiedAt).toBeNull(); // not yet notified

    // The member frees space; the same row can't be re-inserted (PK), but a
    // real caller would update it — this only asserts the columns exist and
    // round-trip, since the writer itself is a later backlog item.
    db.update(requestDecision)
      .set({ notifiedAt: now + 60 })
      .where(sql`seerr_request_id = 43`)
      .run();
    const [notified] = db.select().from(requestDecision).where(sql`seerr_request_id = 43`).all();
    expect(notified.notifiedAt).toBe(now + 60);
  });

  it('request_decision.reason accepts hold_expired (FR-ENF-12 safety-valve auto-decline)', () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    db.insert(requestDecision)
      .values({
        seerrRequestId: 44,
        ssoUsername: 'erin',
        decision: 'decline',
        reason: 'hold_expired',
        usageBytes: 3000,
        quotaBytes: 1000,
        source: 'poller',
        seerrStatus: 200,
        heldSince: now - 31 * 86400,
        notifiedAt: now,
        decidedAt: now,
      })
      .run();
    const [row] = db.select().from(requestDecision).where(sql`seerr_request_id = 44`).all();
    expect(row.decision).toBe('decline');
    expect(row.reason).toBe('hold_expired');
  });

  it('deletion represents a partial-batch outcome: one row per title, independent state', () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    db.insert(deletion)
      .values([
        { ssoUsername: 'frank', titleId: 'movie:2', mode: 'delete_files', state: 'done', bytesClaimed: 500, requestedAt: now, executedAt: now },
        { ssoUsername: 'frank', titleId: 'movie:1', mode: 'delete_files', state: 'failed', bytesClaimed: 1000, requestedAt: now, error: 'radarr 500' },
      ])
      .run();
    const rows = db.select().from(deletion).all();
    const states = rows.map((r) => r.state).sort();
    expect(states).toEqual(['done', 'failed']);
  });

  it('sync_run.finished_at is nullable — a run can be in progress', () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    db.insert(syncRun).values({ startedAt: now, steps: '{}' }).run();
    const [row] = db.select().from(syncRun).all();
    expect(row.finishedAt).toBeNull();
    expect(row.ok).toBeNull();
  });

  it('audit row round-trips before/after/detail JSON and the ts-is-milliseconds convention', () => {
    const db = getDb();
    const nowMs = Date.now();
    db.insert(audit)
      .values({
        ts: nowMs,
        actor: 'system',
        actorRole: 'system',
        action: 'quota.applied_default',
        outcome: 'ok',
        source: 'cron',
        correlationId: 'test-correlation-1',
        before: JSON.stringify({ quotaBytes: null }),
        after: JSON.stringify({ quotaBytes: 500_000_000_000 }),
      })
      .run();
    const [row] = db.select().from(audit).all();
    expect(row.ts).toBeGreaterThan(1_700_000_000_000); // sanity: looks like ms, not seconds
    expect(JSON.parse(row.after!)).toEqual({ quotaBytes: 500_000_000_000 });
  });
});
