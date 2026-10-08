import { describe, expect, it } from 'vitest';
import { checkMassRevocationRisk, classifyMembers, type OperatorConfig } from '@/lib/members/classify';
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
    loginAlias: overrides.loginAlias ?? null,
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

  it('isOperator is computed from ADMIN_USERS only — no groups source exists for a background sync (existing linked member)', () => {
    const existingRow = existing({ ssoUsername: 'admin', seerrUserId: 1 });
    const out = classifyMembers([seerrUser({ id: 1, username: 'admin' })], new Map([[existingRow.ssoUsername, existingRow]]), NOW, {
      adminUsers: ['admin'],
    });
    expect(out[0].isOperator).toBe(true);
  });

  // --- Second security review (PR #17), item A: fresh-install operator lockout fix ---

  it('FIX (item A): a SINGLE brand-new Seerr user whose derived key matches ADMIN_USERS maps NORMALLY — the ordinary fresh-install case, no longer blocked', () => {
    const out = classifyMembers([seerrUser({ id: 1, username: 'admin' })], new Map(), NOW, { adminUsers: ['admin'] });
    expect(out).toHaveLength(1);
    expect(out[0].ssoUsername).toBe('admin');
    expect(out[0].syncStatus).toBe('matched');
    expect(out[0].seerrUserId).toBe(1);
    expect(out[0].entitled).toBe(true);
    expect(out[0].isOperator).toBe(true);
    expect(out[0].isNew).toBe(true);
  });

  it('fresh install, full operatorConfig: a household of one admin + others all map normally, operator gets isOperator=true, nobody is blocked', () => {
    const out = classifyMembers([seerrUser({ id: 1, username: 'caleb' }), seerrUser({ id: 2, username: 'cait' })], new Map(), NOW, {
      adminUsers: ['caleb'],
    });
    expect(out).toHaveLength(2);
    const caleb = out.find((m) => m.ssoUsername === 'caleb');
    const cait = out.find((m) => m.ssoUsername === 'cait');
    expect(caleb).toMatchObject({ syncStatus: 'matched', seerrUserId: 1, isOperator: true });
    expect(cait).toMatchObject({ syncStatus: 'matched', seerrUserId: 2, isOperator: false });
  });

  it('an ADMIN_USERS key is STILL unsafe when it is ALSO taken by an already-linked member — the admin-reservation alone is never the deciding factor', () => {
    const existingRow = existing({ ssoUsername: 'admin', seerrUserId: 5 });
    const existingMembers = new Map([[existingRow.ssoUsername, existingRow]]);
    // A different, new Seerr account also derives 'admin' as its key.
    const out = classifyMembers(
      [seerrUser({ id: 5, username: 'admin' }), seerrUser({ id: 9, username: 'admin', displayName: 'Impersonator' })],
      existingMembers,
      NOW,
      { adminUsers: ['admin'] },
    );
    const adminRow = out.find((m) => m.ssoUsername === 'admin');
    expect(adminRow?.seerrUserId).toBe(5); // untouched, still the real admin
    const impersonator = out.find((m) => m.ssoUsername === 'seerr:9');
    expect(impersonator?.syncStatus).toBe('ambiguous');
  });

  it('an ADMIN_USERS key is STILL ambiguous when more than one NEW Seerr user races for it (same "orphan key collision" rule as any other key, admin-reserved or not)', () => {
    const out = classifyMembers([seerrUser({ id: 1, username: 'admin' }), seerrUser({ id: 2, username: 'admin' })], new Map(), NOW, {
      adminUsers: ['admin'],
    });
    // The key itself was never taken by anyone, so the shared ambiguous row
    // lands AT 'admin' (same as any ordinary orphan-key collision) — it is
    // NOT matched/linked to either account, so no operator access is
    // actually granted through it (a login resolves here by EXACT match
    // only, and `syncStatus !== 'matched'` always blocks the dashboard).
    const adminRow = out.find((m) => m.ssoUsername === 'admin');
    expect(adminRow?.syncStatus).toBe('ambiguous');
    expect(adminRow?.seerrUserId).toBeNull();
    expect(out).toHaveLength(1);
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

  // --- Security review (PR #17): shared-namespace / linked-row-immutability -----

  describe('a new Seerr user deriving an already-LINKED member\'s key never overwrites that link (PoC scenario 2)', () => {
    const existingRow = existing({ ssoUsername: 'alice', seerrUserId: 5, email: 'alice@x', entitled: true, isOperator: false });
    const existingMembers = new Map([[existingRow.ssoUsername, existingRow]]);

    it('alice (id 5) stays matched/linked; the colliding new account (id 9, username alice) is ambiguous at a seerr:{id} key, alice untouched', () => {
      const users = [
        seerrUser({ id: 5, email: 'alice@x', jellyfinUsername: 'alice2' }), // same account, Seerr renamed its jellyfinUsername
        seerrUser({ id: 9, email: 'evil@x', username: 'alice', displayName: 'Evil' }), // different account deriving the SAME key
      ];
      const out = classifyMembers(users, existingMembers, NOW, { adminUsers: [] });

      const aliceRow = out.find((m) => m.ssoUsername === 'alice');
      expect(aliceRow?.seerrUserId).toBe(5); // untouched — still linked to the real alice
      expect(aliceRow?.email).toBe('alice@x');
      expect(aliceRow?.syncStatus).toBe('matched');

      const evilRow = out.find((m) => m.ssoUsername === 'seerr:9');
      expect(evilRow).toBeDefined();
      expect(evilRow?.seerrUserId).toBeNull();
      expect(evilRow?.syncStatus).toBe('ambiguous');
      expect(evilRow?.syncNote).toContain('already-linked');

      // Exactly 2 rows out — no third/duplicate row, no row lost.
      expect(out).toHaveLength(2);
    });

    it('a two-way collision of two DIFFERENT new accounts on an already-linked key still leaves the linked member untouched and surfaces both as separate ambiguous rows', () => {
      const users = [
        seerrUser({ id: 5, email: 'alice@x', jellyfinUsername: 'alice2' }),
        seerrUser({ id: 9, email: 'evil@x', username: 'alice', displayName: 'Evil' }),
        seerrUser({ id: 10, email: 'e2@x', username: 'alice', displayName: 'E2' }),
      ];
      const out = classifyMembers(users, existingMembers, NOW, { adminUsers: [] });

      const aliceRow = out.find((m) => m.ssoUsername === 'alice');
      expect(aliceRow?.seerrUserId).toBe(5);
      expect(aliceRow?.syncStatus).toBe('matched');

      const evil1 = out.find((m) => m.ssoUsername === 'seerr:9');
      const evil2 = out.find((m) => m.ssoUsername === 'seerr:10');
      expect(evil1).toBeDefined();
      expect(evil2).toBeDefined();
      expect(evil1?.syncStatus).toBe('ambiguous');
      expect(evil2?.syncStatus).toBe('ambiguous');

      expect(out).toHaveLength(3);
    });
  });

  it('a brand-new Seerr user deriving a key that matches another member\'s login_alias is ambiguous, never created at that key', () => {
    const existingRow = existing({ ssoUsername: 'real-dana', seerrUserId: 1, loginAlias: 'dana-newidp' });
    const existingMembers = new Map([[existingRow.ssoUsername, existingRow]]);
    const users = [
      seerrUser({ id: 1, jellyfinUsername: null, username: null, email: null }), // keeps the existing link (no-op)
      seerrUser({ id: 2, username: 'dana-newidp', email: 'someone-else@example.com' }), // derives the SAME string as dana's alias
    ];
    const out = classifyMembers(users, existingMembers, NOW, { adminUsers: [] });

    const danaRow = out.find((m) => m.seerrUserId === 1);
    expect(danaRow?.ssoUsername).toBe('real-dana');

    const colliding = out.find((m) => m.ssoUsername === 'seerr:2');
    expect(colliding).toBeDefined(); // NOT keyed 'dana-newidp'
    expect(colliding?.seerrUserId).toBeNull();
    expect(colliding?.syncStatus).toBe('ambiguous');
    expect(colliding?.syncNote).toContain('login alias');
  });

  it('a carried-forward member that was entitled but never had a confirmed seerr_user_id gets an honest syncNote, not "lost their Seerr account"', () => {
    const existingRow = existing({ ssoUsername: 'seerr:42', seerrUserId: null, entitled: true, syncStatus: 'ambiguous' });
    const existingMembers = new Map([[existingRow.ssoUsername, existingRow]]);
    const out = classifyMembers([], existingMembers, NOW, operatorConfig);
    expect(out[0].entitled).toBe(false);
    expect(out[0].syncNote).not.toContain('Lost their Seerr account');
    expect(out[0].syncNote).toContain('never linked to a confirmed Seerr account');
  });

  it('a carried-forward member that WAS confirmed-linked still gets the "lost their Seerr account" note when it disappears', () => {
    const existingRow = existing({ ssoUsername: 'dana', seerrUserId: 7, entitled: true, syncStatus: 'matched' });
    const existingMembers = new Map([[existingRow.ssoUsername, existingRow]]);
    const out = classifyMembers([], existingMembers, NOW, operatorConfig);
    expect(out[0].syncNote).toContain('Lost their Seerr account');
  });

  // --- Second security review (PR #17), item B: seerr:{id} fallback must not decay ---

  describe('a persisting ambiguous collision (seerr:{id} fallback) across multiple cycles', () => {
    it('is RE-EMITTED, not dropped, on a second cycle where the same collision still holds — no false "lost their Seerr account"', () => {
      const users = [seerrUser({ id: 1, jellyfinUsername: 'shared' }), seerrUser({ id: 2, jellyfinUsername: 'shared', username: 'other', displayName: 'Other' })];
      // Collision arises because 'shared' key is taken by an already-linked member.
      const existingRow = existing({ ssoUsername: 'shared', seerrUserId: 1 });
      const existingMembers = new Map([[existingRow.ssoUsername, existingRow]]);

      const cycle1 = classifyMembers(users, existingMembers, NOW, { adminUsers: [] });
      const fallbackRow1 = cycle1.find((m) => m.ssoUsername === 'seerr:2');
      expect(fallbackRow1).toBeDefined();
      expect(fallbackRow1?.isNew).toBe(true);
      expect(fallbackRow1?.firstSeenAt).toBe(NOW);
      expect(fallbackRow1?.entitled).toBe(true);
      expect(fallbackRow1?.syncStatus).toBe('ambiguous');

      // Persist cycle1's output as the next cycle's "existing" snapshot.
      const existingMembers2 = new Map(cycle1.map((m) => [m.ssoUsername, { ...m, loginAlias: null } as ExistingMemberSnapshot]));
      const NOW2 = NOW + 1000;
      const cycle2 = classifyMembers(users, existingMembers2, NOW2, { adminUsers: [] });

      const fallbackRow2 = cycle2.find((m) => m.ssoUsername === 'seerr:2');
      expect(fallbackRow2).toBeDefined();
      // Re-emitted, not decayed: still entitled+ambiguous, firstSeenAt preserved from cycle 1, isNew now false.
      expect(fallbackRow2?.entitled).toBe(true);
      expect(fallbackRow2?.syncStatus).toBe('ambiguous');
      expect(fallbackRow2?.isNew).toBe(false);
      expect(fallbackRow2?.firstSeenAt).toBe(NOW); // preserved from cycle 1, NOT re-derived as NOW2
      expect(fallbackRow2?.syncNote).not.toContain('Lost their Seerr account');

      // The 'shared' linked row is also unaffected across both cycles.
      expect(cycle2.find((m) => m.ssoUsername === 'shared')?.seerrUserId).toBe(1);
    });

    it('is correctly retired (carried forward not_entitled) once the underlying collision actually resolves', () => {
      const existingFallback = existing({ ssoUsername: 'seerr:2', seerrUserId: null, entitled: true, syncStatus: 'ambiguous', firstSeenAt: NOW - 500 });
      const existingMembers = new Map([[existingFallback.ssoUsername, existingFallback]]);
      // This cycle, Seerr account 2 derives a key that's now free (collision resolved).
      const out = classifyMembers([seerrUser({ id: 2, jellyfinUsername: 'nowfree' })], existingMembers, NOW, { adminUsers: [] });

      expect(out.find((m) => m.ssoUsername === 'nowfree')?.seerrUserId).toBe(2);
      const retiredFallback = out.find((m) => m.ssoUsername === 'seerr:2');
      expect(retiredFallback?.entitled).toBe(false);
      expect(retiredFallback?.syncStatus).toBe('not_entitled');
    });
  });

  // --- Second security review (PR #17), SHOULD-FIX 1: a vanished link must not be stolen ---

  it('a member whose linked Seerr account vanished from the current list is NOT adopted by a different new Seerr account reusing the same username', () => {
    // alice linked to Seerr id 5; this cycle, Seerr id 5 is GONE (deleted),
    // but Seerr id 9 is a brand-new, unrelated account with username 'alice'.
    const existingRow = existing({ ssoUsername: 'alice', seerrUserId: 5, entitled: true, syncStatus: 'matched' });
    const existingMembers = new Map([[existingRow.ssoUsername, existingRow]]);
    const users = [seerrUser({ id: 9, username: 'alice', displayName: 'New Alice?' })];

    const out = classifyMembers(users, existingMembers, NOW, { adminUsers: [] });

    const aliceRow = out.find((m) => m.ssoUsername === 'alice');
    expect(aliceRow?.seerrUserId).toBe(5); // UNTOUCHED — still the real alice's old link
    expect(aliceRow?.entitled).toBe(false); // carried forward as not_entitled (id 5 really is gone)
    expect(aliceRow?.syncStatus).toBe('not_entitled');

    const newAccount = out.find((m) => m.ssoUsername === 'seerr:9');
    expect(newAccount).toBeDefined();
    expect(newAccount?.syncStatus).toBe('ambiguous');
    expect(newAccount?.syncNote).toContain('already-linked');
  });
});

