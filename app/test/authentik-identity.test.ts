import { describe, expect, it } from 'vitest';
import type { AuthentikClient, AuthentikApplication, AuthentikPolicyBinding, AuthentikUser } from '@/lib/authentik/client';
import { fetchEntitledIdentities } from '@/lib/authentik/identity';

function authentikWith(app: AuthentikApplication, bindings: AuthentikPolicyBinding[], users: AuthentikUser[]): AuthentikClient {
  return {
    getApplicationBySlug: async (slug: string) => {
      if (slug !== app.slug) throw new Error(`unexpected slug ${slug}`);
      return app;
    },
    listPolicyBindingsForTarget: async (targetUuid: string) => {
      if (targetUuid !== app.uuid) throw new Error(`unexpected target ${targetUuid}`);
      return bindings;
    },
    listActiveUsers: async () => users,
  } as unknown as AuthentikClient;
}

const APP: AuthentikApplication = { uuid: 'app-uuid', slug: 'jellyseerr', name: 'Seerr' };

function bindingFor(pk: number, overrides: Partial<AuthentikPolicyBinding> = {}): AuthentikPolicyBinding {
  return {
    pk: `binding-${pk}`,
    user: pk,
    group: null,
    enabled: true,
    negate: false,
    userObj: { pk, username: `user${pk}`, name: `User ${pk}`, email: `user${pk}@example.com`, isActive: true },
    ...overrides,
  };
}

function userFor(pk: number, overrides: Partial<AuthentikUser> = {}): AuthentikUser {
  return { pk, uuid: `uuid-${pk}`, username: `user${pk}`, name: `User ${pk}`, email: `user${pk}@example.com`, isActive: true, groupNames: [], ...overrides };
}

