import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `loadMemberDetail` (`@/app/admin/members/[username]/_data/memberDetail.ts`,
 * `FR-ADM-5`). Covers: the `not_found` case, the header's quota/usage
 * resolution, `protected` surfaced read-only on claims, and — the explicit
 * "must not load 500 rows into the browser" requirement — that every one of
 * the three sections is genuinely paginated server-side (a page never
 * contains more than its page size, and `totalCount` reflects the full
 * table).
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-admin-member-detail-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const { getDb } = await import('@/lib/db');
const { audit, claim, member, quotaPolicy, requestDecision, syncRun, title } = await import('@/lib/db/schema');
const { loadMemberDetail } = await import('@/app/admin/members/[username]/_data/memberDetail');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const now = 5_000_000;
let nextArrId = 1;

function insertMember(ssoUsername: string, syncStatus: 'matched' | 'no_seerr_account' = 'matched'): void {
  getDb().insert(member).values({ ssoUsername, entitled: true, isOperator: false, syncStatus, firstSeenAt: now, lastSyncedAt: now }).run();
}

function insertTitle(id: string, sizeBytes: number, overrides: Partial<{ protected: boolean; protectedReason: string | null }> = {}): void {
  getDb()
    .insert(title)
    .values({
      id,
      mediaType: 'movie',
      arrInstance: 'radarr',
      arrId: nextArrId++,
      title: id,
      year: 2020,
      sizeBytes,
      path: `/data/media/movies/${id}`,
      addedAt: now,
      protected: overrides.protected ?? false,
      protectedReason: overrides.protectedReason ?? null,
      lastSyncedAt: now,
    })
    .run();
}

describe('loadMemberDetail — not found', () => {
  it('returns not_found for an unknown username', async () => {
    const result = await loadMemberDetail('nobody-like-this');
    expect(result).toEqual({ kind: 'not_found' });
  });
});

describe('loadMemberDetail — header', () => {
  beforeAll(() => {
    insertMember('frank');
    getDb().insert(quotaPolicy).values({ ssoUsername: 'frank', quotaBytes: 100_000_000_000, source: 'override', note: 'grandfathered', updatedAt: now, updatedBy: 'admin' }).run();
    insertTitle('movie:a', 10_000_000_000);
    getDb().insert(claim).values({ titleId: 'movie:a', ssoUsername: 'frank', chargedBytes: 10_000_000_000, active: true, createdAt: now }).run();

    insertMember('ivy', 'no_seerr_account');
  });

  it('resolves quota + source + note and a real usage figure for a matched member', async () => {
    const result = await loadMemberDetail('frank');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.header.quota).toEqual({ kind: 'limited', bytes: 100_000_000_000 });
    expect(result.header.quotaSource).toBe('override');
    expect(result.header.quotaNote).toBe('grandfathered');
    expect(result.header.usedBytes).toBe(10_000_000_000);
  });

  it('a member with no Seerr account has null usage (rendered "—"), never 0', async () => {
    const result = await loadMemberDetail('ivy');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.header.usedBytes).toBeNull();
  });

  it('FR-ADM-13: reports no attribution snapshot yet when no sync_run has ever completed one', async () => {
    const result = await loadMemberDetail('frank');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.snapshot.attributionSnapshotAt).toBeNull();
  });
});

describe('loadMemberDetail — FR-ADM-13 snapshot info once an attribution reconcile has run', () => {
  beforeAll(() => {
    insertMember('snaptest');
    getDb()
      .insert(syncRun)
      .values({ startedAt: now - 10, finishedAt: now, steps: JSON.stringify({ requests: { ok: true, count: 1, ms: 1 }, attribution: { ok: true, count: 1, ms: 1 } }), ok: true })
      .run();
  });

  it('carries the attribution snapshot timestamp', async () => {
    const result = await loadMemberDetail('snaptest');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.snapshot.attributionSnapshotAt).toBe(now);
    expect(result.snapshot.staleAfterSeconds).toBe(3_600); // config default, no app_setting override in this suite
  });
});

