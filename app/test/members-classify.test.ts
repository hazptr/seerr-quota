import { describe, expect, it } from 'vitest';
import type { AuthentikIdentity } from '@/lib/authentik/identity';
import type { SeerrUserForMatch } from '@/lib/members/seerrUsers';
import type { ExistingMemberSnapshot } from '@/lib/members/types';
import { classifyMembers, type OperatorConfig } from '@/lib/members/classify';

const NOW = 1_800_000_000;

/** Matches src/lib/config.ts's real defaults (ADMIN_USERS=admin, ADMIN_GROUP=admins). */
const OPERATOR_CONFIG: OperatorConfig = { adminUsers: ['admin'], adminGroup: 'admins' };

function identity(ssoUsername: string, overrides: Partial<AuthentikIdentity> = {}): AuthentikIdentity {
  return {
    ssoUsername,
    authentikUuid: `uuid-${ssoUsername}`,
    displayName: ssoUsername,
    email: `${ssoUsername}@example.com`,
    groupNames: [],
    ...overrides,
  };
}

function seerrUser(id: number, overrides: Partial<SeerrUserForMatch> = {}): SeerrUserForMatch {
  return { id, email: `user${id}@example.com`, username: null, displayName: `user${id}`, jellyfinUsername: `user${id}`, jellyfinUserId: `guid-${id}`, ...overrides };
}

function existingSnapshot(ssoUsername: string, overrides: Partial<ExistingMemberSnapshot> = {}): ExistingMemberSnapshot {
  return {
    ssoUsername,
    authentikUuid: null,
    displayName: ssoUsername,
    email: null,
    entitled: false,
    seerrUserId: null,
    jellyfinUserId: null,
    syncStatus: 'not_entitled',
    syncNote: null,
    firstSeenAt: 0,
    isOperator: false,
    ...overrides,
  };
}

const NO_EXISTING: ReadonlyMap<string, ExistingMemberSnapshot> = new Map();

describe('classifyMembers — basic matching (FR-SYNC-2)', () => {
  it('matches by jellyfinUsername, case-insensitively', () => {
    const frank = identity('frank', { email: 'frank-real@example.com' });
    const seerrFrank = seerrUser(8, { jellyfinUsername: 'FRANK', email: 'unrelated@example.com' });
    const out = classifyMembers([frank], [seerrFrank], NO_EXISTING, NOW, OPERATOR_CONFIG);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ ssoUsername: 'frank', syncStatus: 'matched', seerrUserId: 8, syncNote: null, entitled: true, isNew: true });
  });

  it('falls back to email match, case-insensitively, only when username match finds nothing', () => {
    const dana = identity('dana', { email: 'dana@example.com' });
    const seerrDana = seerrUser(4, { jellyfinUsername: null, email: 'dana@example.com' });
    const out = classifyMembers([dana], [seerrDana], NO_EXISTING, NOW, OPERATOR_CONFIG);
    expect(out[0]).toMatchObject({ syncStatus: 'matched', seerrUserId: 4 });
  });

  it('a username hit is never second-guessed by also checking email — even if email would point elsewhere', () => {
    const jack = identity('jack', { email: 'jack@example.com' });
    const usernameMatch = seerrUser(1, { jellyfinUsername: 'jack', email: 'decoy@example.com' });
    const emailMatch = seerrUser(2, { jellyfinUsername: 'someone-else', email: 'jack@example.com' });
    const out = classifyMembers([jack], [usernameMatch, emailMatch], NO_EXISTING, NOW, OPERATOR_CONFIG);
    expect(out[0]).toMatchObject({ syncStatus: 'matched', seerrUserId: 1 });
  });

  it('zero candidates -> no_seerr_account, with a non-null sync_note (FR-SYNC-4)', () => {
    const ivy = identity('ivy');
    const out = classifyMembers([ivy], [], NO_EXISTING, NOW, OPERATOR_CONFIG);
    expect(out[0].syncStatus).toBe('no_seerr_account');
    expect(out[0].syncNote).not.toBeNull();
    expect(out[0].seerrUserId).toBeNull();
    expect(out[0].jellyfinUserId).toBeNull();
  });

  it('an empty/blank email never matches another blank email (family has no email on file)', () => {
    const family = identity('family', { email: '' });
    const someoneElseBlank = seerrUser(50, { jellyfinUsername: 'not-family', email: '' });
    const out = classifyMembers([family], [someoneElseBlank], NO_EXISTING, NOW, OPERATOR_CONFIG);
    expect(out[0].syncStatus).toBe('no_seerr_account'); // NOT matched to the blank-email decoy
  });

  it('jellyfin_user_id is normalised (no dashes, lowercase) on a matched member', () => {
    const frank = identity('frank');
    const rawId = '7BBB-0000-AAAA-1111-000000000000';
    const seerrFrank = seerrUser(8, { jellyfinUsername: 'frank', jellyfinUserId: rawId });
    const out = classifyMembers([frank], [seerrFrank], NO_EXISTING, NOW, OPERATOR_CONFIG);
    expect(out[0].jellyfinUserId).toBe(rawId.replace(/-/g, '').toLowerCase());
    expect(out[0].jellyfinUserId).not.toContain('-');
    expect(out[0].jellyfinUserId).toBe(out[0].jellyfinUserId?.toLowerCase());
  });
});