describe('checkMassRevocationRisk (security review, PR #17, item 5)', () => {
  function entitledRow(ssoUsername: string, seerrUserId: number): ReturnType<typeof existing> {
    return existing({ ssoUsername, seerrUserId, entitled: true, syncStatus: 'matched' });
  }

  it('no existing entitled members -> never refuses, regardless of the Seerr list', () => {
    expect(checkMassRevocationRisk(new Map(), [])).toEqual({ refuse: false });
  });

  it('an empty Seerr list while >=1 member is entitled -> refuses', () => {
    const existingMembers = new Map([['dana', entitledRow('dana', 1)]]);
    const result = checkMassRevocationRisk(existingMembers, []);
    expect(result.refuse).toBe(true);
    expect(result.reason).toContain('empty user list');
  });

  it('a normal cycle where everyone is still present -> never refuses', () => {
    const existingMembers = new Map([
      ['dana', entitledRow('dana', 1)],
      ['erin', entitledRow('erin', 2)],
      ['frank', entitledRow('frank', 3)],
    ]);
    const seerrUsers = [1, 2, 3].map((id) => seerrUser({ id, username: `u${id}` }));
    expect(checkMassRevocationRisk(existingMembers, seerrUsers)).toEqual({ refuse: false });
  });

  it('every confirmed-linked member vanishing refuses even with only 1-2 members', () => {
    const existingMembers = new Map([
      ['dana', entitledRow('dana', 1)],
      ['erin', entitledRow('erin', 2)],
    ]);
    const unrelated = [50, 51].map((id) => seerrUser({ id, username: `u${id}` }));
    const result = checkMassRevocationRisk(existingMembers, unrelated);
    expect(result.refuse).toBe(true);
    expect(result.reason).toContain('refusing to mass-revoke');
  });

  it('a forced check accepts large flips but still refuses an empty list', () => {
    const existingMembers = new Map([
      ['dana', entitledRow('dana', 1)],
      ['erin', entitledRow('erin', 2)],
      ['frank', entitledRow('frank', 3)],
    ]);
    expect(checkMassRevocationRisk(existingMembers, [seerrUser({ id: 1, username: 'u1' })], { forced: true })).toEqual({ refuse: false });
    expect(checkMassRevocationRisk(existingMembers, [], { forced: true }).refuse).toBe(true);
  });

  it('losing ONE of three entitled members (33%, under the 50% threshold) -> does not refuse', () => {
    const existingMembers = new Map([
      ['dana', entitledRow('dana', 1)],
      ['erin', entitledRow('erin', 2)],
      ['frank', entitledRow('frank', 3)],
    ]);
    const seerrUsers = [1, 2].map((id) => seerrUser({ id, username: `u${id}` })); // frank (id 3) is gone
    expect(checkMassRevocationRisk(existingMembers, seerrUsers)).toEqual({ refuse: false });
  });

  it('losing more than half of >2 entitled members -> refuses', () => {
    const existingMembers = new Map([
      ['dana', entitledRow('dana', 1)],
      ['erin', entitledRow('erin', 2)],
      ['frank', entitledRow('frank', 3)],
      ['gus', entitledRow('gus', 4)],
    ]);
    const seerrUsers = [1].map((id) => seerrUser({ id, username: `u${id}` })); // 3 of 4 gone (75%)
    const result = checkMassRevocationRisk(existingMembers, seerrUsers);
    expect(result.refuse).toBe(true);
    expect(result.reason).toContain('3 of 4');
  });

  it('a 1-of-1 or 1-of-2 household losing someone is normal churn, not refused (the >2-member carve-out)', () => {
    const oneExisting = new Map([['dana', entitledRow('dana', 1)]]);
    expect(checkMassRevocationRisk(oneExisting, []).refuse).toBe(true); // empty list still refuses regardless of size

    const twoExisting = new Map([
      ['dana', entitledRow('dana', 1)],
      ['erin', entitledRow('erin', 2)],
    ]);
    // erin (id 2) disappears; dana (id 1) remains — 1 of 2 gone (50%), but
    // entitledBefore is not > 2, so the percentage rule doesn't apply.
    expect(checkMassRevocationRisk(twoExisting, [seerrUser({ id: 1, username: 'dana' })]).refuse).toBe(false);
  });

  // --- Second security review (PR #17), SHOULD-FIX 2: exclude unconfirmed (ambiguous) rows ---

  it('a seerrUserId===null entitled row (ambiguous/legacy placeholder) does NOT count toward entitledBefore or wouldFlip', () => {
    const existingMembers = new Map([
      ['dana', entitledRow('dana', 1)],
      ['erin', entitledRow('erin', 2)],
      ['frank', entitledRow('frank', 3)],
      // Four ambiguous placeholders, entitled=true, seerrUserId=null — would
      // have inflated both counts under the old (buggy) implementation.
      ['seerr:90', existing({ ssoUsername: 'seerr:90', seerrUserId: null, entitled: true, syncStatus: 'ambiguous' })],
      ['seerr:91', existing({ ssoUsername: 'seerr:91', seerrUserId: null, entitled: true, syncStatus: 'ambiguous' })],
      ['seerr:92', existing({ ssoUsername: 'seerr:92', seerrUserId: null, entitled: true, syncStatus: 'ambiguous' })],
      ['seerr:93', existing({ ssoUsername: 'seerr:93', seerrUserId: null, entitled: true, syncStatus: 'ambiguous' })],
    ]);
    // All 3 CONFIRMED members remain; an empty list would previously have
    // been read as "7 entitled, all would flip" and refused for the wrong
    // reason — now it's correctly scoped to the 3 confirmed-linked ones.
    const seerrUsers = [1, 2, 3].map((id) => seerrUser({ id, username: `u${id}` }));
    expect(checkMassRevocationRisk(existingMembers, seerrUsers)).toEqual({ refuse: false });
  });

  it('an empty Seerr list while ONLY ambiguous/unconfirmed rows are entitled -> does NOT refuse (nothing confirmed to protect)', () => {
    const existingMembers = new Map([
      ['seerr:90', existing({ ssoUsername: 'seerr:90', seerrUserId: null, entitled: true, syncStatus: 'ambiguous' })],
    ]);
    expect(checkMassRevocationRisk(existingMembers, [])).toEqual({ refuse: false });
  });
});