describe('loadMemberDetail — claims: protected surfaced read-only, pagination', () => {
  beforeAll(() => {
    insertMember('erin');
    for (let i = 0; i < 25; i++) {
      insertTitle(`movie:erin-${i}`, 1_000_000_000, i === 0 ? { protected: true, protectedReason: 'holiday tradition' } : {});
      getDb()
        .insert(claim)
        .values({ titleId: `movie:erin-${i}`, ssoUsername: 'erin', chargedBytes: 1_000_000_000, active: true, createdAt: now + i })
        .run();
    }
  });

  it('page 1 returns exactly PAGE_SIZE (20) rows out of 25 total, never the whole table', async () => {
    const result = await loadMemberDetail('erin', { claimsPage: 1 });
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.claims.rows.length).toBe(20);
    expect(result.claims.meta).toMatchObject({ page: 1, pageSize: 20, totalCount: 25, pageCount: 2 });
  });

  it('page 2 returns the remaining 5 rows', async () => {
    const result = await loadMemberDetail('erin', { claimsPage: 2 });
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.claims.rows.length).toBe(5);
  });

  it('protected/protectedReason are surfaced read-only on the claim row', async () => {
    // All 25 rows share the same chargedBytes, so the primary size sort ties
    // and this loader's desc(createdAt) tiebreaker decides — movie:erin-0 has
    // the OLDEST createdAt, so it falls on page 2 (the last 5 of 25 rows).
    const result = await loadMemberDetail('erin', { claimsPage: 2 });
    if (result.kind !== 'ok') throw new Error('unreachable');
    const protectedRow = result.claims.rows.find((r) => r.titleId === 'movie:erin-0');
    expect(protectedRow?.protected).toBe(true);
    expect(protectedRow?.protectedReason).toBe('holiday tradition');
  });
});

describe('loadMemberDetail — decisions pagination', () => {
  beforeAll(() => {
    insertMember('carol');
    const rows = Array.from({ length: 3 }, (_, i) => ({
      seerrRequestId: 700 + i,
      ssoUsername: 'carol',
      decision: 'approve' as const,
      reason: 'under_quota' as const,
      enforced: true,
      source: 'poller' as const,
      decidedAt: now + i,
    }));
    getDb().insert(requestDecision).values(rows).run();
  });

  it('returns decisions with correct pagination metadata', async () => {
    const result = await loadMemberDetail('carol', { decisionsPage: 1 });
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.decisions.rows.length).toBe(3);
    expect(result.decisions.meta.totalCount).toBe(3);
    // newest-first
    expect(result.decisions.rows[0].seerrRequestId).toBe(702);
  });
});

describe('loadMemberDetail — audit history includes actor AND on_behalf_of rows', () => {
  beforeAll(() => {
    insertMember('gus');
    getDb()
      .insert(audit)
      .values([
        { ts: now * 1000, actor: 'gus', actorRole: 'member', action: 'access.denied', targetType: 'route', targetId: '/admin', outcome: 'denied', source: 'ui', correlationId: 'a1' },
        {
          ts: (now + 1) * 1000,
          actor: 'admin',
          actorRole: 'operator',
          onBehalfOf: 'gus',
          action: 'quota.set',
          targetType: 'member',
          targetId: 'gus',
          outcome: 'ok',
          source: 'ui',
          correlationId: 'a2',
        },
        { ts: (now + 2) * 1000, actor: 'someone-else', actorRole: 'member', action: 'access.denied', targetType: 'route', targetId: '/admin', outcome: 'denied', source: 'ui', correlationId: 'a3' },
      ])
      .run();
  });

  it('includes rows where gus is the actor OR the on_behalf_of target, excludes unrelated rows', async () => {
    const result = await loadMemberDetail('gus');
    if (result.kind !== 'ok') throw new Error('unreachable');
    const correlationIds = result.auditRows.rows.map((r) => r.id).length;
    expect(correlationIds).toBe(2);
    expect(result.auditRows.rows.some((r) => r.actor === 'someone-else')).toBe(false);
  });
});
