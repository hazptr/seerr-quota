/**
 * Composes the three raw `AuthentikClient` calls into the entitled-identity
 * set `FR-SYNC-1` needs — "enumerate Authentik users and determine, for each,
 * whether they hold the `jellyseerr` application binding." This is still
 * Authentik-shape-specific (it knows about `pk`-based joins and binding
 * fields), so it lives here rather than in `src/lib/members/`, which should
 * only ever see the flat `AuthentikIdentity` shape below.
 *
 * Steps:
 *   1. `getApplicationBySlug` — resolve the `jellyseerr` app UUID. Skipped
 *      entirely when `appUuid` is supplied (`AUTHENTIK_JELLYSEERR_APP_UUID`,
 *      `src/lib/config.ts`) — the UUID is static (a
 *      `local.proxy_services` terraform key), so a configured deployment
 *      never needs to call this endpoint at all, one fewer per-cycle request
 *      against the sibling of the endpoint documented unreliable
 *      (`?slug=` list form).
 *   2. `listPolicyBindingsForTarget` — the entitlement source.
 *   3. `listActiveUsers` — joined on `pk` to attach the stable `uuid` (and to
 *      confirm the user is still active) that the binding's embedded
 *      `user_obj` can't supply on its own. Also the ONLY source of group
 *      membership (`groupNames`) this sync has — needed for
 *      `member.is_operator` (`FR-ENF-6`).
 */
import type { AuthentikClient } from './client';

export interface AuthentikIdentity {
  /** Authentik username, LOWERCASED — the canonical `member.sso_username` value (matches `src/lib/auth/identity.ts`'s convention for the same header-derived value). */
  ssoUsername: string;
  /** `null` only if the bulk `/core/users/` join genuinely missed this pk (the user was deactivated/deleted between the two calls) — see the fallback note below. */
  authentikUuid: string | null;
  displayName: string;
  /** `''` when Authentik has no email on file (e.g. a shared `family` account) — never `null`, so callers can match/compare without a null check. */
  email: string;
  /**
   * Group NAMES (not UUIDs), from the bulk `/core/users/` join's
   * `groups_obj[].name`. `[]` (never inferred/guessed) when that join missed
   * this `pk` — the binding's own `user_obj` carries no group data at all, so
   * there is no fallback source the way there is for `displayName`/`email`.
   * `src/lib/members/sync.ts` ORs this against `ADMIN_USERS` (via the SAME
   * `isOperatorUser`/`isInAdminGroup` helpers `src/lib/auth/identity.ts` uses
   * at request time) to compute `member.is_operator` — see that file for why
   * importing rather than reimplementing matters here.
   */
  groupNames: string[];
}

/**
 * `GET /policies/bindings/?target=<uuid>` + `GET /core/users/?is_active=true`,
 * joined on `pk`, filtered to bindings that actually grant entitlement.
 *
 * A binding is excluded (not entitled) when:
 *   - `enabled === false` or `negate === true` — Authentik's own binding
 *     fields for "this grant is currently switched off."
 *   - `user === null` — a group/policy-type binding. A fleet's bindings may
 *     all be user-type with no group grants; this is a defensive skip
 *     (never crash), not a claim that a group binding could never appear.
 *   - the bound user is not active — preferring the fresh `is_active` flag
 *     from the bulk `/core/users/` join, falling back to the binding's own
 *     embedded `user_obj.is_active` only if the join genuinely missed that
 *     `pk` (e.g. deactivated between the two calls).
 *
 * The `uuid` and `username`/`name`/`email` fields prefer the bulk
 * `/core/users/` record (it's the one with `uuid`); if that join misses a
 * `pk` the binding still names, the binding's own `user_obj` is used instead
 * — better to record an identity with `authentikUuid: null` than to silently
 * drop an otherwise-entitled person because of a join miss.
 *
 * @param appUuid Optional pre-resolved application UUID
 * (`config.upstreams.authentikJellyseerrAppUuid`). When present (non-blank),
 * `getApplicationBySlug` is never called — `listPolicyBindingsForTarget` is
 * issued directly against it. When absent, falls back to the
 * detail-by-slug lookup, exactly as before this parameter existed.
 */
export async function fetchEntitledIdentities(
  authentik: AuthentikClient,
  appSlug: string,
  appUuid?: string,
): Promise<AuthentikIdentity[]> {
  const targetUuid = appUuid && appUuid.trim() !== '' ? appUuid.trim() : (await authentik.getApplicationBySlug(appSlug)).uuid;

  const [bindings, users] = await Promise.all([authentik.listPolicyBindingsForTarget(targetUuid), authentik.listActiveUsers()]);

  const usersByPk = new Map(users.map((u) => [u.pk, u]));
  const identities: AuthentikIdentity[] = [];

  for (const binding of bindings) {
    if (!binding.enabled || binding.negate) continue;
    if (binding.user === null) continue;

    const joined = usersByPk.get(binding.user);
    const isActive = joined?.isActive ?? binding.userObj?.isActive ?? false;
    if (!isActive) continue;

    const username = joined?.username ?? binding.userObj?.username;
    if (!username) continue; // can't identify this binding's user at all — skip rather than guess (FR-SYNC-3's spirit applied to a malformed row, not just to matching)

    identities.push({
      ssoUsername: username.toLowerCase(),
      authentikUuid: joined?.uuid ?? null,
      displayName: joined?.name ?? binding.userObj?.name ?? username,
      email: joined?.email ?? binding.userObj?.email ?? '',
      groupNames: joined?.groupNames ?? [],
    });
  }

  return identities;
}
