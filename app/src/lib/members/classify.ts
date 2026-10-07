/**
 * Pure reconciliation core (AGENTS.md rule 9: "pure core, impure shell") —
 * `wiki/Feature-02-Account-Sync.md` `FR-SYNC-2`..`FR-SYNC-6`. Takes the
 * current entitled-identity set (`src/lib/authentik/identity.ts`), the
 * current Seerr user list (`./seerrUsers.ts`), and a snapshot of what the DB
 * already knew going in — returns the desired-state `member` rows for this
 * cycle. No I/O, no DB, no Date.now() (the caller supplies `nowSeconds`), so
 * every scenario in `test/members-classify.test.ts` is hand-calculated
 * without touching a database.
 *
 * ## Population — who gets a row this cycle
 *
 * Three groups, in this priority order (an earlier group's key always wins a
 * theoretical collision):
 *
 * 1. **Every currently-entitled Authentik identity** — always emitted, every
 *    cycle, classified `matched` / `no_seerr_account` / `ambiguous` (never
 *    `not_entitled` — entitled is definitionally not "not entitled").
 * 2. **Seerr users not claimed by any entitled identity in (1)** — an
 *    "orphan" — e.g. Seerr's `akadmin` (`wiki/Data-Model.md` §member: "Seerr's
 *    akadmin row → unmatched, reported as not_entitled"). Only a BRAND NEW
 *    key becomes an orphan row; if the key already exists in
 *    `existingMembers` (from group 3's history, or a coincidental prior
 *    orphan), it's left to group 3 instead — this function never guesses its
 *    way into overwriting an existing member from a fresh, unverified Seerr
 *    match (`FR-SYNC-3`'s "never guess" applied here too).
 * 3. **Every existing `member` row not covered by (1)** — a member who was
 *    entitled before and lost the binding (`FR-SYNC-6`: flip `entitled = 0`,
 *    reclassify `not_entitled`, never delete), or one who was already
 *    `not_entitled`/otherwise not entitled and still isn't — carried forward
 *    unchanged so `first_seen_at`/history survive and the row stays present
 *    even if this cycle can't independently re-verify it (no fresh Authentik
 *    data exists for a non-entitled user; no fresh Seerr re-match is
 *    attempted for a member outside group 1/2).
 *
 * ## Matching (`FR-SYNC-2`, `FR-SYNC-3`)
 *
 * For each entitled identity: candidate Seerr users are `jellyfinUsername`
 * case-insensitive match first; if that finds none, fall back to `email`
 * case-insensitive match (never both combined — a `jellyfinUsername` hit,
 * even a bad one, is never second-guessed by also checking email). Exactly
 * one candidate, not claimed by any OTHER entitled identity's match, is
 * `matched`. Zero candidates is `no_seerr_account`. Anything else (more than
 * one candidate for this identity, OR its one candidate is also claimed by a
 * different identity) is `ambiguous` for every identity involved in that
 * conflict — nothing is attributed, per `FR-SYNC-3`.
 *
 * An empty/blank email never matches another empty/blank email (`normalize`
 * returns `null` for `''`) — real deployments hit this exact case (a shared
 * `family` account has no email on file) and a naive
 * `'' === ''` comparison would wrongly collide unrelated blank-email rows.
 *
 * ## Operator status (`FR-ENF-6`)
 *
 * `member.is_operator` gates enforcement exemption, and `src/lib/auth/
 * identity.ts` computes the SAME thing at request time from `Remote-User`/
 * `Remote-Groups` — the two must not disagree. Rather than reimplementing
 * "username in ADMIN_USERS, or a group in ADMIN_GROUP" a second time (and
 * risking exactly that drift), this module IMPORTS `isOperatorUser`/
 * `isInAdminGroup` from that file and calls them with the same config, so
 * there is structurally one implementation, not two:
 *   - An entitled identity has fresh group data from this cycle's
 *     `/core/users/` join (`AuthentikIdentity.groupNames`) — both halves of
 *     the check run at full accuracy.
 *   - An orphan (Seerr row with no Authentik identity, e.g. `akadmin`) has
 *     never had Authentik data at all — only the username half is checkable.
 *   - A carried-forward member (outside the currently-entitled set — lost
 *     entitlement, or already `not_entitled`) has no FRESH group data this
 *     cycle either (only entitled identities are group-joined) — the
 *     username half is re-checked against the current `ADMIN_USERS` (cheap,
 *     config-only, always current), OR'd with whatever `is_operator` was
 *     already recorded, so a config change can only ever GRANT the
 *     exemption promptly for this group, never promptly revoke a
 *     group-derived grant that's gone stale — the same class of staleness
 *     already accepted for their `displayName`/`email` in group 3 below.
 */