describe('classifyMembers — ambiguity, never guess (FR-SYNC-3)', () => {
  it('one member matching two Seerr candidates via email fallback -> ambiguous, nothing attributed', () => {
    const twin = identity('twin', { email: 'shared@example.com' });
    const seerrA = seerrUser(10, { jellyfinUsername: null, email: 'shared@example.com' });
    const seerrB = seerrUser(11, { jellyfinUsername: null, email: 'shared@example.com' });
    const out = classifyMembers([twin], [seerrA, seerrB], NO_EXISTING, NOW, OPERATOR_CONFIG);
    expect(out[0]).toMatchObject({ syncStatus: 'ambiguous', seerrUserId: null, jellyfinUserId: null });
    expect(out[0].syncNote).toMatch(/ambiguous/i);
  });

  it('two Seerr users share an email, and TWO different members both fall back to it -> both members ambiguous (acceptance criteria)', () => {
    const memberA = identity('membera', { email: 'shared-household@example.com' });
    const memberB = identity('memberb', { email: 'shared-household@example.com' });
    const seerrA = seerrUser(20, { jellyfinUsername: null, email: 'shared-household@example.com' });
    const seerrB = seerrUser(21, { jellyfinUsername: null, email: 'shared-household@example.com' });
    const out = classifyMembers([memberA, memberB], [seerrA, seerrB], NO_EXISTING, NOW, OPERATOR_CONFIG);
    const a = out.find((m) => m.ssoUsername === 'membera')!;
    const b = out.find((m) => m.ssoUsername === 'memberb')!;
    expect(a.syncStatus).toBe('ambiguous');
    expect(b.syncStatus).toBe('ambiguous');
    expect(a.seerrUserId).toBeNull();
    expect(b.seerrUserId).toBeNull();
  });

  it('a member with a single candidate is still ambiguous if that candidate is ALSO claimed by another member (1:1 in BOTH directions required)', () => {
    // household account scenario: two members' emails both fall back to the SAME single Seerr row.
    const parentA = identity('parenta', { email: 'family@example.com' });
    const parentB = identity('parentb', { email: 'family@example.com' });
    const familyAccount = seerrUser(30, { jellyfinUsername: null, email: 'family@example.com' });
    const out = classifyMembers([parentA, parentB], [familyAccount], NO_EXISTING, NOW, OPERATOR_CONFIG);
    expect(out.every((m) => m.syncStatus === 'ambiguous')).toBe(true);
    expect(out.every((m) => m.seerrUserId === null)).toBe(true);
  });
});

