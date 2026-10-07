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
import { getDb } from '@/lib/db';
import { member } from '@/lib/db/schema';
import { getConfig } from '@/lib/config';
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
 * reconciler hasn't seen this Authentik user, or they aren't entitled at
 * all); a defined `row` with `syncStatus !== 'matched'` covers
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
