import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-audit-remote-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const { getDb } = await import('@/lib/db');
const { audit } = await import('@/lib/db/schema');
const { runRemoteEffect } = await import('@/lib/audit/remote');
const { readAuditRowsByCorrelationId } = await import('@/lib/audit/write');
const { summarizeError } = await import('@/lib/audit/redact');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('runRemoteEffect — intent row before the call, outcome row after, sharing a correlationId (FR-AUD-8, remote half)', () => {
  it('success path: exactly one intent row and one outcome row, in order, sharing correlationId', async () => {
    const db = getDb();
    const result = await runRemoteEffect(db, {
      intent: {
        actor: 'dana',
        actorRole: 'member',
        action: 'delete.requested',
        targetType: 'title',
        targetId: 'movie:10',
        source: 'ui',
        detail: { mode: 'delete_files' },
      },
      call: async () => ({ status: 200, bytesFreed: 12_345 }),
      onSuccess: (value) => ({
        action: 'delete.executed',
        outcome: 'ok',
        targetType: 'title',
        targetId: 'movie:10',
        detail: { arrStatus: value.status, bytesFreed: value.bytesFreed },
      }),
      onFailure: (error) => ({
        action: 'delete.failed',
        outcome: 'error',
        targetType: 'title',
        targetId: 'movie:10',
        detail: summarizeError(error),
      }),
    });

    expect(result.bytesFreed).toBe(12_345);

    const rows = db.select().from(audit).all();
    expect(rows).toHaveLength(2);
    const [intentRow, outcomeRow] = [...rows].sort((a, b) => a.id - b.id);
    expect(intentRow.action).toBe('delete.requested');
    expect(outcomeRow.action).toBe('delete.executed');
    expect(outcomeRow.outcome).toBe('ok');
    expect(intentRow.correlationId).toBe(outcomeRow.correlationId);
    expect(intentRow.ts).toBeLessThanOrEqual(outcomeRow.ts);
  });

  it('failure path: the outcome row records the failure and the ORIGINAL error is rethrown, never swallowed', async () => {
    const db = getDb();
    const upstreamError = new Error('Radarr 500: internal server error');

    await expect(
      runRemoteEffect(db, {
        intent: {
          actor: 'jack',
          actorRole: 'member',
          action: 'delete.requested',
          targetType: 'title',
          targetId: 'movie:11',
          source: 'ui',
        },
        call: async () => {
          throw upstreamError;
        },
        onSuccess: () => ({ action: 'delete.executed', outcome: 'ok', targetType: 'title', targetId: 'movie:11' }),
        onFailure: (error) => ({
          action: 'delete.failed',
          outcome: 'error',
          targetType: 'title',
          targetId: 'movie:11',
          detail: summarizeError(error),
        }),
      }),
    ).rejects.toBe(upstreamError);

    const rows = db.select().from(audit).all();
    const forThisTitle = rows.filter((r) => r.targetId === 'movie:11');
    expect(forThisTitle).toHaveLength(2);
    const actions = forThisTitle.map((r) => r.action).sort();
    expect(actions).toEqual(['delete.failed', 'delete.requested']);
    const outcomeRow = forThisTitle.find((r) => r.action === 'delete.failed')!;
    expect(outcomeRow.outcome).toBe('error');
    expect(JSON.parse(outcomeRow.detail!)).toEqual({ name: 'Error', message: 'Radarr 500: internal server error' });
  });

  it('a crash mid-call leaves exactly the intent row, with no matching outcome row — the acceptance criterion, proven directly', async () => {
    const db = getDb();
    let releaseCall: () => void = () => {};
    const pendingCall = new Promise<void>((resolve) => {
      releaseCall = resolve;
    });

    const correlationId = 'crash-mid-call-test';
    const runPromise = runRemoteEffect(db, {
      intent: {
        actor: 'erin',
        actorRole: 'member',
        action: 'delete.requested',
        targetType: 'title',
        targetId: 'movie:12',
        source: 'ui',
        correlationId,
      },
      call: async () => {
        await pendingCall; // simulates the call being "in flight" when the process would crash
        return { status: 200 };
      },
      onSuccess: () => ({ action: 'delete.executed', outcome: 'ok', targetType: 'title', targetId: 'movie:12' }),
      onFailure: (error) => ({ action: 'delete.failed', outcome: 'error', targetType: 'title', targetId: 'movie:12', detail: summarizeError(error) }),
    });

    // Give the intent write's synchronous work (and the microtask that starts
    // `call()`) a chance to run before we inspect the DB.
    await Promise.resolve();
    await Promise.resolve();

    const midFlightRows = readAuditRowsByCorrelationId(db, correlationId);
    expect(midFlightRows).toHaveLength(1);
    expect(midFlightRows[0].action).toBe('delete.requested');
    // This IS the ambiguity the spec asks to be made visible: at this exact
    // point, a real process crash would leave the log looking exactly like this.

    releaseCall();
    await runPromise;

    const afterRows = readAuditRowsByCorrelationId(db, correlationId);
    expect(afterRows).toHaveLength(2);
  });

  it('an explicit correlationId on the intent is honored (not overwritten with a fresh one)', async () => {
    const db = getDb();
    const explicitId = 'operator-batch-42';
    await runRemoteEffect(db, {
      intent: {
        actor: 'admin',
        actorRole: 'operator',
        action: 'delete.requested',
        targetType: 'title',
        targetId: 'movie:13',
        source: 'ui',
        correlationId: explicitId,
      },
      call: async () => 'ok',
      onSuccess: () => ({ action: 'delete.executed', outcome: 'ok', targetType: 'title', targetId: 'movie:13' }),
      onFailure: (error) => ({ action: 'delete.failed', outcome: 'error', targetType: 'title', targetId: 'movie:13', detail: summarizeError(error) }),
    });
    const rows = readAuditRowsByCorrelationId(db, explicitId);
    expect(rows).toHaveLength(2);
  });
});