describe('classifyMembers — not_entitled orphans (Seerr row with no Authentik entitlement)', () => {
  it('a Seerr user not claimed by any entitled identity becomes a new not_entitled member, keyed by jellyfinUsername (akadmin scenario)', () => {
    // Orphan-keying convention (confirmed with the operator, documented in Feature-02):
    // jellyfinUsername -> username -> `seerr:{id}`, in that priority — see classify.ts's implementation.
    const akadmin = seerrUser(9, { jellyfinUsername: 'akadmin', username: null, email: null });
    const out = classifyMembers([], [akadmin], NO_EXISTING, NOW, OPERATOR_CONFIG);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ ssoUsername: 'akadmin', entitled: false, syncStatus: 'not_entitled', authentikUuid: null, seerrUserId: 9, isNew: true });
    expect(out[0].syncNote).not.toBeNull();
  });

  it('falls back to username, then to a seerr:{id} key, when jellyfinUsername is absent', () => {
    const localAdmin = seerrUser(9, { jellyfinUsername: null, username: 'localadmin' });
    const out1 = classifyMembers([], [localAdmin], NO_EXISTING, NOW, OPERATOR_CONFIG);
    expect(out1[0].ssoUsername).toBe('localadmin');

    const anonymous = seerrUser(42, { jellyfinUsername: null, username: null });
    const out2 = classifyMembers([], [anonymous], NO_EXISTING, NOW, OPERATOR_CONFIG);
    expect(out2[0].ssoUsername).toBe('seerr:42');
  });

  it('does NOT create an orphan for a Seerr user already claimed (matched OR ambiguous) by an entitled identity', () => {
    const frank = identity('frank');
    const seerrFrank = seerrUser(8, { jellyfinUsername: 'frank' });
    const out = classifyMembers([frank], [seerrFrank], NO_EXISTING, NOW, OPERATOR_CONFIG);
    expect(out).toHaveLength(1); // just frank, no orphan for seerr id 8
    expect(out[0].ssoUsername).toBe('frank');
  });

  it('does NOT overwrite an existing known member from a fresh orphan derivation (never guess)', () => {
    const existing = existingSnapshot('akadmin', {
      displayName: 'akadmin (operator-edited)',
      seerrUserId: 9,
      syncNote: 'operator note',
      firstSeenAt: 100,
    });
    const existingMembers = new Map([['akadmin', existing]]);
    const akadmin = seerrUser(9, { jellyfinUsername: 'akadmin' });
    const out = classifyMembers([], [akadmin], existingMembers, NOW, OPERATOR_CONFIG);
    expect(out).toHaveLength(1);
    expect(out[0].displayName).toBe('akadmin (operator-edited)'); // carried forward, not clobbered by orphan-derivation
    expect(out[0].firstSeenAt).toBe(100);
  });

  it('an orphan whose derived key is itself an ADMIN_USERS entry is flagged isOperator (username-only check — no Authentik data exists for it)', () => {
    const seerrAdmin = seerrUser(99, { jellyfinUsername: 'admin', username: null });
    const out = classifyMembers([], [seerrAdmin], NO_EXISTING, NOW, OPERATOR_CONFIG);
    expect(out[0]).toMatchObject({ ssoUsername: 'admin', isOperator: true });
  });
});