describe('fetchEntitledIdentities — a realistic full entitled dataset', () => {
  it('reproduces the exact 10-user entitled set with the stable uuid joined in, and carries operator group membership through (admin -> admins)', async () => {
    // A representative "Fields recorded per matched user" dataset.
    // Only admin holds the `admins` group (GET /core/users/?username=admin returns groups_obj for it).
    const live: Array<[string, string, string, string, string[]]> = [
      ['admin', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Admin', 'admin@example.com', ['admins']],
      ['carol', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Carol', 'carol@example.com', []],
      ['ivy', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Ivy', 'ivy@example.com', []],
      ['hank', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Hank', 'hank@example.com', []],
      ['dana', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'Dana', 'dana@example.com', []],
      ['family', '66666666-6666-4666-8666-666666666666', 'Familyily', '', []],
      ['gus', '77777777-7777-4777-8777-777777777777', 'Gus', 'gus@example.com', []],
      ['erin', '88888888-8888-4888-8888-888888888888', 'Erin', 'erin@example.com', []],
      ['jack', '99999999-9999-4999-8999-999999999999', 'Jack', 'jack@example.com', []],
      ['frank', 'ffffffff-ffff-4fff-8fff-ffffffffffff', 'Frank', 'frank@example.com', []],
    ];
    const users: AuthentikUser[] = live.map(([username, uuid, name, email, groupNames], pk) => ({
      pk,
      uuid,
      username,
      name,
      email,
      isActive: true,
      groupNames,
    }));
    const bindings: AuthentikPolicyBinding[] = users.map((u) => ({
      pk: `binding-${u.pk}`,
      user: u.pk,
      group: null,
      enabled: true,
      negate: false,
      userObj: { pk: u.pk, username: u.username, name: u.name, email: u.email, isActive: true },
    }));

    const identities = await fetchEntitledIdentities(authentikWith(APP, bindings, users), 'jellyseerr');

    expect(identities).toHaveLength(10);
    expect(identities.map((i) => i.ssoUsername).sort()).toEqual(
      ['frank', 'jack', 'carol', 'dana', 'admin', 'erin', 'family', 'gus', 'ivy', 'hank'].sort(),
    );
    const frank = identities.find((i) => i.ssoUsername === 'frank');
    expect(frank).toEqual({
      ssoUsername: 'frank',
      authentikUuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      displayName: 'Frank',
      email: 'frank@example.com',
      groupNames: [],
    });
    const family = identities.find((i) => i.ssoUsername === 'family');
    expect(family?.email).toBe(''); // no email on file — never null, per this module's contract
    const admin = identities.find((i) => i.ssoUsername === 'admin');
    expect(admin?.groupNames).toEqual(['admins']);
  });
});

describe('fetchEntitledIdentities — filtering (never guess, never crash)', () => {
  it('excludes a disabled binding', async () => {
    const users = [userFor(1)];
    const bindings = [bindingFor(1, { enabled: false })];
    const identities = await fetchEntitledIdentities(authentikWith(APP, bindings, users), 'jellyseerr');
    expect(identities).toEqual([]);
  });

  it('excludes a negated binding', async () => {
    const users = [userFor(1)];
    const bindings = [bindingFor(1, { negate: true })];
    const identities = await fetchEntitledIdentities(authentikWith(APP, bindings, users), 'jellyseerr');
    expect(identities).toEqual([]);
  });

  it('excludes a group/policy-type binding (user: null) rather than crashing', async () => {
    const bindings: AuthentikPolicyBinding[] = [{ pk: 'b1', user: null, group: 'some-group', enabled: true, negate: false, userObj: null }];
    const identities = await fetchEntitledIdentities(authentikWith(APP, bindings, []), 'jellyseerr');
    expect(identities).toEqual([]);
  });

  it('excludes a user who is inactive per the bulk /core/users/ join, even if the binding user_obj claims active', async () => {
    const users = [userFor(1, { isActive: false })];
    const bindings = [bindingFor(1)]; // userObj.isActive: true, but the fresh join says false
    const identities = await fetchEntitledIdentities(authentikWith(APP, bindings, users), 'jellyseerr');
    expect(identities).toEqual([]);
  });

  it('falls back to the binding user_obj when the bulk users join misses that pk entirely — groupNames is [] (no fallback source for groups)', async () => {
    const bindings = [bindingFor(7)]; // pk 7, userObj present
    const identities = await fetchEntitledIdentities(authentikWith(APP, bindings, []), 'jellyseerr'); // users list empty — join miss
    expect(identities).toEqual([{ ssoUsername: 'user7', authentikUuid: null, displayName: 'User 7', email: 'user7@example.com', groupNames: [] }]);
  });

  it('lowercases ssoUsername', async () => {
    const users = [userFor(1, { username: 'Admin' })];
    const bindings = [bindingFor(1, { userObj: { pk: 1, username: 'Admin', name: 'Admin', email: 'c@x.com', isActive: true } })];
    const identities = await fetchEntitledIdentities(authentikWith(APP, bindings, users), 'jellyseerr');
    expect(identities[0].ssoUsername).toBe('admin');
  });
});

describe('fetchEntitledIdentities — AUTHENTIK_JELLYSEERR_APP_UUID fast path', () => {
  it('when appUuid is supplied, getApplicationBySlug is never called — listPolicyBindingsForTarget goes straight to the given uuid', async () => {
    let getApplicationBySlugCalls = 0;
    let targetUsedForBindings = '';
    const users = [userFor(1)];
    const bindings = [bindingFor(1)];
    const authentik = {
      getApplicationBySlug: async () => {
        getApplicationBySlugCalls++;
        throw new Error('should never be called when appUuid is supplied');
      },
      listPolicyBindingsForTarget: async (targetUuid: string) => {
        targetUsedForBindings = targetUuid;
        return bindings;
      },
      listActiveUsers: async () => users,
    } as unknown as AuthentikClient;

    const identities = await fetchEntitledIdentities(authentik, 'jellyseerr', 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001');

    expect(getApplicationBySlugCalls).toBe(0);
    expect(targetUsedForBindings).toBe('aaaaaaaa-aaaa-4aaa-8aaa-000000000001');
    expect(identities).toHaveLength(1);
  });

  it('when appUuid is omitted, falls back to the detail-by-slug lookup exactly as before', async () => {
    const identities = await fetchEntitledIdentities(authentikWith(APP, [bindingFor(1)], [userFor(1)]), 'jellyseerr');
    expect(identities).toHaveLength(1); // authentikWith's getApplicationBySlug/listPolicyBindingsForTarget assert on APP.slug/APP.uuid internally
  });

  it('a blank-string appUuid is treated the same as omitted (falls back to the slug lookup)', async () => {
    const identities = await fetchEntitledIdentities(authentikWith(APP, [bindingFor(1)], [userFor(1)]), 'jellyseerr', '   ');
    expect(identities).toHaveLength(1);
  });
});
