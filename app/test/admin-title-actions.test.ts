import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

// Isolated throwaway DB file — same pattern as test/quota-policy.test.ts.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-title-actions-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const { getDb, _resetDbForTests } = await import('@/lib/db');
const { audit, title } = await import('@/lib/db/schema');
const { _resetConfigCacheForTests } = await import('@/lib/config');
const { protectTitle, unprotectTitle } = await import('@/app/admin/_actions/titleActions');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  _resetDbForTests();
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(`${tmpDbPath}-wal`, { force: true });
  fs.rmSync(`${tmpDbPath}-shm`, { force: true });
  _resetConfigCacheForTests();
});

const NOW = 1_800_000_000;

function insertTitle(id: string, protectedFlag = false, protectedReason: string | null = null): void {
  getDb()
    .insert(title)
    .values({ id, mediaType: 'movie', arrInstance: 'radarr', arrId: 1, title: id, sizeBytes: 1000, path: `/data/${id}`, protected: protectedFlag, protectedReason, lastSyncedAt: NOW })
    .run();
}

function auditRowsFor(action: string, targetId: string) {
  return getDb()
    .select()
    .from(audit)
    .where(and(eq(audit.action, action as never), eq(audit.targetId, targetId)))
    .all();
}

describe('protectTitle — FR-ADM-7', () => {
  it('rejects an empty reason, writes nothing', () => {
    insertTitle('movie:1');
    const outcome = protectTitle(getDb(), { titleId: 'movie:1', reason: '   ', actor: 'admin' });
    expect(outcome).toEqual({ kind: 'invalid', reason: expect.stringContaining('reason is required') });
    const row = getDb().select().from(title).where(eq(title.id, 'movie:1')).get()!;
    expect(row.protected).toBe(false);
    expect(auditRowsFor('title.protected', 'movie:1')).toHaveLength(0);
  });

  it('returns not_found for an unknown title, writes nothing', () => {
    const outcome = protectTitle(getDb(), { titleId: 'movie:nope', reason: 'a real reason', actor: 'admin' });
    expect(outcome).toEqual({ kind: 'not_found' });
  });

  it('sets protected + reason, writes a title.protected audit row with before/after', () => {
    insertTitle('movie:2');
    const outcome = protectTitle(getDb(), { titleId: 'movie:2', reason: '  keeping this for a rewatch  ', actor: 'admin' });
    expect(outcome).toEqual({ kind: 'ok', titleId: 'movie:2', reason: 'keeping this for a rewatch' });

    const row = getDb().select().from(title).where(eq(title.id, 'movie:2')).get()!;
    expect(row.protected).toBe(true);
    expect(row.protectedReason).toBe('keeping this for a rewatch');

    const rows = auditRowsFor('title.protected', 'movie:2');
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe('admin');
    expect(rows[0].actorRole).toBe('operator');
    expect(JSON.parse(rows[0].before!)).toEqual({ protected: false, protectedReason: null });
    expect(JSON.parse(rows[0].after!)).toEqual({ protected: true, protectedReason: 'keeping this for a rewatch' });
  });

  it('re-protecting an already-protected title overwrites the reason and records the old one as before', () => {
    insertTitle('movie:3', true, 'old reason');
    const outcome = protectTitle(getDb(), { titleId: 'movie:3', reason: 'new reason', actor: 'admin' });
    expect(outcome.kind).toBe('ok');
    const rows = auditRowsFor('title.protected', 'movie:3');
    expect(JSON.parse(rows[0].before!)).toEqual({ protected: true, protectedReason: 'old reason' });
    expect(JSON.parse(rows[0].after!)).toEqual({ protected: true, protectedReason: 'new reason' });
  });
});

describe('unprotectTitle — FR-ADM-7', () => {
  it('returns not_found for an unknown title', () => {
    expect(unprotectTitle(getDb(), { titleId: 'movie:nope', actor: 'admin' })).toEqual({ kind: 'not_found' });
  });

  it('clears protected + reason, writes a title.unprotected audit row', () => {
    insertTitle('movie:4', true, 'keeping this');
    const outcome = unprotectTitle(getDb(), { titleId: 'movie:4', actor: 'admin' });
    expect(outcome).toEqual({ kind: 'ok', titleId: 'movie:4' });

    const row = getDb().select().from(title).where(eq(title.id, 'movie:4')).get()!;
    expect(row.protected).toBe(false);
    expect(row.protectedReason).toBeNull();

    const rows = auditRowsFor('title.unprotected', 'movie:4');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].before!)).toEqual({ protected: true, protectedReason: 'keeping this' });
    expect(JSON.parse(rows[0].after!)).toEqual({ protected: false, protectedReason: null });
  });

  it('unprotecting an already-unprotected title still succeeds and audits (idempotent, not an error)', () => {
    insertTitle('movie:5', false, null);
    const outcome = unprotectTitle(getDb(), { titleId: 'movie:5', actor: 'admin' });
    expect(outcome.kind).toBe('ok');
    expect(auditRowsFor('title.unprotected', 'movie:5')).toHaveLength(1);
  });
});
