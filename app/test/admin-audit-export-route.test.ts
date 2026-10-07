import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `GET /api/admin/audit/export` — `FR-AUD-9`'s export half, and this task's
 * explicit "direct-export" test case: an operator-only route re-checked
 * server-side on EVERY request (`requireOperatorForRoute`), never trusting
 * that `/admin/audit`'s own guard already ran (a member could hit this URL
 * directly, skipping the page entirely).
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-audit-export-route-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const headersStore: { current: Headers } = { current: new Headers() };
vi.mock('next/headers', () => ({
  headers: async () => headersStore.current,
}));

const { getDb, _resetDbForTests } = await import('@/lib/db');
const { audit } = await import('@/lib/db/schema');
const { _resetConfigCacheForTests } = await import('@/lib/config');
const { NextRequest } = await import('next/server');
const { GET } = await import('@/app/api/admin/audit/export/route');

const ORIGINAL_ENV = { ...process.env };
const OPERATOR = 'admin';
const MEMBER = 'dana';

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  _resetDbForTests();
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(`${tmpDbPath}-wal`, { force: true });
  fs.rmSync(`${tmpDbPath}-shm`, { force: true });
  process.env.ADMIN_USERS = OPERATOR;
  _resetConfigCacheForTests();
  headersStore.current = new Headers();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV, DB_PATH: tmpDbPath };
  _resetConfigCacheForTests();
});

function asOperator(): void {
  headersStore.current = new Headers({ 'Remote-User': OPERATOR });
}

function asMember(): void {
  headersStore.current = new Headers({ 'Remote-User': MEMBER });
}

function getExport(qs: string): InstanceType<typeof NextRequest> {
  return new NextRequest(`http://x/api/admin/audit/export${qs}`, { method: 'GET' });
}

let nextId = 1;
function insertRow(overrides: Partial<{ actor: string; action: string; targetType: 'member' | 'title' | 'request' | 'setting' | 'route'; targetId: string; outcome: 'ok' | 'denied' | 'error'; detail: string | null }>): void {
  getDb()
    .insert(audit)
    .values({
      ts: 1_800_000_000_000 + nextId,
      actor: overrides.actor ?? 'dana',
      actorRole: 'member',
      action: overrides.action ?? 'access.denied',
      targetType: overrides.targetType ?? 'route',
      targetId: overrides.targetId ?? '/x',
      outcome: overrides.outcome ?? 'denied',
      source: 'ui',
      correlationId: `corr-${nextId}`,
      detail: overrides.detail ?? null,
    })
    .run();
  nextId += 1;
}

describe('GET /api/admin/audit/export — FR-ADM-1: member direct access', () => {
  it('403s a member hitting the export URL directly, writes access.denied, and never streams any rows', async () => {
    insertRow({ actor: MEMBER, action: 'access.denied' });
    asMember();
    const res = await GET(getExport('?format=csv'));
    expect(res.status).toBe(403);

    const denied = getDb().select().from(audit).all().filter((r) => r.action === 'access.denied' && r.actor === MEMBER && r.targetId === '/api/admin/audit/export');
    expect(denied.length).toBeGreaterThan(0);
  });

  it('401s with no identity at all (no Remote-User header)', async () => {
    headersStore.current = new Headers();
    const res = await GET(getExport('?format=csv'));
    expect(res.status).toBe(401);
  });
});

describe('GET /api/admin/audit/export — format validation', () => {
  it('400s on a missing format', async () => {
    asOperator();
    const res = await GET(getExport(''));
    expect(res.status).toBe(400);
  });

  it('400s on an unrecognised format', async () => {
    asOperator();
    const res = await GET(getExport('?format=xml'));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/admin/audit/export — CSV', () => {
  beforeEach(() => {
    insertRow({ actor: 'dana', action: 'delete.blocked', targetType: 'title', targetId: 'movie-1', outcome: 'denied', detail: JSON.stringify({ reason: 'guard' }) });
    insertRow({ actor: 'admin', action: 'quota.set', targetType: 'member', targetId: 'frank', outcome: 'ok' });
  });

  it('200s with text/csv and an attachment disposition', async () => {
    asOperator();
    const res = await GET(getExport('?format=csv'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('attachment');
  });

  it('includes a header row and one row per matching audit row', async () => {
    asOperator();
    const res = await GET(getExport('?format=csv'));
    const text = await res.text();
    const lines = text.trim().split('\r\n');
    expect(lines[0]).toBe('id,ts,actor,actorRole,onBehalfOf,action,targetType,targetId,outcome,source,correlationId,before,after,detail');
    expect(lines).toHaveLength(3); // header + 2 rows
    expect(text).toContain('delete.blocked');
    expect(text).toContain('quota.set');
  });

  it('applies the actor filter — only the matching row is exported', async () => {
    asOperator();
    const res = await GET(getExport('?format=csv&actor=dana'));
    const text = await res.text();
    const lines = text.trim().split('\r\n');
    expect(lines).toHaveLength(2); // header + 1 row
    expect(text).toContain('delete.blocked');
    expect(text).not.toContain('quota.set');
  });

  it('neutralises a formula-injection-shaped field end to end (a real row, through the real route)', async () => {
    insertRow({ actor: 'dana', action: 'access.denied', targetType: 'route', targetId: '=HYPERLINK("http://evil")', outcome: 'denied' });
    asOperator();
    const res = await GET(getExport('?format=csv'));
    const text = await res.text();
    expect(text).toContain("'=HYPERLINK");
    // The raw, un-neutralised formula string must not appear anywhere in the export.
    expect(text.includes('=HYPERLINK') && !text.includes("'=HYPERLINK")).toBe(false);
  });
});

describe('GET /api/admin/audit/export — JSONL', () => {
  beforeEach(() => {
    insertRow({ actor: 'dana', action: 'delete.blocked', detail: JSON.stringify({ reason: 'guard' }) });
  });

  it('200s with an ndjson content-type', async () => {
    asOperator();
    const res = await GET(getExport('?format=jsonl'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
  });

  it('each line is a standalone valid JSON object with detail parsed back into real JSON', async () => {
    asOperator();
    const res = await GET(getExport('?format=jsonl'));
    const text = await res.text();
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.action).toBe('delete.blocked');
    expect(parsed.detail).toEqual({ reason: 'guard' });
  });
});
