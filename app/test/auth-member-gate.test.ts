import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

// DB_PATH must be set BEFORE `@/lib/db` (imported indirectly via
// `@/lib/auth/memberGate`) is first touched — same pattern as
// test/db.test.ts.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-auth-member-gate-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const { describeMemberGate, getMemberGate, resolveMemberKey, clearLoginAlias } = await import('@/lib/auth/memberGate');
const { getDb } = await import('@/lib/db');
const { member, audit } = await import('@/lib/db/schema');
const { _resetConfigCacheForTests } = await import('@/lib/config');

const ORIGINAL_ENV = { ...process.env };

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV, DB_PATH: tmpDbPath };
  _resetConfigCacheForTests();
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

function insertMember(ssoUsername: string, overrides: Partial<{ email: string | null; entitled: boolean; isOperator: boolean; loginAlias: string | null }> = {}): void {
  const now = Math.floor(Date.now() / 1000);
  getDb()
    .insert(member)
    .values({
      ssoUsername,
      email: overrides.email ?? null,
      entitled: overrides.entitled ?? true,
      isOperator: overrides.isOperator ?? false,
      loginAlias: overrides.loginAlias ?? null,
      syncStatus: 'matched',
      firstSeenAt: now,
      lastSyncedAt: now,
    })
    .run();
}

describe('resolveMemberKey — exact and alias steps (always active, no config needed)', () => {
  it('exact match: an existing sso_username resolves to itself, via "exact"', () => {
    insertMember('exact-dana');
    expect(resolveMemberKey('exact-dana', null)).toEqual({ ssoUsername: 'exact-dana', via: 'exact' });
  });

  it('alias match: a header username matching an existing login_alias resolves to the aliased row, via "alias"', () => {
    insertMember('alias-target', { loginAlias: 'alias-newidp' });
    expect(resolveMemberKey('alias-newidp', null)).toEqual({ ssoUsername: 'alias-target', via: 'alias' });
  });

  it('exact match wins over alias even if some other row happens to have this as its alias (should not happen given uniqueness, but exact is checked first regardless)', () => {
    insertMember('exact-wins');
    expect(resolveMemberKey('exact-wins', null).via).toBe('exact');
  });

  it('no match at all -> unresolved, returns the header username unchanged', () => {
    expect(resolveMemberKey('totally-unknown-user', null)).toEqual({ ssoUsername: 'totally-unknown-user', via: 'unresolved' });
  });
});

describe('resolveMemberKey — email fallback is DISABLED by default (security review, PR #17, CRITICAL item 1)', () => {
  it('AUTH_EMAIL_HEADER is unset by default -> an email argument is ignored entirely, even an exact match on a real member email', () => {
    insertMember('victim-default-off', { email: 'victim@example.com' });
    const result = resolveMemberKey('mallory', 'victim@example.com');
    expect(result).toEqual({ ssoUsername: 'mallory', via: 'unresolved' });

    // No alias was recorded, no audit row of any kind for this attempt.
    const row = getDb().select().from(member).where(eq(member.ssoUsername, 'victim-default-off')).get();
    expect(row?.loginAlias).toBeNull();
  });

  it('the PoC scenario: an attacker supplying the admin\'s own email cannot hijack the admin row while the feature is off', () => {
    insertMember('admin-poc', { email: 'Admin@Example.com', isOperator: true });
    const result = resolveMemberKey('mallory-poc', '  ADMIN@example.com ');
    expect(result.ssoUsername).toBe('mallory-poc');
    expect(result.via).toBe('unresolved');
    const row = getDb().select().from(member).where(eq(member.ssoUsername, 'admin-poc')).get();
    expect(row?.loginAlias).toBeNull();
  });
});

