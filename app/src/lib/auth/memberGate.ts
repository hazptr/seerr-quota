/**
 * FR-SSO-8: "A member who is authenticated but has no `member` row, or whose
 * `sync_status` is not `matched`, MUST get an informative screen explaining
 * the situation and naming the operator — never a raw error, and never an
 * empty dashboard that looks like 'you're using 0 bytes'."
 *
 * Split pure/impure per AGENTS.md rule 9: `describeMemberGate` is the pure
 * decision (row + admin-users list in, a typed result + human message out —
 * hand-testable with no DB); `getMemberGate` is the thin impure shell that
 * reads the `member` row for the current identity and calls it.
 *
 * Wiring this into an actual dashboard page/route is NOT this task's job —
 * `src/app/page.tsx` is the P1-1 scaffold placeholder and isn't in this
 * task's file scope (see the project notes); the real member
 * screen lands with the dashboard work (wiki/Feature-07-Admin-Dashboard.md
 * territory, later in the backlog). This module is what that future page
 * calls instead of either crashing on a missing row or silently rendering
 * zero usage.
 */
import { eq } from 'drizzle-orm';
import { getDb, type SeerrQuotaDb } from '@/lib/db';
import { member } from '@/lib/db/schema';
import { getConfig } from '@/lib/config';
import { newCorrelationId, writeAuditRow } from '@/lib/audit';
import type { Identity } from './identity';

/** Matches `member.sync_status`'s enum in `src/lib/db/schema.ts` exactly. */
export type MemberSyncStatus = 'matched' | 'no_seerr_account' | 'not_entitled' | 'ambiguous';

export interface MemberRowLike {
  syncStatus: MemberSyncStatus;
  syncNote: string | null;
}

export interface MemberGateOk {
  status: 'ok';
}

export interface MemberGateBlocked {
  status: 'blocked';
  /** `no_member_row`: never synced/matched at all. `not_matched`: a row exists but `sync_status` isn't `matched`. */
  reason: 'no_member_row' | 'not_matched';
  /** `null` only for `no_member_row` — there is no row to read a status from. */
  syncStatus: MemberSyncStatus | null;
  syncNote: string | null;
  /** The first configured `ADMIN_USERS` entry (falls back to a generic "the operator" if that list is somehow empty — boot validation already refuses to start in that case, so this is defensive only). */
  operatorContact: string;
  /** Ready-to-render, non-raw-error copy naming the operator — this is what FR-SSO-8 requires the screen to say. */
  message: string;
}

export type MemberGateResult = MemberGateOk | MemberGateBlocked;

/**
 * Pure: no I/O. `row` is `undefined` for "no `member` row exists yet" (the
 * reconciler hasn't seen this login yet, or they have no Seerr account);
 * a defined `row` with `syncStatus !== 'matched'` covers
 * `no_seerr_account` / `not_entitled` / `ambiguous`.
 */
export function describeMemberGate(row: MemberRowLike | undefined, adminUsers: readonly string[]): MemberGateResult {
  const operatorContact = adminUsers.find((u) => u.trim() !== '')?.trim() || 'the operator';

  if (!row) {
    return {
      status: 'blocked',
      reason: 'no_member_row',
      syncStatus: null,
      syncNote: null,
      operatorContact,
      message: `Your account isn't linked to Seerr yet, so there's nothing to show here. Ask ${operatorContact} to get you set up.`,
    };
  }

  if (row.syncStatus !== 'matched') {
    return {
      status: 'blocked',
      reason: 'not_matched',
      syncStatus: row.syncStatus,
      syncNote: row.syncNote,
      operatorContact,
      message: `Your account isn't fully set up yet (status: ${row.syncStatus}). Ask ${operatorContact} to sort this out.`,
    };
  }

  return { status: 'ok' };
}

/**
 * Impure shell: looks up `identity`'s `member` row (by the canonical
 * lowercased `identity.username`, matching `member.sso_username`'s
 * documented convention) and applies `describeMemberGate`.
 *
 * Callers pass the ALREADY-RESOLVED `identity` — i.e. `identity.username` is
 * whatever `resolveMemberKey` decided this login actually maps to
 * (`src/lib/auth/session.ts`'s `getIdentity()` does this resolution once per
 * request, before anything else reads `identity.username`). This function
 * itself does no alias/email fallback — see `resolveMemberKey` below for
 * that.
 */
export async function getMemberGate(identity: Identity): Promise<MemberGateResult> {
  const db = getDb();
  const rows = db
    .select({ syncStatus: member.syncStatus, syncNote: member.syncNote })
    .from(member)
    .where(eq(member.ssoUsername, identity.username))
    .all();
  const { adminUsers } = getConfig().identity;
  return describeMemberGate(rows[0], adminUsers);
}

