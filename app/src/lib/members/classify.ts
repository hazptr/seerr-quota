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
 * ## Shared namespace (security review, PR #17)
 *
 * A brand-new Seerr account's derived key is checked against identity-theft
 * risks before it's ever used as a new `sso_username`, not just "is this
 * key already a member row":
 *   1. Does it collide with a key an ALREADY-LINKED member owns — either
 *      currently-active this cycle, OR a member row that still carries a
 *      `seerr_user_id` from a PRIOR link even if that Seerr account has
 *      since vanished from the current list (second security review,
 *      item "SHOULD-FIX 1" below)? Linked rows are immutable in identity —
 *      a new Seerr account can never steal/overwrite one, even if its own
 *      derived key happens to match (e.g. Seerr user #9 sets
 *      `username: 'alice'` while Seerr user #5 is/was linked to member
 *      `alice`). The new account is surfaced `ambiguous` at a separate
 *      `seerr:{id}` key instead; `alice` is never touched — even if Seerr
 *      id #5 was deleted, that's a decision for an operator to make about
 *      `alice`'s row, not something a different, unrelated new account can
 *      trigger by picking the same username.
 *   2. Does it collide with ANOTHER member's existing `login_alias`
 *      (`src/lib/auth/memberGate.ts`)? Exact-match login always wins over
 *      alias-match (`resolveMemberKey`'s order), so creating a new member
 *      at a string that's already someone's alias would let a future
 *      login under that exact string silently resolve to the WRONG
 *      person. Also surfaced `ambiguous`, never created.
 *   3. Is it claimed by MORE THAN ONE new Seerr account this cycle? Two
 *      colliding new accounts are `ambiguous` regardless of what the key
 *      itself is — see "Orphan key collisions" above.
 *
 * **Second security review correction**: a key matching a configured
 * `ADMIN_USERS` entry is, BY ITSELF, NOT unsafe — a single new Seerr
 * account deriving an admin-reserved key (e.g. the operator's own first
 * Seerr login, where `ADMIN_USERS` already names their eventual username)
 * is the ordinary, expected case and MUST map normally: refusing it would
 * permanently lock the operator out of their own dashboard and deletion
 * flow on a fresh install, since nothing else would ever create that row.
 * `ADMIN_USERS` collision only becomes a problem combined with ONE OF THE
 * THREE CONDITIONS ABOVE (a race for an already-taken identity) — which is
 * already independently unsafe for other reasons, so there is no separate
 * "is this key admin-reserved" gate any more.
 *
 * Only when NONE of conditions 1-3 hold is the key either adopted (a
 * matching EXISTING, UNLINKED row — a legacy orphan) or created fresh.
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
 *
 * Only used when `key` ITSELF is otherwise free (see `isKeySafeToUse`
 * below) — a collision between two brand-new Seerr accounts with nothing
 * else already at that key. When `key` is unsafe for a DIFFERENT reason
 * (already belongs to a linked member, matches another member's alias, or
 * matches `ADMIN_USERS`), `ambiguousFallback` is used instead — it never
 * writes at the contested `key` at all.
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

/**
 * Security review (PR #17), "shared namespace": one Seerr account whose
 * derived key is unsafe to use outright — it would either steal an
 * ALREADY-LINKED member's identity or collide with another member's
 * `login_alias` (letting a future exact-match login silently shadow that
 * alias's intended resolution), or it's one of several new accounts racing
 * for the same key. None of those are acceptable to resolve by guessing, so
 * this account is surfaced `ambiguous` at a SEPARATE, collision-safe
 * `seerr:{id}` key instead — the contested `key` (and whatever already
 * legitimately owns it) is never touched, and `isOperator` is
 * unconditionally `false` here (this path exists specifically to prevent
 * auto-granting it).
 *
 * `existingFallback` (second security review, item B): a Seerr account can
 * stay stuck in this exact ambiguous state for MANY cycles in a row (the
 * underlying collision doesn't resolve itself) — `fallbackKey` is
 * deterministic per Seerr id, so on every later cycle this is the SAME row,
 * not a new one. Pass the PRIOR cycle's row (if any) so `firstSeenAt` is
 * preserved and `isNew` is correctly `false`, instead of this function
 * being the caller's only option for "no existing row at all".
 */
function ambiguousFallback(
  fallbackKey: string,
  derivedKey: string,
  user: SeerrUserForMatch,
  reasons: readonly string[],
  nowSeconds: number,
  existingFallback: ExistingMemberSnapshot | undefined,
): ClassifiedMember {
  return {
    ssoUsername: fallbackKey,
    authentikUuid: existingFallback?.authentikUuid ?? null,
    displayName: user.displayName ?? user.username ?? fallbackKey,
    email: user.email,
    entitled: true,
    seerrUserId: null,
    jellyfinUserId: null,
    syncStatus: 'ambiguous',
    syncNote: `Ambiguous: Seerr account id ${user.id} would derive the login key "${derivedKey}", but ${reasons.join('; ')} — refusing to touch it or auto-grant anything (FR-SYNC-3). An operator must resolve this by hand.`,
    isNew: existingFallback === undefined,
    firstSeenAt: existingFallback?.firstSeenAt ?? nowSeconds,
    isOperator: false,
  };
}

/**
 * `FR-SYNC-10`, extended (security review, PR #17, item 5): a short/empty or
 * wildly-smaller Seerr user list is as dangerous as an outright upstream
 * failure — it reads as "most people lost their Seerr account" and would
 * mass-flip real, currently-entitled members to `not_entitled`
 * (enforcement exemption lost, dashboard access lost) on nothing more than
 * a flaky or misconfigured upstream response. Checked BEFORE
 * `classifyMembers` is ever called, against the SAME `existingMembers`
 * snapshot and the raw (not-yet-classified) Seerr list, pure and
 * hand-testable with no DB:
 *
 *   - Seerr's list is EMPTY while at least one existing member with a
 *     CONFIRMED link (`seerr_user_id` set) is currently `entitled` —
 *     refuse outright; an empty roster from a service that has users is
 *     definitionally suspicious.
 *   - More than HALF of the currently-entitled, CONFIRMED-linked members
 *     (and more than two of them — a 1-of-1 or 1-of-2 household losing
 *     someone is normal churn, not a mass failure) would flip to
 *     `not_entitled` this cycle.
 *
 * **Second security review correction**: both counts are scoped to members
 * with a CONFIRMED link (`seerrUserId !== null`) — an `ambiguous`/legacy
 * placeholder row (`entitled: true`, `seerrUserId: null`) was previously
 * counted as both "currently entitled" AND "would flip", which could
 * trigger (or mask) a refusal based on rows that were never a real,
 * resolvable Seerr account to begin with, and — now that `classifyMembers`
 * re-emits a persisting ambiguous row instead of letting it decay (item B)
 * — wouldn't actually flip to `not_entitled` most cycles anyway, making the
 * old count simply wrong.
 *
 * Either case: `src/lib/members/sync.ts`'s `syncMembers` records a
 * `sync.failed` audit row and applies NOTHING — `member` stays exactly as
 * it was, same as any other `FR-SYNC-10` failure. An operator who has
 * confirmed this refusal is correct-but-unwanted (a real, large departure)
 * can force the cycle to apply anyway via `POST
 * /api/admin/reconcile/force-members-sync` (`syncMembers`'s `forceApply`
 * option, audited as `sync.forced`) — see that route and
 * `wiki/Feature-02-Account-Sync.md`. This guard cannot distinguish a
 * genuinely wrong-but-non-empty Seerr list (one that drops a handful of
 * real members while keeping the count plausible) from legitimate churn of
 * the same size — it only catches EMPTY or MAJORITY-sized drops.
 */
/**
 * Stable substring every `checkMassRevocationRisk` refusal reason contains —
 * exported so a display-only consumer (`@/components/admin/logic.ts`'s
 * `wasMembersSyncRefusedByMassRevocationGuard`) can detect "the last
 * members sync was refused by THIS specific guard" from the `sync_run.steps`
 * JSON's `classify.error` text, without re-implementing or re-running the
 * check itself.
 */
export const MASS_REVOCATION_REFUSAL_MARKER = 'refusing to mass-revoke';

export interface MassRevocationCheck {
  refuse: boolean;
  /** Human-readable, present whenever `refuse` is `true`. Always contains `MASS_REVOCATION_REFUSAL_MARKER`. */
  reason?: string;
}

export function checkMassRevocationRisk(
  existingMembers: ReadonlyMap<string, ExistingMemberSnapshot>,
  seerrUsers: readonly SeerrUserForMatch[],
  options: { forced?: boolean } = {},
): MassRevocationCheck {
  const confirmedLinkedEntitled = [...existingMembers.values()].filter((m) => m.entitled && m.seerrUserId !== null);
  const entitledBefore = confirmedLinkedEntitled.length;
  if (entitledBefore === 0) return { refuse: false }; // nothing with a confirmed link to revoke

  if (seerrUsers.length === 0) {
    return {
      refuse: true,
      reason: `Seerr returned an empty user list while ${entitledBefore} member(s) with a confirmed Seerr link are currently entitled — refusing to mass-revoke (FR-SYNC-10)`,
    };
  }

  const currentSeerrIds = new Set(seerrUsers.map((u) => u.id));
  let wouldFlip = 0;
  for (const m of confirmedLinkedEntitled) {
    if (!currentSeerrIds.has(m.seerrUserId!)) wouldFlip++;
  }

  // An operator's one-shot force accepts large flips, but never an empty list
  // (above): that is never a legitimate roster.
  if (options.forced) return { refuse: false };

  // Every confirmed-linked member vanishing at once is a wrong instance or a
  // reset, not a departure — this also covers 1-2 member deployments.
  if (wouldFlip === entitledBefore) {
    return {
      refuse: true,
      reason: `this cycle would flip ALL ${entitledBefore} currently-entitled, confirmed-linked members to not_entitled — refusing to mass-revoke (FR-SYNC-10)`,
    };
  }

  if (entitledBefore > 2 && wouldFlip > entitledBefore / 2) {
    return {
      refuse: true,
      reason: `this cycle would flip ${wouldFlip} of ${entitledBefore} currently-entitled, confirmed-linked members to not_entitled (over half) — refusing to mass-revoke (FR-SYNC-10)`,
    };
  }

  return { refuse: false };
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
  // Every OTHER member's existing login_alias (security review, PR #17,
  // "shared namespace") — a brand-new member must never be keyed to a
  // string that's already someone's alias.
  const existingAliases = new Set<string>();
  for (const existing of existingMembers.values()) {
    if (existing.seerrUserId !== null) existingBySeerrUserId.set(existing.seerrUserId, existing);
    if (existing.loginAlias) existingAliases.add(existing.loginAlias.toLowerCase());
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
  //    that row's sso_username verbatim (key stability). Populated FIRST so
  //    step 2 below can detect a new Seerr user's derived key colliding
  //    with an already-linked member's identity.
  for (const user of seerrUsers) {
    const existing = existingBySeerrUserId.get(user.id);
    if (!existing) continue;
    output.set(existing.ssoUsername, classifiedFromSeerrUser(existing.ssoUsername, user, existing, nowSeconds, operatorConfig));
  }

  // 2. Every current Seerr user with no existing link — derive a new key.
  //    `key` is safe to write to ONLY when none of these hold:
  //      - it belongs to an ALREADY-LINKED identity — either claimed this
  //        cycle by a currently-active link (step 1), OR an existing
  //        member row that still carries a `seerr_user_id` from a PRIOR
  //        link even though that Seerr account isn't in the current list
  //        (second security review, "SHOULD-FIX 1": a vanished Seerr
  //        account must not let a DIFFERENT new account take over the old
  //        member's row just by reusing its username).
  //      - it matches another member's existing `login_alias` (item 4).
  //      - more than one new Seerr account derives it this cycle (a plain
  //        collision between two new accounts — see "Orphan key
  //        collisions" above).
  //    Matching a configured `ADMIN_USERS` entry is deliberately NOT its
  //    own unsafe condition (second security review, item A) — a single
  //    new Seerr account mapping to an admin-reserved key is the ordinary
  //    "operator's own first Seerr login" case and must resolve normally.
  //    A key matching an EXISTING member row that is UNLINKED (a legacy
  //    orphan, `seerr_user_id === null`) and otherwise safe is adopted —
  //    that row's `seerr_user_id` gets filled in, no new row, no re-key.
  for (const [key, group] of newKeyGroups) {
    const existingAtKey = existingMembers.get(key);
    const takenByLinkedRow = output.has(key) || (existingAtKey !== undefined && existingAtKey.seerrUserId !== null);
    const isAlias = existingAliases.has(key);
    const keySafe = !takenByLinkedRow && !isAlias;

    if (keySafe && group.length === 1) {
      // `existingAtKey`, if present, is guaranteed unlinked here (`keySafe`
      // already ruled out `seerrUserId !== null`) — a genuine legacy
      // orphan row to adopt, not a row to steal.
      output.set(key, classifiedFromSeerrUser(key, group[0], existingAtKey, nowSeconds, operatorConfig));
      continue;
    }

    if (keySafe && group.length > 1) {
      // Only a collision among the NEW Seerr accounts themselves — `key`
      // itself is otherwise unclaimed, so one shared ambiguous row there
      // is safe (nothing else is being overwritten).
      output.set(key, ambiguousOrphan(key, group, nowSeconds, operatorConfig));
      continue;
    }

    // Unsafe for at least one of the reasons above — never write to `key`
    // at all. Every colliding Seerr account gets its own `ambiguous` row at
    // a separate, collision-free `seerr:{id}` key instead.
    const reasons: string[] = [];
    if (takenByLinkedRow) reasons.push('that login key already belongs to a different, already-linked (or previously-linked) member');
    if (isAlias) reasons.push("that login key is already another member's login alias");
    if (group.length > 1) reasons.push(`it is also claimed by Seerr account id(s) ${group.map((u) => u.id).join(', ')}`);

    for (const user of group) {
      const fallbackKey = `seerr:${user.id}`;
      if (output.has(fallbackKey)) continue; // can't happen (unique Seerr ids -> unique fallback keys); defensive only
      // Second security review, item B: this exact ambiguous placeholder
      // may already exist from a prior cycle (the underlying collision
      // hasn't resolved) — re-emit it (preserving firstSeenAt/isNew)
      // rather than silently dropping it, which would let step 3 below
      // wrongly carry it forward as "lost their Seerr account" even though
      // the account is still listed, right here, this cycle.
      output.set(fallbackKey, ambiguousFallback(fallbackKey, key, user, reasons, nowSeconds, existingMembers.get(fallbackKey)));
    }
  }

  // 3. Every existing member row not covered above — carry forward
  //    (flip entitlement if a Seerr account was just lost; never delete).
  for (const [key, existing] of existingMembers) {
    if (output.has(key)) continue;
    const justLostEntitlement = existing.entitled;
    // A row that was `entitled` but NEVER had a confirmed `seerr_user_id`
    // link (e.g. a previously-ambiguous placeholder) never actually "lost"
    // a Seerr account — it just isn't claimed this cycle either. Saying it
    // "lost" one would be a lie about history that never happened (item 7,
    // security review).
    const hadConfirmedLink = existing.seerrUserId !== null;
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
        ? hadConfirmedLink
          ? 'Lost their Seerr account (no longer listed by Seerr). Claims, usage, and audit history are preserved.'
          : 'No longer listed by Seerr (was never linked to a confirmed Seerr account). Claims, usage, and audit history are preserved.'
        : existing.syncNote,
      isNew: false,
      firstSeenAt: existing.firstSeenAt,
      isOperator: existing.isOperator || isOperatorUsername(existing.ssoUsername, operatorConfig),
    });
  }

  return [...output.values()];
}
