import { describe, expect, it } from 'vitest';
import { classifyMembers, type OperatorConfig } from '@/lib/members/classify';
import type { SeerrUserForMatch } from '@/lib/members/seerrUsers';
import type { ExistingMemberSnapshot } from '@/lib/members/types';

const NOW = 1_700_000_000;
const operatorConfig: OperatorConfig = { adminUsers: ['admin'] };

function seerrUser(overrides: Partial<SeerrUserForMatch> & { id: number }): SeerrUserForMatch {
  return {
    id: overrides.id,
    email: overrides.email ?? null,
    username: overrides.username ?? null,
    displayName: overrides.displayName ?? null,
    jellyfinUsername: overrides.jellyfinUsername ?? null,
    jellyfinUserId: overrides.jellyfinUserId ?? null,
  };
}

function existing(overrides: Partial<ExistingMemberSnapshot> & { ssoUsername: string }): ExistingMemberSnapshot {
  return {
    ssoUsername: overrides.ssoUsername,
    authentikUuid: overrides.authentikUuid ?? null,
    displayName: overrides.displayName ?? null,
    email: overrides.email ?? null,
    entitled: overrides.entitled ?? true,
    seerrUserId: overrides.seerrUserId ?? null,
    jellyfinUserId: overrides.jellyfinUserId ?? null,
    syncStatus: overrides.syncStatus ?? 'matched',
    syncNote: overrides.syncNote ?? null,
    firstSeenAt: overrides.firstSeenAt ?? NOW - 1000,
    isOperator: overrides.isOperator ?? false,
  };
}