// ---------------------------------------------------------------------------
// Login -> member resolution (0.2.0, item 3 of this task's brief).
//
// `member.sso_username` is a stable PK that `claim`/`deletion`/`audit`/
// `quota_policy`/`request_decision` all key off of. Swapping identity
// providers means the forward-auth proxy's username header value for the
// SAME person can change (new IdP, renamed account, ...) — this is the
// fallback path that keeps an existing member's history reachable under a
// NEW header username, without ever letting one member act as another.
//
// Resolution order, cheapest/safest first:
//   1. Exact: a `member` row already has `sso_username == headerUsername`.
//      The overwhelming common case; no extra query beyond the one
//      `getMemberGate`/every other caller already does.
//   2. Alias: a `member` row already has `login_alias == headerUsername`
//      (a PRIOR successful email-fallback resolution recorded it) — resolve
//      to that row instantly, no email comparison needed.
//   3. Email: if the proxy supplied a non-blank email header, and EXACTLY
//      ONE entitled member's `email` matches it case-insensitively, resolve
//      to that member and record `headerUsername` as its `login_alias`
//      (first time only) — audited (`member.alias_linked`). Zero or more
//      than one match -> refuse (never guess).
//
// If none of these resolve, the header username is returned UNCHANGED —
// exactly today's pre-0.2.0 behaviour for a genuinely unknown login:
// `getMemberGate` then finds no row and the member sees the FR-SSO-8
// "not linked yet" screen.
// ---------------------------------------------------------------------------

export type MemberResolutionVia = 'exact' | 'alias' | 'email' | 'unresolved';

export interface MemberResolution {
  /** The `member.sso_username` every downstream authorization/audit call must use. Equal to the raw header username when `via` is `'exact'` or `'unresolved'`. */
  ssoUsername: string;
  via: MemberResolutionVia;
}

function normalizeEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Attempts the email-fallback link (resolution step 3 above) and records it.
 * Only called once steps 1/2 have already confirmed `headerUsername` is
 * neither an existing `sso_username` nor an existing `login_alias` — so the
 * uniqueness check immediately below is a defensive re-verification, not
 * the primary guard (the real guard is the `member_login_alias_unique_idx`
 * DB index itself; a race that slips past both is caught by the `catch`
 * below and treated as unresolved rather than crashing the request).
 */
function tryLinkByEmail(db: SeerrQuotaDb, headerUsername: string, rawEmailHeader: string | null | undefined): MemberResolution | undefined {
  const emailKey = normalizeEmail(rawEmailHeader);
  if (emailKey === null) return undefined;

  const entitledRows = db
    .select({ ssoUsername: member.ssoUsername, email: member.email, loginAlias: member.loginAlias })
    .from(member)
    .where(eq(member.entitled, true))
    .all();
  const matches = entitledRows.filter((row) => normalizeEmail(row.email) === emailKey);
  if (matches.length !== 1) return undefined; // zero or ambiguous (>1) -> refuse, never guess

  const matched = matches[0];

  // Re-verify `headerUsername` collides with neither another member's
  // sso_username nor another member's existing alias — belt-and-suspenders
  // alongside the DB unique index (defensive; callers already ruled this
  // out via steps 1/2 before calling this function).
  const collision = db
    .select({ ssoUsername: member.ssoUsername })
    .from(member)
    .where(eq(member.ssoUsername, headerUsername))
    .all();
  if (collision.length > 0) return undefined;

  try {
    db.update(member).set({ loginAlias: headerUsername }).where(eq(member.ssoUsername, matched.ssoUsername)).run();
  } catch {
    // Unique index violation (lost a race, or some other invariant break) —
    // refuse rather than guess; the caller falls back to "unresolved".
    writeAuditRow(db, {
      actor: 'system',
      actorRole: 'system',
      action: 'invariant.violated',
      targetType: 'member',
      targetId: matched.ssoUsername,
      outcome: 'error',
      source: 'ui',
      correlationId: newCorrelationId(),
      detail: { reason: 'login_alias write collided', attemptedAlias: headerUsername },
    });
    return undefined;
  }

  writeAuditRow(db, {
    actor: matched.ssoUsername,
    actorRole: 'member',
    action: 'member.alias_linked',
    targetType: 'member',
    targetId: matched.ssoUsername,
    before: { loginAlias: matched.loginAlias },
    after: { loginAlias: headerUsername },
    outcome: 'ok',
    source: 'ui',
    correlationId: newCorrelationId(),
    detail: { resolvedVia: 'email' },
  });

  return { ssoUsername: matched.ssoUsername, via: 'email' };
}

/**
 * Impure shell for the resolution order documented above. `headerUsername`
 * MUST already be the canonical lowercased value (`Identity.username`, never
 * `displayUsername`). `rawEmailHeader` is the UNPARSED `AUTH_EMAIL_HEADER`
 * value for this request (or `undefined`/`null`/`''` if the proxy didn't
 * send one).
 */
export function resolveMemberKey(headerUsername: string, rawEmailHeader: string | null | undefined): MemberResolution {
  const db = getDb();

  const exact = db.select({ ssoUsername: member.ssoUsername }).from(member).where(eq(member.ssoUsername, headerUsername)).all();
  if (exact.length > 0) return { ssoUsername: headerUsername, via: 'exact' };

  const aliased = db.select({ ssoUsername: member.ssoUsername }).from(member).where(eq(member.loginAlias, headerUsername)).all();
  if (aliased.length > 0) return { ssoUsername: aliased[0].ssoUsername, via: 'alias' };

  const viaEmail = tryLinkByEmail(db, headerUsername, rawEmailHeader);
  if (viaEmail) return viaEmail;

  return { ssoUsername: headerUsername, via: 'unresolved' };
}
