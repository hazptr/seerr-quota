import { describe, expect, it } from 'vitest';
import { isInAdminGroup, isOperatorUser, parseGroups, resolveIdentity } from '@/lib/auth/identity';

describe('parseGroups (FR-SSO-3: split on both | and ,)', () => {
  it('splits on pipe', () => {
    expect(parseGroups('family|cooks')).toEqual(['family', 'cooks']);
  });

  it('splits on comma', () => {
    expect(parseGroups('family,cooks')).toEqual(['family', 'cooks']);
  });

  it('splits on a mix of pipe and comma in the same value, trimming whitespace', () => {
    expect(parseGroups(' family | cooks, admins ')).toEqual(['family', 'cooks', 'admins']);
  });

  it('absent/null/empty header -> empty array, never throws (edge case: empty Remote-Groups)', () => {
    expect(parseGroups(undefined)).toEqual([]);
    expect(parseGroups(null)).toEqual([]);
    expect(parseGroups('')).toEqual([]);
  });

  it('drops empty entries produced by doubled/trailing separators', () => {
    expect(parseGroups('family||cooks,,|,')).toEqual(['family', 'cooks']);
  });
});

describe('isOperatorUser (FR-SSO-3: ADMIN_USERS, case-insensitive)', () => {
  it('matches case-insensitively in both directions', () => {
    expect(isOperatorUser('admin', ['admin'])).toBe(true); // usernameLower is always pre-lowercased by callers
    expect(isOperatorUser('admin', ['ADMIN'])).toBe(true);
  });

  it('returns false for a user not on the list', () => {
    expect(isOperatorUser('dana', ['admin'])).toBe(false);
  });

  it('an empty ADMIN_USERS list means nobody is operator via this path', () => {
    expect(isOperatorUser('admin', [])).toBe(false);
  });
});

describe('isInAdminGroup (FR-SSO-3: ADMIN_GROUP, case-insensitive)', () => {
  it('true when groups include the configured admin group', () => {
    expect(isInAdminGroup(['family', 'admins'], 'admins')).toBe(true);
  });

  it('matches case-insensitively on both sides', () => {
    expect(isInAdminGroup(['Admins'], 'admins')).toBe(true);
    expect(isInAdminGroup(['admins'], 'ADMINS')).toBe(true);
  });

  it('false when groups do not include it', () => {
    expect(isInAdminGroup(['family', 'guests'], 'admins')).toBe(false);
  });

  it('false for empty groups', () => {
    expect(isInAdminGroup([], 'admins')).toBe(false);
  });

  it('an empty/blank configured admin group never matches anything (defensive, not a documented config)', () => {
    expect(isInAdminGroup(['admins'], '')).toBe(false);
    expect(isInAdminGroup(['admins'], '   ')).toBe(false);
  });
});

describe('resolveIdentity', () => {
  const adminUsers = ['admin'];
  const adminGroup = 'admins';

  it('returns null when Remote-User is absent (FR-SSO-2: caller 401s on null)', () => {
    expect(resolveIdentity(undefined, 'family', adminUsers, adminGroup)).toBeNull();
    expect(resolveIdentity(null, null, adminUsers, adminGroup)).toBeNull();
  });

  it('returns null for a whitespace-only Remote-User', () => {
    expect(resolveIdentity('   ', null, adminUsers, adminGroup)).toBeNull();
  });

  it('empty/absent Remote-Groups -> member with no groups, never a crash', () => {
    expect(resolveIdentity('dana', undefined, adminUsers, adminGroup)).toEqual({
      username: 'dana',
      displayUsername: 'dana',
      groups: [],
      isOperator: false,
    });
  });

  it('username is lowercased for comparison/storage; the raw (trimmed) value is kept for display', () => {
    const identity = resolveIdentity('  Admin  ', null, adminUsers, adminGroup);
    expect(identity).not.toBeNull();
    expect(identity?.username).toBe('admin'); // canonical, lowercase
    expect(identity?.displayUsername).toBe('Admin'); // raw casing, trimmed only
  });

  it('mixed-case Remote-User still matches ADMIN_USERS (case-insensitive) via the lowercased comparison field', () => {
    const identity = resolveIdentity('ADMIN', null, adminUsers, adminGroup);
    expect(identity?.isOperator).toBe(true);
    expect(identity?.displayUsername).toBe('ADMIN');
  });

  it('operator via ADMIN_USERS membership alone (no admin group)', () => {
    const identity = resolveIdentity('admin', 'family', adminUsers, adminGroup);
    expect(identity?.isOperator).toBe(true);
  });

  it('operator via ADMIN_GROUP membership alone (not in ADMIN_USERS)', () => {
    const identity = resolveIdentity('dana', 'family|admins', adminUsers, adminGroup);
    expect(identity).toEqual({
      username: 'dana',
      displayUsername: 'dana',
      groups: ['family', 'admins'],
      isOperator: true,
    });
  });

  it('neither ADMIN_USERS nor ADMIN_GROUP -> plain member', () => {
    const identity = resolveIdentity('dana', 'family,guests', adminUsers, adminGroup);
    expect(identity).toEqual({
      username: 'dana',
      displayUsername: 'dana',
      groups: ['family', 'guests'],
      isOperator: false,
    });
  });

  it('both | and , in the same Remote-Groups header resolve identically to either alone', () => {
    const identity = resolveIdentity('dana', 'family|guests,extras', adminUsers, adminGroup);
    expect(identity?.groups).toEqual(['family', 'guests', 'extras']);
  });

  it('a member (dana) with unrelated groups is never treated as operator', () => {
    const identity = resolveIdentity('dana', 'family|guests', adminUsers, adminGroup);
    expect(identity?.isOperator).toBe(false);
  });
});

describe('resolveIdentity — reserved seerr: keys', () => {
  it('refuses a login name in the reserved seerr:{id} key shape, any case', () => {
    expect(resolveIdentity('seerr:12', null, ['admin'], '')).toBeNull();
    expect(resolveIdentity('  SEERR:12 ', null, ['admin'], '')).toBeNull();
  });

  it('still accepts names that merely contain "seerr"', () => {
    expect(resolveIdentity('seerrfan', null, ['admin'], '')?.username).toBe('seerrfan');
  });
});