import { isInAdminGroup, isOperatorUser } from '../auth/identity';
import type { AuthentikIdentity } from '../authentik/identity';
import type { SeerrUserForMatch } from './seerrUsers';
import type { ClassifiedMember, ExistingMemberSnapshot } from './types';

/** `ADMIN_USERS`/`ADMIN_GROUP` (`src/lib/config.ts`) — threaded through as plain data, not read from `getConfig()` here, to keep this module pure (AGENTS.md rule 9). */
export interface OperatorConfig {
  adminUsers: readonly string[];
  adminGroup: string;
}

function normalize(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function indexBy(users: SeerrUserForMatch[], keyFn: (u: SeerrUserForMatch) => string | null): Map<string, SeerrUserForMatch[]> {
  const idx = new Map<string, SeerrUserForMatch[]>();
  for (const u of users) {
    const key = keyFn(u);
    if (key === null) continue;
    const list = idx.get(key);
    if (list) list.push(u);
    else idx.set(key, [u]);
  }
  return idx;
}

interface CandidateResult {
  identity: AuthentikIdentity;
  candidates: SeerrUserForMatch[];
  method: 'username' | 'email' | 'none';
}

function findCandidates(
  identity: AuthentikIdentity,
  byUsername: Map<string, SeerrUserForMatch[]>,
  byEmail: Map<string, SeerrUserForMatch[]>,
): CandidateResult {
  const usernameKey = normalize(identity.ssoUsername);
  const usernameCandidates = usernameKey ? (byUsername.get(usernameKey) ?? []) : [];
  if (usernameCandidates.length > 0) return { identity, candidates: usernameCandidates, method: 'username' };

  const emailKey = normalize(identity.email);
  const emailCandidates = emailKey ? (byEmail.get(emailKey) ?? []) : [];
  if (emailCandidates.length > 0) return { identity, candidates: emailCandidates, method: 'email' };

  return { identity, candidates: [], method: 'none' };
}

function deriveOrphanKey(user: SeerrUserForMatch): string {
  return normalize(user.jellyfinUsername) ?? normalize(user.username) ?? `seerr:${user.id}`;
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

function isOperatorIdentity(identity: AuthentikIdentity, operatorConfig: OperatorConfig): boolean {
  return isOperatorUser(identity.ssoUsername, operatorConfig.adminUsers) || isInAdminGroup(identity.groupNames, operatorConfig.adminGroup);
}

function classifyEntitled(result: CandidateResult, claimsBySeerrId: Map<number, string[]>, operatorConfig: OperatorConfig): ClassifiedMember {
  const { identity, candidates, method } = result;
  const isOperator = isOperatorIdentity(identity, operatorConfig);

  if (candidates.length === 0) {
    return {
      ssoUsername: identity.ssoUsername,
      authentikUuid: identity.authentikUuid,
      displayName: identity.displayName,
      email: identity.email,
      entitled: true,
      seerrUserId: null,
      jellyfinUserId: null,
      syncStatus: 'no_seerr_account',
      syncNote: 'Entitled in Authentik (holds the jellyseerr binding) but no matching Seerr account — never logged in yet.',
      isNew: false, // caller fills this in
      firstSeenAt: 0, // caller fills this in
      isOperator,
    };
  }

  const sole = candidates[0];
  const claimants = claimsBySeerrId.get(sole.id) ?? [];
  if (candidates.length === 1 && claimants.length === 1) {
    return {
      ssoUsername: identity.ssoUsername,
      authentikUuid: identity.authentikUuid,
      displayName: identity.displayName,
      email: identity.email,
      entitled: true,
      seerrUserId: sole.id,
      jellyfinUserId: normalizeJellyfinUserId(sole.jellyfinUserId),
      syncStatus: 'matched',
      syncNote: null,
      isNew: false,
      firstSeenAt: 0,
      isOperator,
    };
  }

  const note =
    candidates.length > 1
      ? `Ambiguous match via ${method}: ${candidates.length} candidate Seerr accounts (ids ${candidates.map((c) => c.id).join(', ')}) — refusing to guess (FR-SYNC-3).`
      : `Ambiguous match: Seerr account id ${sole.id} is also claimed by ${claimants.filter((s) => s !== identity.ssoUsername).join(', ')} — refusing to guess (FR-SYNC-3).`;

  return {
    ssoUsername: identity.ssoUsername,
    authentikUuid: identity.authentikUuid,
    displayName: identity.displayName,
    email: identity.email,
    entitled: true,
    seerrUserId: null,
    jellyfinUserId: null,
    syncStatus: 'ambiguous',
    syncNote: note,
    isNew: false,
    firstSeenAt: 0,
    isOperator,
  };
}

export function classifyMembers(
  entitled: AuthentikIdentity[],
  seerrUsers: SeerrUserForMatch[],
  existingMembers: ReadonlyMap<string, ExistingMemberSnapshot>,
  nowSeconds: number,
  operatorConfig: OperatorConfig,
): ClassifiedMember[] {
  const byUsername = indexBy(seerrUsers, (u) => normalize(u.jellyfinUsername));
  const byEmail = indexBy(seerrUsers, (u) => normalize(u.email));

  const candidateResults = entitled.map((identity) => findCandidates(identity, byUsername, byEmail));

  // Reverse claim map: which entitled identities' candidate lists include this Seerr user id — used to
  // detect "one-to-one in BOTH directions" (FR-SYNC-3) and to build the "claimed" set that excludes a
  // Seerr row from orphan consideration even when the match itself turned out ambiguous.
  const claimsBySeerrId = new Map<number, string[]>();
  const claimedSeerrIds = new Set<number>();
  for (const result of candidateResults) {
    for (const candidate of result.candidates) {
      claimedSeerrIds.add(candidate.id);
      const list = claimsBySeerrId.get(candidate.id);
      if (list) list.push(result.identity.ssoUsername);
      else claimsBySeerrId.set(candidate.id, [result.identity.ssoUsername]);
    }
  }

  const output = new Map<string, ClassifiedMember>();

  // 1. Entitled identities — always emitted, every cycle.
  for (const result of candidateResults) {
    const existing = existingMembers.get(result.identity.ssoUsername);
    const base = classifyEntitled(result, claimsBySeerrId, operatorConfig);
    output.set(result.identity.ssoUsername, {
      ...base,
      isNew: existing === undefined,
      firstSeenAt: existing?.firstSeenAt ?? nowSeconds,
    });
  }

  // 2. Orphan Seerr users — not claimed by any entitled identity, and not already a known member.
  // Convention (confirmed with the operator, documented in
  // Feature-02): keyed by jellyfinUsername -> username -> `seerr:{id}`, in
  // that priority, since `member.sso_username` has no real Authentik
  // username to anchor on for a Seerr-only row like `akadmin`.
  for (const user of seerrUsers) {
    if (claimedSeerrIds.has(user.id)) continue;
    const key = deriveOrphanKey(user);
    if (output.has(key)) continue; // already spoken for this cycle (shouldn't happen given the claimed-set check above, but a defensive skip beats an overwrite)
    if (existingMembers.has(key)) continue; // don't guess our way into overwriting a known member from a fresh, unverified orphan derivation
    output.set(key, {
      ssoUsername: key,
      authentikUuid: null,
      displayName: user.displayName ?? user.username ?? key,
      email: user.email,
      entitled: false,
      seerrUserId: user.id,
      jellyfinUserId: normalizeJellyfinUserId(user.jellyfinUserId),
      syncStatus: 'not_entitled',
      syncNote: 'Has a Seerr account but no active jellyseerr entitlement in Authentik.',
      isNew: true,
      firstSeenAt: nowSeconds,
      // No Authentik identity ever existed for this key, so no group data is possible — username-only check.
      isOperator: isOperatorUser(key, operatorConfig.adminUsers),
    });
  }

  // 3. Existing members not covered above — carry forward (flip entitlement if it was just lost).
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
        ? 'Lost the jellyseerr entitlement in Authentik (previously entitled). Claims, usage, and audit history are preserved.'
        : existing.syncNote,
      isNew: false,
      firstSeenAt: existing.firstSeenAt,
      // No fresh group data this cycle (only entitled identities are group-joined) — re-check the cheap,
      // always-current username half and OR it with whatever was already recorded, per this file's header
      // comment ("Operator status"): this can promptly GRANT the exemption on an ADMIN_USERS change, but
      // can't promptly REVOKE a group-derived grant that's gone stale until this member is entitled again.
      isOperator: existing.isOperator || isOperatorUser(existing.ssoUsername, operatorConfig.adminUsers),
    });
  }

  return [...output.values()];
}
