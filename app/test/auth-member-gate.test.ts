import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// DB_PATH must be set BEFORE `@/lib/db` (imported indirectly via
// `@/lib/auth/memberGate`) is first touched — same pattern as
// test/db.test.ts.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-auth-member-gate-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const { describeMemberGate, getMemberGate } = await import('@/lib/auth/memberGate');
const { getDb } = await import('@/lib/db');
const { member } = await import('@/lib/db/schema');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('describeMemberGate (FR-SSO-8) — pure', () => {
  const adminUsers = ['admin'];

  it('no member row at all -> blocked, reason no_member_row, names the operator, no raw error shape', () => {
    const result = describeMemberGate(undefined, adminUsers);
    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') throw new Error('unreachable');
    expect(result.reason).toBe('no_member_row');
    expect(result.syncStatus).toBeNull();
    expect(result.operatorContact).toBe('admin');
    expect(result.message).toContain('admin');
    expect(result.message).not.toMatch(/error|undefined|null|NaN/i); // never a raw error string
  });

  it('a row with sync_status != matched -> blocked, reason not_matched, carries the status + note', () => {
    const result = describeMemberGate({ syncStatus: 'no_seerr_account', syncNote: 'no Seerr user found for this email' }, adminUsers);
    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') throw new Error('unreachable');
    expect(result.reason).toBe('not_matched');
    expect(result.syncStatus).toBe('no_seerr_account');
    expect(result.syncNote).toBe('no Seerr user found for this email');
    expect(result.message).toContain('admin');
  });

  it('every non-matched sync_status value produces a blocked result (not_entitled, ambiguous)', () => {
    for (const syncStatus of ['not_entitled', 'ambiguous'] as const) {
      const result = describeMemberGate({ syncStatus, syncNote: null }, adminUsers);
      expect(result.status).toBe('blocked');
    }
  });

  it('a matched row -> ok, no message needed (the real dashboard renders normally)', () => {
    const result = describeMemberGate({ syncStatus: 'matched', syncNote: null }, adminUsers);
    expect(result).toEqual({ status: 'ok' });
  });

  it('falls back to a generic "the operator" phrase if ADMIN_USERS is somehow empty (defensive; boot validation normally refuses to start in this state)', () => {
    const result = describeMemberGate(undefined, []);
    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') throw new Error('unreachable');
    expect(result.operatorContact).toBe('the operator');
    expect(result.message).toContain('the operator');
  });
});

describe('getMemberGate — impure shell, real DB lookup', () => {
  it('a username with no member row at all -> blocked/no_member_row', async () => {
    const result = await getMemberGate({ username: 'ghost', displayUsername: 'ghost', groups: [], isOperator: false });
    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') throw new Error('unreachable');
    expect(result.reason).toBe('no_member_row');
  });

  it('a username whose member row is matched -> ok', async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    db.insert(member)
      .values({
        ssoUsername: 'dana',
        entitled: true,
        isOperator: false,
        syncStatus: 'matched',
        firstSeenAt: now,
        lastSyncedAt: now,
      })
      .run();

    const result = await getMemberGate({ username: 'dana', displayUsername: 'dana', groups: [], isOperator: false });
    expect(result).toEqual({ status: 'ok' });
  });

  it('a username whose member row is not matched -> blocked, never an empty/zero-usage-looking result', async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    db.insert(member)
      .values({
        ssoUsername: 'newperson',
        entitled: false,
        isOperator: false,
        syncStatus: 'not_entitled',
        syncNote: 'not in the jellyseerr binding',
        firstSeenAt: now,
        lastSyncedAt: now,
      })
      .run();

    const result = await getMemberGate({ username: 'newperson', displayUsername: 'newperson', groups: [], isOperator: false });
    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') throw new Error('unreachable');
    expect(result.reason).toBe('not_matched');
    expect(result.syncStatus).toBe('not_entitled');
  });

  it('looks up by the canonical lowercased username, not the display casing', async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    db.insert(member)
      .values({
        ssoUsername: 'mixedcase',
        entitled: true,
        isOperator: false,
        syncStatus: 'matched',
        firstSeenAt: now,
        lastSyncedAt: now,
      })
      .run();

    // `member.sso_username` is stored lowercase by convention; the identity
    // carries the same lowercased value in `username` — displayUsername is
    // for UI only and must never be used to look anything up.
    const result = await getMemberGate({ username: 'mixedcase', displayUsername: 'MixedCase', groups: [], isOperator: false });
    expect(result).toEqual({ status: 'ok' });
  });
});