describe('classifyMembers — losing entitlement (FR-SYNC-6)', () => {
  it('a previously matched, entitled member absent from this cycle\'s entitled set flips to entitled=false, not_entitled, and carries forward identity/history', () => {
    const existing = existingSnapshot('nora', {
      authentikUuid: 'uuid-nora',
      displayName: 'Nora',
      email: 'nora@example.com',
      entitled: true,
      seerrUserId: 55,
      jellyfinUserId: 'guid-55',
      syncStatus: 'matched',
      firstSeenAt: 500,
    });
    const existingMembers = new Map([['nora', existing]]);
    const out = classifyMembers([], [], existingMembers, NOW, OPERATOR_CONFIG); // nora no longer entitled this cycle
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ ssoUsername: 'nora', entitled: false, syncStatus: 'not_entitled', seerrUserId: 55, jellyfinUserId: 'guid-55', isNew: false, firstSeenAt: 500 });
    expect(out[0].syncNote).toMatch(/lost/i);
  });

  it('a member already not_entitled and still not entitled is carried forward unchanged (no re-derivation)', () => {
    const existing = existingSnapshot('milo', { displayName: 'Milo', syncNote: 'previously not_entitled', firstSeenAt: 200 });
    const existingMembers = new Map([['milo', existing]]);
    const out = classifyMembers([], [], existingMembers, NOW, OPERATOR_CONFIG);
    expect(out[0]).toMatchObject({ ssoUsername: 'milo', entitled: false, syncStatus: 'not_entitled', syncNote: 'previously not_entitled', firstSeenAt: 200 });
  });

  it('re-entitlement: a formerly not_entitled member reappearing in the entitled set is reclassified normally (matched/no_seerr_account/ambiguous), not stuck as not_entitled', () => {
    const existing = existingSnapshot('hank', {
      authentikUuid: 'uuid-hank',
      displayName: 'Hank',
      email: 'hank@example.com',
      syncNote: 'was not_entitled',
      firstSeenAt: 300,
    });
    const existingMembers = new Map([['hank', existing]]);
    const hank = identity('hank', { email: 'hank@example.com' });
    const out = classifyMembers([hank], [], existingMembers, NOW, OPERATOR_CONFIG);
    expect(out[0]).toMatchObject({ ssoUsername: 'hank', entitled: true, syncStatus: 'no_seerr_account', isNew: false, firstSeenAt: 300 });
  });
});

describe('classifyMembers — isNew / first_seen_at bookkeeping (FR-SYNC-1, FR-SYNC-5 support)', () => {
  it('a brand-new entitled member is isNew:true with firstSeenAt = nowSeconds', () => {
    const ivy = identity('ivy');
    const out = classifyMembers([ivy], [], NO_EXISTING, NOW, OPERATOR_CONFIG);
    expect(out[0]).toMatchObject({ isNew: true, firstSeenAt: NOW });
  });

  it('an already-known entitled member keeps its original firstSeenAt and isNew:false', () => {
    const existing = existingSnapshot('dana', {
      authentikUuid: 'uuid-dana',
      displayName: 'Dana',
      email: 'dana@example.com',
      entitled: true,
      seerrUserId: 4,
      jellyfinUserId: 'guid-4',
      syncStatus: 'matched',
      firstSeenAt: 42,
    });
    const existingMembers = new Map([['dana', existing]]);
    const dana = identity('dana', { email: 'dana@example.com' });
    const seerrDana = seerrUser(4, { jellyfinUsername: 'dana' });
    const out = classifyMembers([dana], [seerrDana], existingMembers, NOW, OPERATOR_CONFIG);
    expect(out[0]).toMatchObject({ isNew: false, firstSeenAt: 42 });
  });
});

describe('classifyMembers — operator status (FR-ENF-6), computed via the SAME src/lib/auth/identity.ts helpers request-time auth uses', () => {
  it('an entitled identity in ADMIN_GROUP is isOperator:true, even with a username not in ADMIN_USERS', () => {
    const someAdmin = identity('someadmin', { groupNames: ['admins'] });
    const out = classifyMembers([someAdmin], [], NO_EXISTING, NOW, OPERATOR_CONFIG);
    expect(out[0].isOperator).toBe(true);
  });

  it('an entitled identity whose USERNAME is in ADMIN_USERS is isOperator:true, even with no admin group', () => {
    const admin = identity('admin', { groupNames: [] });
    const out = classifyMembers([admin], [], NO_EXISTING, NOW, OPERATOR_CONFIG);
    expect(out[0].isOperator).toBe(true);
  });

  it('an entitled identity with neither is isOperator:false', () => {
    const carol = identity('carol', { groupNames: ['friends'] });
    const out = classifyMembers([carol], [], NO_EXISTING, NOW, OPERATOR_CONFIG);
    expect(out[0].isOperator).toBe(false);
  });

  it('ADMIN_GROUP comparison is case-insensitive, matching src/lib/auth/identity.ts exactly', () => {
    const someAdmin = identity('someadmin', { groupNames: ['Admins'] });
    const out = classifyMembers([someAdmin], [], NO_EXISTING, NOW, OPERATOR_CONFIG);
    expect(out[0].isOperator).toBe(true);
  });

  it('a carried-forward (not currently entitled) member re-checks the cheap username half fresh, OR\'d with the prior recorded value (group half cannot be re-verified without fresh Authentik data)', () => {
    // Was operator via group membership while still entitled; now outside the entitled set this cycle
    // (no fresh Authentik data at all) — the prior group-derived grant is carried forward rather than dropped.
    const existing = existingSnapshot('formeradmin', { entitled: true, syncStatus: 'matched', isOperator: true });
    const existingMembers = new Map([['formeradmin', existing]]);
    const out = classifyMembers([], [], existingMembers, NOW, OPERATOR_CONFIG);
    expect(out[0].isOperator).toBe(true); // carried forward, not silently dropped

    // A member who was never an operator, and isn't in ADMIN_USERS, stays false.
    const existing2 = existingSnapshot('regularperson', { entitled: true, syncStatus: 'matched', isOperator: false });
    const existingMembers2 = new Map([['regularperson', existing2]]);
    const out2 = classifyMembers([], [], existingMembers2, NOW, OPERATOR_CONFIG);
    expect(out2[0].isOperator).toBe(false);

    // A member added to ADMIN_USERS after losing entitlement DOES get promptly flagged (the username
    // half is always cheap/current) even though we have no fresh group data for them.
    const existing3 = existingSnapshot('admin', { entitled: true, syncStatus: 'matched', isOperator: false });
    const existingMembers3 = new Map([['admin', existing3]]);
    const out3 = classifyMembers([], [], existingMembers3, NOW, OPERATOR_CONFIG);
    expect(out3[0].isOperator).toBe(true);
  });
});