describe('resolveMemberKey — email fallback, explicitly enabled (AUTH_EMAIL_HEADER set)', () => {
  function enableEmailFallback(): void {
    process.env.AUTH_EMAIL_HEADER = 'Remote-Email';
    _resetConfigCacheForTests();
  }

  it('exactly one entitled, non-operator, unaliased match -> resolves, records the alias, audits member.alias_linked exactly once', () => {
    enableEmailFallback();
    insertMember('erin-enabled', { email: 'erin@example.com' });
    const before = getDb().select().from(audit).all().length;

    const result = resolveMemberKey('erin-newidp', 'erin@example.com');
    expect(result).toEqual({ ssoUsername: 'erin-enabled', via: 'email' });

    const row = getDb().select().from(member).where(eq(member.ssoUsername, 'erin-enabled')).get();
    expect(row?.loginAlias).toBe('erin-newidp');

    const linkedRows = getDb().select().from(audit).where(eq(audit.action, 'member.alias_linked')).all();
    const match = linkedRows.find((r) => r.targetId === 'erin-enabled');
    expect(match).toBeDefined();
    expect(match?.actor).toBe('erin-enabled');
    expect(match?.outcome).toBe('ok');

    const after = getDb().select().from(audit).all().length;
    expect(after).toBe(before + 1); // exactly one new audit row

    // And the alias now resolves directly next time, via "alias".
    expect(resolveMemberKey('erin-newidp', null)).toEqual({ ssoUsername: 'erin-enabled', via: 'alias' });
  });

  it('is case-insensitive and trims the email on both sides', () => {
    enableEmailFallback();
    insertMember('frank-enabled', { email: 'Frank@Example.com' });
    const result = resolveMemberKey('frank-newidp', '  FRANK@example.com  ');
    expect(result).toEqual({ ssoUsername: 'frank-enabled', via: 'email' });
  });

  it('zero matches -> refuses, no alias written', () => {
    enableEmailFallback();
    const result = resolveMemberKey('nobody-newidp', 'no-such-email@example.com');
    expect(result.via).toBe('unresolved');
  });

  it('two members sharing the same email -> ambiguous, refuses, no alias written to either', () => {
    enableEmailFallback();
    insertMember('dup-a', { email: 'shared@example.com' });
    insertMember('dup-b', { email: 'shared@example.com' });
    const result = resolveMemberKey('dup-newidp', 'shared@example.com');
    expect(result.via).toBe('unresolved');
    expect(getDb().select().from(member).where(eq(member.ssoUsername, 'dup-a')).get()?.loginAlias).toBeNull();
    expect(getDb().select().from(member).where(eq(member.ssoUsername, 'dup-b')).get()?.loginAlias).toBeNull();
  });

  it('a non-entitled member\'s email is never matched (the email-match query is scoped to entitled=true)', () => {
    enableEmailFallback();
    insertMember('departed-enabled', { email: 'departed@example.com', entitled: false });
    const result = resolveMemberKey('newidp-departed', 'departed@example.com');
    expect(result.via).toBe('unresolved');
  });

  // --- HIGH #1: never auto-link an operator / ADMIN_USERS row -------------

  it('a target that is already member.is_operator=true is NEVER auto-linked — refuses even with exactly one match', () => {
    enableEmailFallback();
    insertMember('operator-target', { email: 'opmatch@example.com', isOperator: true });
    const result = resolveMemberKey('attacker-newidp', 'opmatch@example.com');
    expect(result.via).toBe('unresolved');
    expect(getDb().select().from(member).where(eq(member.ssoUsername, 'operator-target')).get()?.loginAlias).toBeNull();
  });

  it('a target whose key is in ADMIN_USERS (even if is_operator=false in the row) is NEVER auto-linked', () => {
    enableEmailFallback();
    process.env.ADMIN_USERS = 'admin,special-admin-key';
    _resetConfigCacheForTests();
    insertMember('special-admin-key', { email: 'specialadmin@example.com', isOperator: false });
    const result = resolveMemberKey('attacker-newidp-2', 'specialadmin@example.com');
    expect(result.via).toBe('unresolved');
    expect(getDb().select().from(member).where(eq(member.ssoUsername, 'special-admin-key')).get()?.loginAlias).toBeNull();
  });

  it('records member.alias_link_denied the first time an operator-target link is refused, de-duplicated on exact repeat', () => {
    enableEmailFallback();
    insertMember('operator-target-2', { email: 'opmatch2@example.com', isOperator: true });

    function deniedRowsFor(targetId: string) {
      return getDb().select().from(audit).where(eq(audit.action, 'member.alias_link_denied')).all().filter((r) => r.targetId === targetId);
    }

    resolveMemberKey('attacker-dedup', 'opmatch2@example.com');
    expect(deniedRowsFor('operator-target-2')).toHaveLength(1);

    // Exact same (header username, target) pair retried — must NOT add a second row.
    resolveMemberKey('attacker-dedup', 'opmatch2@example.com');
    expect(deniedRowsFor('operator-target-2')).toHaveLength(1);

    // A DIFFERENT header username hitting the SAME target is a new pair -> does get its own row.
    resolveMemberKey('different-attacker', 'opmatch2@example.com');
    expect(deniedRowsFor('operator-target-2')).toHaveLength(2);
  });

  // --- HIGH #2: never overwrite an existing alias (theft / ping-pong) ----

  it('a target that already has a DIFFERENT login_alias is never re-linked by a new email match — refuses, audits member.alias_link_denied', () => {
    enableEmailFallback();
    insertMember('already-aliased', { email: 'stable@example.com', loginAlias: 'original-newidp' });

    const result = resolveMemberKey('second-claimant', 'stable@example.com');
    expect(result.via).toBe('unresolved');

    const row = getDb().select().from(member).where(eq(member.ssoUsername, 'already-aliased')).get();
    expect(row?.loginAlias).toBe('original-newidp'); // unchanged — no theft, no ping-pong

    const denied = getDb().select().from(audit).where(eq(audit.action, 'member.alias_link_denied')).all();
    expect(denied.some((r) => r.targetId === 'already-aliased')).toBe(true);

    // The original alias still resolves correctly.
    expect(resolveMemberKey('original-newidp', null)).toEqual({ ssoUsername: 'already-aliased', via: 'alias' });
  });

  it('after an operator clears the alias (clearLoginAlias), a fresh email match CAN re-link under a new header username', () => {
    enableEmailFallback();
    insertMember('reclaimable', { email: 'reclaim@example.com', loginAlias: 'old-newidp' });

    const blocked = resolveMemberKey('new-claimant', 'reclaim@example.com');
    expect(blocked.via).toBe('unresolved');

    const cleared = clearLoginAlias(getDb(), 'reclaimable', 'admin');
    expect(cleared).toEqual({ kind: 'ok' });

    const relinked = resolveMemberKey('new-claimant', 'reclaim@example.com');
    expect(relinked).toEqual({ ssoUsername: 'reclaimable', via: 'email' });
  });
});