describe('classifyMembers — roster source is Seerr directly (0.2.0)', () => {
  it('every current Seerr user with no existing row becomes a brand-new, entitled, matched member', () => {
    const users = [seerrUser({ id: 1, jellyfinUsername: 'dana', email: 'dana@example.com', displayName: 'Dana' })];
    const out = classifyMembers(users, new Map(), NOW, operatorConfig);
    expect(out).toEqual([
      {
        ssoUsername: 'dana',
        authentikUuid: null,
        displayName: 'Dana',
        email: 'dana@example.com',
        entitled: true,
        seerrUserId: 1,
        jellyfinUserId: null,
        syncStatus: 'matched',
        syncNote: null,
        isNew: true,
        firstSeenAt: NOW,
        isOperator: false,
      },
    ]);
  });

  it('new-row key priority: jellyfinUsername > username > email > seerr:{id}', () => {
    const byUsername = classifyMembers([seerrUser({ id: 1, username: 'erin', email: 'erin@example.com' })], new Map(), NOW, operatorConfig);
    expect(byUsername[0].ssoUsername).toBe('erin');

    const byEmail = classifyMembers([seerrUser({ id: 2, email: 'frank@example.com' })], new Map(), NOW, operatorConfig);
    expect(byEmail[0].ssoUsername).toBe('frank@example.com');

    const byId = classifyMembers([seerrUser({ id: 3 })], new Map(), NOW, operatorConfig);
    expect(byId[0].ssoUsername).toBe('seerr:3');
  });

  it('key derivation lowercases and trims, matching the pre-0.2.0 convention', () => {
    const out = classifyMembers([seerrUser({ id: 1, jellyfinUsername: '  Dana  ' })], new Map(), NOW, operatorConfig);
    expect(out[0].ssoUsername).toBe('dana');
  });

  // --- CRITICAL: production continuity (task item 2) ---------------------

  it('an existing member row already linked to a Seerr user (seerr_user_id set) KEEPS its sso_username forever, even if the Seerr-side username/jellyfinUsername changes', () => {
    const existingRow = existing({ ssoUsername: 'legacy-login-name', seerrUserId: 42, email: 'dana@example.com' });
    const existingMembers = new Map([[existingRow.ssoUsername, existingRow]]);
    // Seerr now reports a totally different jellyfinUsername/email for the same account id.
    const users = [seerrUser({ id: 42, jellyfinUsername: 'brand-new-name', email: 'dana-new@example.com', displayName: 'Dana' })];

    const out = classifyMembers(users, existingMembers, NOW, operatorConfig);

    expect(out).toHaveLength(1);
    expect(out[0].ssoUsername).toBe('legacy-login-name'); // NOT 'brand-new-name'
    expect(out[0].seerrUserId).toBe(42);
    expect(out[0].entitled).toBe(true);
    expect(out[0].syncStatus).toBe('matched');
    expect(out[0].isNew).toBe(false);
  });

  it('never creates a duplicate row for a Seerr user already linked to an existing member', () => {
    const existingRow = existing({ ssoUsername: 'dana', seerrUserId: 42 });
    const existingMembers = new Map([[existingRow.ssoUsername, existingRow]]);
    const users = [seerrUser({ id: 42, jellyfinUsername: 'dana' })];

    const out = classifyMembers(users, existingMembers, NOW, operatorConfig);
    expect(out).toHaveLength(1);
    expect(out.filter((m) => m.seerrUserId === 42)).toHaveLength(1);
  });

  it('a genuinely new Seerr user (no linked row) creates exactly one new member row', () => {
    const existingRow = existing({ ssoUsername: 'dana', seerrUserId: 1 });
    const existingMembers = new Map([[existingRow.ssoUsername, existingRow]]);
    const users = [seerrUser({ id: 1, jellyfinUsername: 'dana' }), seerrUser({ id: 2, jellyfinUsername: 'erin' })];

    const out = classifyMembers(users, existingMembers, NOW, operatorConfig);
    expect(out).toHaveLength(2);
    const erin = out.find((m) => m.seerrUserId === 2);
    expect(erin).toBeDefined();
    expect(erin?.ssoUsername).toBe('erin');
    expect(erin?.isNew).toBe(true);
  });

  it('a Seerr user removed from Seerr -> existing member flips entitled=false/not_entitled and the row is KEPT', () => {
    const existingRow = existing({ ssoUsername: 'dana', seerrUserId: 42, entitled: true, syncStatus: 'matched' });
    const existingMembers = new Map([[existingRow.ssoUsername, existingRow]]);

    const out = classifyMembers([], existingMembers, NOW, operatorConfig); // Seerr no longer lists this user at all

    expect(out).toHaveLength(1);
    expect(out[0].ssoUsername).toBe('dana');
    expect(out[0].entitled).toBe(false);
    expect(out[0].syncStatus).toBe('not_entitled');
    expect(out[0].seerrUserId).toBe(42); // linkage preserved for history
    expect(out[0].syncNote).toContain('Lost their Seerr account');
  });

  it('a member already not_entitled before this cycle, still absent from Seerr, is carried forward unchanged (no repeated "lost" note)', () => {
    const existingRow = existing({
      ssoUsername: 'dana',
      seerrUserId: null,
      entitled: false,
      syncStatus: 'not_entitled',
      syncNote: 'some earlier note',
    });
    const existingMembers = new Map([[existingRow.ssoUsername, existingRow]]);

    const out = classifyMembers([], existingMembers, NOW, operatorConfig);
    expect(out[0].syncNote).toBe('some earlier note');
  });

  it('a legacy orphan row (pre-0.2.0, no seerr_user_id, keyed by the derived convention) gets LINKED rather than duplicated when its Seerr account resurfaces', () => {
    const existingRow = existing({ ssoUsername: 'akadmin', seerrUserId: null, entitled: false, syncStatus: 'not_entitled' });
    const existingMembers = new Map([[existingRow.ssoUsername, existingRow]]);
    const users = [seerrUser({ id: 99, username: 'akadmin' })];

    const out = classifyMembers(users, existingMembers, NOW, operatorConfig);
    expect(out).toHaveLength(1);
    expect(out[0].ssoUsername).toBe('akadmin');
    expect(out[0].seerrUserId).toBe(99);
    expect(out[0].entitled).toBe(true);
    expect(out[0].isNew).toBe(false); // existing row reused, not created fresh
  });

  // --- Orphan key collisions ----------------------------------------------

  it('two distinct NEW Seerr users deriving the identical key are both surfaced as a single ambiguous row, neither linked', () => {
    const users = [seerrUser({ id: 1, jellyfinUsername: 'shared' }), seerrUser({ id: 2, jellyfinUsername: 'shared' })];
    const out = classifyMembers(users, new Map(), NOW, operatorConfig);
    expect(out).toHaveLength(1);
    expect(out[0].ssoUsername).toBe('shared');
    expect(out[0].syncStatus).toBe('ambiguous');
    expect(out[0].seerrUserId).toBeNull();
    expect(out[0].syncNote).toContain('1');
    expect(out[0].syncNote).toContain('2');
  });

  // --- Operator status (FR-ENF-6, background half: ADMIN_USERS only) -----

  it('isOperator is computed from ADMIN_USERS only — no groups source exists for a background sync', () => {
    const out = classifyMembers([seerrUser({ id: 1, username: 'admin' })], new Map(), NOW, { adminUsers: ['admin'] });
    expect(out[0].isOperator).toBe(true);
  });

  it('a non-admin-listed Seerr user is never operator', () => {
    const out = classifyMembers([seerrUser({ id: 1, username: 'dana' })], new Map(), NOW, { adminUsers: ['admin'] });
    expect(out[0].isOperator).toBe(false);
  });

  it('an existing operator flag is preserved (OR-ed) for a carried-forward member even after losing entitlement', () => {
    const existingRow = existing({ ssoUsername: 'dana', seerrUserId: null, entitled: true, isOperator: true });
    const existingMembers = new Map([[existingRow.ssoUsername, existingRow]]);
    const out = classifyMembers([], existingMembers, NOW, { adminUsers: [] });
    expect(out[0].isOperator).toBe(true);
  });

  // --- first_seen_at / displayName fallbacks ------------------------------

  it('firstSeenAt is carried forward for a linked existing row, set to nowSeconds for a brand-new one', () => {
    const existingRow = existing({ ssoUsername: 'dana', seerrUserId: 1, firstSeenAt: 111 });
    const existingMembers = new Map([[existingRow.ssoUsername, existingRow]]);
    const out = classifyMembers([seerrUser({ id: 1 }), seerrUser({ id: 2, username: 'erin' })], existingMembers, NOW, operatorConfig);
    expect(out.find((m) => m.seerrUserId === 1)?.firstSeenAt).toBe(111);
    expect(out.find((m) => m.seerrUserId === 2)?.firstSeenAt).toBe(NOW);
  });

  it('displayName falls back to username, then the derived key, when Seerr has no displayName', () => {
    const byUsername = classifyMembers([seerrUser({ id: 1, username: 'gus' })], new Map(), NOW, operatorConfig);
    expect(byUsername[0].displayName).toBe('gus');

    const byKey = classifyMembers([seerrUser({ id: 2 })], new Map(), NOW, operatorConfig);
    expect(byKey[0].displayName).toBe('seerr:2');
  });

  it('jellyfinUserId is normalised (dashes stripped, lowercased) exactly as before 0.2.0', () => {
    const out = classifyMembers(
      [seerrUser({ id: 1, username: 'dana', jellyfinUserId: 'AAAA-BBBB-CCCC-DDDD' })],
      new Map(),
      NOW,
      operatorConfig,
    );
    expect(out[0].jellyfinUserId).toBe('aaaabbbbccccdddd');
  });

  it('no Seerr users and no existing members -> empty output, never throws', () => {
    expect(classifyMembers([], new Map(), NOW, operatorConfig)).toEqual([]);
  });
});
