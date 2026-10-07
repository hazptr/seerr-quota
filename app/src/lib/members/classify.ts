/**
 * Pure reconciliation core (AGENTS.md rule 9: "pure core, impure shell") —
 * `wiki/Feature-02-Account-Sync.md`. Takes the current Seerr user list
 * (`./seerrUsers.ts`) and a snapshot of what the DB already knew going in —
 * returns the desired-state `member` rows for this cycle. No I/O, no DB, no
 * `Date.now()` (the caller supplies `nowSeconds`), so every scenario in
 * `test/members-classify.test.ts` is hand-calculated without touching a
 * database.
 *
 * ## Roster source (0.2.0 — the Authentik integration is gone)
 *
 * Since 0.2.0 the member roster comes straight from Seerr: EVERY Seerr user
 * is a member, `entitled = true`, `syncStatus = 'matched'`. There is no
 * second, independent identity-provider entitlement list to cross-reference
 * any more, so there is nothing left to be ambiguous ABOUT for a brand-new
 * row — `no_seerr_account` can no longer be produced (it meant "entitled in
 * the IdP but no matching Seerr account", which presupposes an IdP-side
 * entitlement list distinct from Seerr's own). Both values stay in the
 * `sync_status` enum (additive-only schema) purely so a pre-0.2.0 row that
 * already carries one still reads back fine — see `src/lib/db/schema.ts`.
 *
 * `ambiguous` can still occur, for a narrower reason: see "Orphan key
 * collisions" below.
 *
 * ## Key stability — CRITICAL for production continuity
 *
 * `member.sso_username` is the login username already referenced by
 * `claim`, `deletion`, `audit`, `quota_policy`, and `request_decision`. A
 * member row already linked to a Seerr user (`existing.seerrUserId` set)
 * MUST keep its `sso_username` forever: this function re-matches existing
 * rows by `seerr_user_id`, NOT by re-deriving a key from the Seerr user's
 * current username/email, precisely so a Seerr-side rename never re-keys an
 * established member or spawns a duplicate row for the same person.
 *
 * Only a Seerr user with NO linked member row gets a brand-new row, keyed by
 * `normalize(jellyfinUsername) ?? normalize(username) ?? normalize(email) ??
 * 'seerr:{id}'` — the same priority order (and the same `normalize`, which
 * lowercases/trims and maps blank to nothing) the pre-0.2.0 "orphan key"
 * derivation already used, extended with the `seerr:{id}` last-resort
 * fallback for the (believed impossible in practice, but never guessed past)
 * case where Seerr has no username, jellyfinUsername, OR email on file for a
 * user at all.
 *
 * If a brand-new key happens to coincide with an EXISTING member row that
 * has no `seerr_user_id` yet (a pre-0.2.0 orphan row, or one from an earlier
 * partial sync), that existing row is linked to this Seerr user (its
 * `seerr_user_id` is filled in) rather than creating a second row for the
 * same login name — still no re-key, since the `sso_username` itself is
 * untouched.
 *
 * ## Orphan key collisions
 *
 * Two distinct Seerr users deriving the IDENTICAL new key (e.g. the same
 * `jellyfinUsername` recorded on two different Seerr accounts, which
 * shouldn't normally happen but isn't guarded against by Seerr itself) are
 * BOTH classified `ambiguous`, `seerrUserId: null`, `entitled: true` —
 * `FR-SYNC-3`'s "never guess" applied to this one remaining ambiguity
 * source. An operator has to resolve this by hand; nothing here picks a
 * winner.
 *
 * ## Members who lose their Seerr account
 *
 * A member row not claimed by any CURRENT Seerr user this cycle (the Seerr
 * account was deleted, or Seerr itself is simply not listing them any more)
 * is carried forward with `entitled = false`, `syncStatus = 'not_entitled'`
 * — never deleted. Claims, usage, and audit history survive.
 *
 * ## Operator status (`FR-ENF-6`, background half)
 *
 * `member.is_operator` gates the enforcement exemption when no request is in
 * flight (the pending-request sweep, not a live HTTP request) — there is no
 * groups header available off-request, so this is `ADMIN_USERS` membership
 * ONLY (`isOperatorUser`, imported from `src/lib/auth/identity.ts` so there
 * is structurally one implementation of "is this username an admin", not
 * two). The REQUEST-TIME check (`src/lib/auth/identity.ts`'s
 * `resolveIdentity`) additionally ORs in `ADMIN_GROUP` membership from the
 * live groups header — see that file and `wiki/Configuration.md` for why the
 * two deliberately differ.
 */