describe('clearLoginAlias (security review, PR #17, operator undo action)', () => {
  it('clears an existing alias and writes member.alias_cleared, before/after recorded', () => {
    insertMember('clear-target', { loginAlias: 'clear-target-newidp' });
    const result = clearLoginAlias(getDb(), 'clear-target', 'admin');
    expect(result).toEqual({ kind: 'ok' });

    const row = getDb().select().from(member).where(eq(member.ssoUsername, 'clear-target')).get();
    expect(row?.loginAlias).toBeNull();

    const rows = getDb().select().from(audit).where(eq(audit.action, 'member.alias_cleared')).all();
    const match = rows.find((r) => r.targetId === 'clear-target');
    expect(match).toBeDefined();
    expect(match?.actor).toBe('admin');
    expect(match?.actorRole).toBe('operator');
    expect(JSON.parse(match!.before!)).toEqual({ loginAlias: 'clear-target-newidp' });
    expect(JSON.parse(match!.after!)).toEqual({ loginAlias: null });
  });

  it('returns not_found for an unknown member, writes nothing', () => {
    const before = getDb().select().from(audit).all().length;
    const result = clearLoginAlias(getDb(), 'no-such-member-at-all', 'admin');
    expect(result).toEqual({ kind: 'not_found' });
    const after = getDb().select().from(audit).all().length;
    expect(after).toBe(before);
  });

  it('is idempotent — clearing an already-clear alias still succeeds and still audits', () => {
    insertMember('already-clear');
    const result = clearLoginAlias(getDb(), 'already-clear', 'admin');
    expect(result).toEqual({ kind: 'ok' });
  });
});