describe('classifyMembers — the documented correctness bar (wiki/Feature-02-Account-Sync.md worked table)', () => {
  it('reproduces every documented classification exactly: 6 matched, 4 no_seerr_account, 1 not_entitled (akadmin)', () => {
    const entitledUsernames = ['admin', 'carol', 'dana', 'erin', 'jack', 'frank', 'ivy', 'hank', 'family', 'gus'];
    const entitled = entitledUsernames.map((u) =>
      identity(u, { email: u === 'family' ? '' : `${u}@example.com`, groupNames: u === 'admin' ? ['admins'] : [] }),
    );

    // Only admin/carol/dana/erin/jack/frank have Seerr rows (7 users
    // total = 6 matched + akadmin). jellyfinUsername mirrors the Authentik username, matching
    // the real shape Seerr returns (e.g. requestedBy.jellyfinUsername === 'frank').
    const matchedUsernames = ['admin', 'carol', 'dana', 'erin', 'jack', 'frank'];
    const seerrUsers: SeerrUserForMatch[] = [
      ...matchedUsernames.map((u, i) => seerrUser(i + 1, { jellyfinUsername: u, email: `${u}@example.com` })),
      seerrUser(9, { jellyfinUsername: null, username: 'akadmin', displayName: 'akadmin', email: null }),
    ];

    const out = classifyMembers(entitled, seerrUsers, NO_EXISTING, NOW, OPERATOR_CONFIG);

    for (const u of matchedUsernames) {
      const row = out.find((m) => m.ssoUsername === u);
      expect(row?.syncStatus, `${u} should be matched`).toBe('matched');
      expect(row?.entitled).toBe(true);
    }
    for (const u of ['ivy', 'hank', 'family', 'gus']) {
      const row = out.find((m) => m.ssoUsername === u);
      expect(row?.syncStatus, `${u} should be no_seerr_account`).toBe('no_seerr_account');
      expect(row?.entitled).toBe(true);
    }
    const akadmin = out.find((m) => m.ssoUsername === 'akadmin');
    expect(akadmin?.syncStatus).toBe('not_entitled');
    expect(akadmin?.entitled).toBe(false);

    // admin is the operator (admins group) — no one else is.
    expect(out.find((m) => m.ssoUsername === 'admin')?.isOperator).toBe(true);
    for (const u of entitledUsernames.filter((u) => u !== 'admin')) {
      expect(out.find((m) => m.ssoUsername === u)?.isOperator, u).toBe(false);
    }

    expect(out).toHaveLength(11); // 10 entitled + 1 orphan (akadmin)
  });
});