import { isOperatorUser } from '../auth/identity';
import type { SeerrUserForMatch } from './seerrUsers';
import type { ClassifiedMember, ExistingMemberSnapshot } from './types';

/** `ADMIN_USERS` (`src/lib/config.ts`) — threaded through as plain data, not read from `getConfig()` here, to keep this module pure (AGENTS.md rule 9). */
export interface OperatorConfig {
  adminUsers: readonly string[];
}

function normalize(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * `wiki/Data-Model.md` §member: `jellyfin_user_id` is stored "normalised (no
 * dashes, lowercase)" — the same convention §playback documents for
 * `playback.jellyfin_user_id`, since that's the join key the (not-built-here)
 * playback sync will use against this column. Seerr's raw `jellyfinUserId` is
 * not guaranteed to already be in that form, so it's normalised here, at the
 * one place this app decides to persist it.
 */
function normalizeJellyfinUserId(id: string | null): string | null {
  if (!id) return null;
  const normalized = id.replace(/-/g, '').toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/**
 * The key a brand-new member row gets when no existing row is already
 * linked to this Seerr user id — see this file's header comment, "Key
 * stability".
 */
function deriveNewMemberKey(user: SeerrUserForMatch): string {
  return normalize(user.jellyfinUsername) ?? normalize(user.username) ?? normalize(user.email) ?? `seerr:${user.id}`;
}

function isOperatorUsername(ssoUsername: string, operatorConfig: OperatorConfig): boolean {
  return isOperatorUser(ssoUsername, operatorConfig.adminUsers);
}

function classifiedFromSeerrUser(
  ssoUsername: string,
  user: SeerrUserForMatch,
  existing: ExistingMemberSnapshot | undefined,
  nowSeconds: number,
  operatorConfig: OperatorConfig,
): ClassifiedMember {
  return {
    ssoUsername,
    authentikUuid: existing?.authentikUuid ?? null,
    displayName: user.displayName ?? user.username ?? ssoUsername,
    email: user.email,
    entitled: true,
    seerrUserId: user.id,
    jellyfinUserId: normalizeJellyfinUserId(user.jellyfinUserId),
    syncStatus: 'matched',
    syncNote: null,
    isNew: existing === undefined,
    firstSeenAt: existing?.firstSeenAt ?? nowSeconds,
    isOperator: isOperatorUsername(ssoUsername, operatorConfig),
  };
}

/**
 * `member.sso_username` is a PRIMARY KEY — two distinct Seerr accounts that
 * derive the identical new key cannot each get their own row at that key.
 * Rather than guess which one "wins" (the one `FR-SYNC-3` behaviour this
 * whole module exists to avoid), exactly ONE `ambiguous` row is written at
 * `key`, naming every colliding Seerr account id in `syncNote`; none of
 * them is linked (`seerrUserId: null`). An operator has to resolve the
 * underlying data collision (e.g. a duplicate `jellyfinUsername` in Seerr)
 * by hand — nothing here picks a winner.
 */
function ambiguousOrphan(key: string, group: SeerrUserForMatch[], nowSeconds: number, operatorConfig: OperatorConfig): ClassifiedMember {
  const first = group[0];
  return {
    ssoUsername: key,
    authentikUuid: null,
    displayName: first.displayName ?? first.username ?? key,
    email: null,
    entitled: true,
    seerrUserId: null,
    jellyfinUserId: null,
    syncStatus: 'ambiguous',
    syncNote: `Ambiguous: Seerr account ids ${group.map((u) => u.id).join(', ')} all derive the same login key (${key}) — refusing to guess which is which (FR-SYNC-3).`,
    isNew: true,
    firstSeenAt: nowSeconds,
    isOperator: isOperatorUser(key, operatorConfig.adminUsers),
  };
}

export function classifyMembers(
  seerrUsers: SeerrUserForMatch[],
  existingMembers: ReadonlyMap<string, ExistingMemberSnapshot>,
  nowSeconds: number,
  operatorConfig: OperatorConfig,
): ClassifiedMember[] {
  // Re-match existing rows by seerr_user_id — the key-stability anchor. A
  // member already linked to a Seerr account keeps its sso_username no
  // matter what Seerr's current username/email says.
  const existingBySeerrUserId = new Map<number, ExistingMemberSnapshot>();
  for (const existing of existingMembers.values()) {
    if (existing.seerrUserId !== null) existingBySeerrUserId.set(existing.seerrUserId, existing);
  }

  // Group every CURRENT Seerr user needing a brand-new key by that derived
  // key, so a genuine collision between two distinct Seerr accounts can be
  // detected before any row is written for either of them.
  const newKeyGroups = new Map<string, SeerrUserForMatch[]>();
  for (const user of seerrUsers) {
    if (existingBySeerrUserId.has(user.id)) continue; // already has a stable row — handled below
    const key = deriveNewMemberKey(user);
    const group = newKeyGroups.get(key);
    if (group) group.push(user);
    else newKeyGroups.set(key, [user]);
  }

  const output = new Map<string, ClassifiedMember>();

  // 1. Every current Seerr user already linked to an existing row — reuse
  //    that row's sso_username verbatim (key stability).
  for (const user of seerrUsers) {
    const existing = existingBySeerrUserId.get(user.id);
    if (!existing) continue;
    output.set(existing.ssoUsername, classifiedFromSeerrUser(existing.ssoUsername, user, existing, nowSeconds, operatorConfig));
  }

  // 2. Every current Seerr user with no existing link — derive a new key.
  //    A key colliding with another NEW Seerr user this cycle -> ambiguous
  //    for both (FR-SYNC-3's "never guess", applied to this ambiguity
  //    source). A key matching an EXISTING (unlinked, i.e. legacy orphan)
  //    row -> link that row to this Seerr user rather than creating a
  //    second one for the same login name.
  for (const [key, group] of newKeyGroups) {
    if (group.length > 1) {
      output.set(key, ambiguousOrphan(key, group, nowSeconds, operatorConfig));
      continue;
    }

    const user = group[0];
    const existingUnlinked = existingMembers.get(key);
    output.set(key, classifiedFromSeerrUser(key, user, existingUnlinked, nowSeconds, operatorConfig));
  }

  // 3. Every existing member row not covered above — carry forward
  //    (flip entitlement if a Seerr account was just lost; never delete).
  for (const [key, existing] of existingMembers) {
    if (output.has(key)) continue;
    const justLostEntitlement = existing.entitled;
    output.set(key, {
      ssoUsername: existing.ssoUsername,
      authentikUuid: existing.authentikUuid,
      displayName: existing.displayName,
      email: existing.email,
      entitled: false,
      seerrUserId: existing.seerrUserId,
      jellyfinUserId: existing.jellyfinUserId,
      syncStatus: 'not_entitled',
      syncNote: justLostEntitlement
        ? 'Lost their Seerr account (no longer listed by Seerr). Claims, usage, and audit history are preserved.'
        : existing.syncNote,
      isNew: false,
      firstSeenAt: existing.firstSeenAt,
      isOperator: existing.isOperator || isOperatorUsername(existing.ssoUsername, operatorConfig),
    });
  }

  return [...output.values()];
}
