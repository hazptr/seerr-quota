/**
 * The impure shell around the `claim`/`title`/`deletion` tables for this
 * module — every DB read/write the deletion flow needs that isn't the audit
 * log itself. Two responsibilities kept together because they're both thin
 * wrappers over the same handful of tables, mirroring how
 * `src/lib/enforcement/requestDecisionStore.ts` groups its table's
 * read/write helpers in one file:
 *
 *   1. **`loadFreshTitleClaimStates`** — THE read that makes `FR-DEL-1`/
 *      `FR-DEL-14` true. Called fresh at the start of every `plan.ts`/
 *      `execute.ts` call, over exactly the title ids the caller asked
 *      about, for exactly the subject whose claims matter. Never cached
 *      across a request, never supplemented by anything the client sent.
 *   2. **`deletion` table read/write helpers** — the per-title operational
 *      record (`wiki/Data-Model.md` §deletion), independent of the audit
 *      log (which is the forensic record; this is the "what's the current
 *      state of this specific delete/release attempt" record an operator's
 *      attention panel would query).
 *
 * `releaseClaimWithAudit` also lives here (not `execute.ts`) because it's
 * the one local DB write in this module and belongs next to the `claim`
 * table access it performs.
 */
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { ActorRole, Source } from '@/lib/audit';
import { writeAuditRow } from '@/lib/audit';
import type { SeerrQuotaDb } from '@/lib/db';
import { claim, deletion, title } from '@/lib/db/schema';
import { isOverDeleteRateLimit } from './rateLimit';
import type { DeletionMode } from './types';

export interface FreshTitleClaimState {
  titleId: string;
  /** False for an id with no matching `title` row at all — treated identically to "not a claimant" by `authorize.ts` (FR-DEL-14). */
  exists: boolean;
  name: string;
  year: number | null;
  path: string;
  /** `title.media_type` — feeds `in_progress`'s per-media-type unfinished rule (`guards.ts`'s `loadInProgressSignals`). Defaults to `'movie'` in `emptyState` (never actually consulted for a non-existent title). */
  mediaType: 'movie' | 'tv';
  /** `title.size_bytes` at last reconcile — `<= 0` means nothing to delete (`authorize.ts`'s `already_gone`). */
  sizeBytes: number;
  arrInstance: 'radarr' | 'radarr-4k' | 'sonarr' | 'sonarr-4k';
  arrId: number;
  protectedTitle: boolean;
  protectedReason: string | null;
  watchedByAnyone: boolean;
  lastPlayedAnyAt: number | null;
  /** Whether the SUBJECT (not necessarily the acting operator) holds a currently-active claim. */
  hasActiveClaim: boolean;
  /** Total distinct active claimants on this title (including the subject, if `hasActiveClaim`). */
  activeClaimantCount: number;
  /** The subject's own active `claim.id` — needed to update it on release. `null` when `!hasActiveClaim`. */
  claimId: number | null;
  /** The subject's own claim's `charged_bytes` — `0` when `!hasActiveClaim`. */
  chargedBytes: number;
  /** The subject's own claim's `seerr_request_id` — `null` for an operator-assigned claim, or when `!hasActiveClaim`. */
  seerrRequestId: number | null;
}

function emptyState(titleId: string): FreshTitleClaimState {
  return {
    titleId,
    exists: false,
    name: '',
    year: null,
    path: '',
    mediaType: 'movie',
    sizeBytes: 0,
    arrInstance: 'radarr',
    arrId: 0,
    protectedTitle: false,
    protectedReason: null,
    watchedByAnyone: false,
    lastPlayedAnyAt: null,
    hasActiveClaim: false,
    activeClaimantCount: 0,
    claimId: null,
    chargedBytes: 0,
    seerrRequestId: null,
  };
}

/**
 * FR-DEL-1/FR-DEL-14 — the ONE place this module reads "what is actually
 * true right now" for a batch of title ids, for `subject` (the member whose
 * claims are in play — see `types.ts`/`plan.ts`/`execute.ts` for how a
 * member vs. an operator-on-behalf-of resolves to a subject). Two queries,
 * batched over every id in `titleIds` rather than one query per title:
 *
 *   1. `title` rows for the given ids (size, path, protected, playback
 *      convenience columns, arr routing).
 *   2. EVERY currently-active `claim` row for those titles (any member, not
 *      just `subject`) — used both to find the subject's own claim (if any)
 *      and to count total active claimants per title (sole vs. co-claimant,
 *      `FR-DEL-2`).
 *
 * A titleId with no matching `title` row gets `exists: false` and every
 * other field at its zero value — `authorize.ts` treats this identically to
 * "not a claimant" (FR-DEL-14: a guessed id must be indistinguishable from a
 * real title the actor doesn't own).
 */
export function loadFreshTitleClaimStates(db: SeerrQuotaDb, subject: string, titleIds: string[]): Map<string, FreshTitleClaimState> {
  const out = new Map<string, FreshTitleClaimState>();
  if (titleIds.length === 0) return out;
  for (const id of titleIds) out.set(id, emptyState(id));

  const titleRows = db.select().from(title).where(inArray(title.id, titleIds)).all();
  for (const t of titleRows) {
    const state = out.get(t.id);
    if (!state) continue;
    state.exists = true;
    state.name = t.title;
    state.year = t.year;
    state.path = t.path;
    state.mediaType = t.mediaType;
    state.sizeBytes = t.sizeBytes;
    state.arrInstance = t.arrInstance;
    state.arrId = t.arrId;
    state.protectedTitle = t.protected;
    state.protectedReason = t.protectedReason;
    state.watchedByAnyone = t.watchedByAnyone;
    state.lastPlayedAnyAt = t.lastPlayedAnyAt;
  }

  const claimRows = db
    .select({
      id: claim.id,
      titleId: claim.titleId,
      ssoUsername: claim.ssoUsername,
      chargedBytes: claim.chargedBytes,
      seerrRequestId: claim.seerrRequestId,
    })
    .from(claim)
    .where(and(inArray(claim.titleId, titleIds), eq(claim.active, true)))
    .all();

  // FR-DEL-20: count DISTINCT usernames per title, not claim rows. The
  // `claim_title_sso_active_unique` partial index (schema.ts) makes a
  // duplicate active row for the same (title, member) pair impossible going
  // forward, but this count must not itself regress into a data-integrity
  // footgun if that invariant is ever violated by a bug or a future writer —
  // counting rows would turn a sole claimant into an apparent co-claimant
  // and hand them the release `FR-DEL-2` forbids.
  const usernamesByTitle = new Map<string, Set<string>>();
  for (const row of claimRows) {
    let usernames = usernamesByTitle.get(row.titleId);
    if (!usernames) {
      usernames = new Set<string>();
      usernamesByTitle.set(row.titleId, usernames);
    }
    usernames.add(row.ssoUsername);
    if (row.ssoUsername !== subject) continue;
    const state = out.get(row.titleId);
    if (!state) continue;
    state.hasActiveClaim = true;
    state.claimId = row.id;
    state.chargedBytes = row.chargedBytes;
    state.seerrRequestId = row.seerrRequestId;
  }
  for (const [titleId, usernames] of usernamesByTitle) {
    const state = out.get(titleId);
    if (state) state.activeClaimantCount = usernames.size;
  }

  return out;
}

// ---------------------------------------------------------------------------
// `deletion` table (wiki/Data-Model.md §deletion)
// ---------------------------------------------------------------------------

export interface InsertDeletionRowInput {
  ssoUsername: string;
  titleId: string;
  mode: DeletionMode;
  state: 'executing' | 'done' | 'blocked';
  bytesClaimed: number;
  requestedAt: number;
  executedAt?: number;
}

export function insertDeletionRow(db: SeerrQuotaDb, input: InsertDeletionRowInput): number {
  const row = db
    .insert(deletion)
    .values({
      ssoUsername: input.ssoUsername,
      titleId: input.titleId,
      mode: input.mode,
      state: input.state,
      bytesClaimed: input.bytesClaimed,
      bytesFreed: null,
      arrCall: null,
      arrStatus: null,
      error: null,
      requestedAt: input.requestedAt,
      executedAt: input.executedAt ?? null,
    })
    .returning({ id: deletion.id })
    .get();
  return row.id;
}

export function markDeletionDone(
  db: SeerrQuotaDb,
  id: number,
  patch: { bytesFreed: number; arrCall: string | null; arrStatus: number | null; executedAt: number },
): void {
  db.update(deletion)
    .set({ state: 'done', bytesFreed: patch.bytesFreed, arrCall: patch.arrCall, arrStatus: patch.arrStatus, executedAt: patch.executedAt })
    .where(eq(deletion.id, id))
    .run();
}

export function markDeletionFailed(
  db: SeerrQuotaDb,
  id: number,
  patch: { arrCall: string | null; arrStatus: number | null; error: string; executedAt: number },
): void {
  db.update(deletion)
    .set({ state: 'failed', arrCall: patch.arrCall, arrStatus: patch.arrStatus, error: patch.error, executedAt: patch.executedAt })
    .where(eq(deletion.id, id))
    .run();
}

/**
 * `FR-DEL-9`'s partial-failure case: the arr delete already succeeded
 * (`markDeletionDone` already ran, `state='done'`) but the Seerr cleanup
 * call afterward failed. Deliberately does NOT flip `state` to `'failed'` —
 * that would misrepresent reality: the files really are gone. This only
 * appends the explanatory note to `error`, so the row stays programmatically
 * detectable as a partial failure (`state='done' AND error IS NOT NULL`),
 * matching the wiki's own "detectable, should raise an operator alert" style
 * of anomaly for a done-but-not-quite-clean deletion.
 */
export function markDeletionPartialFailure(db: SeerrQuotaDb, id: number, errorNote: string): void {
  db.update(deletion).set({ error: errorNote }).where(eq(deletion.id, id)).run();
}

/**
 * `COUNT(*)` of this subject's `delete_files` `deletion` rows that actually
 * reached (or completed) an arr call attempt within the last `sinceSeconds`
 * — i.e. `state IN ('executing', 'done', 'failed')`. Deliberately EXCLUDES
 * `'blocked'` rows: a blocked attempt never reached the arr call at all, so
 * counting it toward `FR-DEL-12`'s rate limit would let an unrelated guard
 * (protected/recent-play) eat into a budget it has nothing to do with.
 * Deliberately excludes `release_claim` rows entirely — releasing touches no
 * file, so it isn't a "title deletion" in `FR-DEL-12`'s sense.
 */
export function countRecentFileDeletions(db: SeerrQuotaDb, subject: string, sinceSeconds: number): number {
  const row = db
    .select({ total: sql<number>`count(*)` })
    .from(deletion)
    .where(
      and(
        eq(deletion.ssoUsername, subject),
        eq(deletion.mode, 'delete_files'),
        sql`${deletion.state} IN ('scheduled', 'executing', 'done', 'failed')`,
        sql`${deletion.requestedAt} >= ${sinceSeconds}`,
      ),
    )
    .get();
  return Number(row?.total ?? 0);
}

/**
 * `FR-DEL-17` — the atomic rate-limit reservation. `countRecentFileDeletions`
 * above, called by itself, is a check-then-act race: two concurrent
 * `executeDeletionBatch` calls can each read the same stale count (nothing
 * written yet by either), both conclude they're under budget, and both
 * proceed — overshooting `DELETE_MAX_PER_HOUR`. `execute.ts`'s per-item loop
 * `await`s a remote call between checking and recording, which is exactly
 * the yield point that lets a second batch's code interleave.
 *
 * This closes that window by doing the count AND the reservation (inserting
 * the `'executing'` deletion row for THIS attempt) inside one
 * `db.transaction()` — a synchronous, uninterrupted unit of work for
 * `better-sqlite3` (no `await` inside it, so nothing else can run between
 * the read and the write). Returns the new row's id if a slot was reserved,
 * or `null` if `subject` is already at/over `deleteMaxPerHour` — in which
 * case nothing is inserted and nothing is reserved.
 *
 * Same inclusion rule as `countRecentFileDeletions`: only rows that will
 * exist as `state IN ('executing', 'done', 'failed')` count, which is
 * automatically true here since the row this function itself inserts starts
 * at `'executing'`.
 */
export function reserveFileDeletionSlot(
  db: SeerrQuotaDb,
  input: { ssoUsername: string; titleId: string; bytesClaimed: number; requestedAt: number; state?: 'executing' | 'scheduled'; scheduledFor?: number | null },
  sinceSeconds: number,
  deleteMaxPerHour: number,
): number | null {
  return db.transaction((tx) => {
    const row = tx
      .select({ total: sql<number>`count(*)` })
      .from(deletion)
      .where(
        and(
          eq(deletion.ssoUsername, input.ssoUsername),
          eq(deletion.mode, 'delete_files'),
          sql`${deletion.state} IN ('scheduled', 'executing', 'done', 'failed')`,
          sql`${deletion.requestedAt} >= ${sinceSeconds}`,
        ),
      )
      .get();
    const recentCount = Number(row?.total ?? 0);
    if (isOverDeleteRateLimit(recentCount, deleteMaxPerHour)) return null;

    const inserted = tx
      .insert(deletion)
      .values({
        ssoUsername: input.ssoUsername,
        titleId: input.titleId,
        mode: 'delete_files',
        state: input.state ?? 'executing',
        bytesClaimed: input.bytesClaimed,
        bytesFreed: null,
        arrCall: null,
        arrStatus: null,
        error: null,
        requestedAt: input.requestedAt,
        scheduledFor: input.scheduledFor ?? null,
        executedAt: null,
      })
      .returning({ id: deletion.id })
      .get();
    return inserted.id;
  });
}

// ---------------------------------------------------------------------------
// The local `claim.released` change (FR-DEL-2, D-6, wiki/Feature-08-Audit-Log.md)
// ---------------------------------------------------------------------------

export interface ReleaseClaimInput {
  /** The BATCH's correlationId (see `execute.ts`) — shared across every row a multi-title operation writes. */
  correlationId: string;
  actorUsername: string;
  actorRole: ActorRole;
  onBehalfOf?: string;
  source: Source;
  titleId: string;
  claimId: number;
  chargedBytes: number;
  remainingActiveClaimants: number;
  downgradedFromDelete: boolean;
  requestedMode: DeletionMode;
}

/**
 * The LOCAL half of a release (`claim.released`). Deliberately does NOT use
 * `@/lib/audit`'s `withAudit` convenience wrapper — `withAudit` always mints
 * its OWN fresh `correlationId` (`src/lib/audit/local.ts`), and this call
 * needs to share the BATCH's correlationId across every row a multi-title
 * `executeDeletionBatch` call writes
 * (`wiki/Feature-08-Audit-Log.md`'s own acceptance criterion: three titles
 * deleted/released in one operation share ONE correlation_id across all
 * their rows). Still satisfies `FR-AUD-8`'s local-change guarantee by hand:
 * the claim update and its audit row commit — or roll back — together,
 * inside the SAME `db.transaction()`, the exact property `withAudit` exists
 * to provide, just without its auto-generated id.
 */
export function releaseClaimWithAudit(db: SeerrQuotaDb, input: ReleaseClaimInput, nowSeconds: number): void {
  db.transaction((tx) => {
    tx.update(claim)
      .set({ active: false, releasedAt: nowSeconds, releasedBy: input.actorUsername })
      .where(eq(claim.id, input.claimId))
      .run();
    writeAuditRow(tx, {
      actor: input.actorUsername,
      actorRole: input.actorRole,
      onBehalfOf: input.onBehalfOf,
      action: 'claim.released',
      targetType: 'title',
      targetId: input.titleId,
      outcome: 'ok',
      source: input.source,
      correlationId: input.correlationId,
      before: { active: true, chargedBytes: input.chargedBytes },
      after: { active: false },
      detail: {
        requestedMode: input.requestedMode,
        downgradedFromDelete: input.downgradedFromDelete,
        remainingActiveClaimants: input.remainingActiveClaimants,
      },
    });
  });
}

// ---------------------------------------------------------------------------
// The scheduled-deletion lifecycle (FR-DEL-22 … FR-DEL-28, D-7)
//
// A member-initiated file deletion no longer destroys anything at confirm
// time. It lands here as a `scheduled` row carrying `scheduled_for`, stays
// cancellable by its owner or the operator, and is executed later by the
// sweeper (`./runner.ts`). Everything below is the impure DB half of that;
// the authority rules live in `./cancel.ts` and `./authorize.ts`.
// ---------------------------------------------------------------------------

/** One scheduled deletion, as the member/admin UI and the sweeper need it. */
export interface ScheduledDeletionRow {
  id: number;
  ssoUsername: string;
  titleId: string;
  bytesClaimed: number;
  requestedAt: number;
  scheduledFor: number;
}

const SCHEDULED_COLUMNS = {
  id: deletion.id,
  ssoUsername: deletion.ssoUsername,
  titleId: deletion.titleId,
  bytesClaimed: deletion.bytesClaimed,
  requestedAt: deletion.requestedAt,
  scheduledFor: deletion.scheduledFor,
} as const;

/**
 * Rows the sweeper may now execute: `state = 'scheduled'` whose
 * `scheduled_for` has passed (`FR-DEL-25`). Ordered oldest-due-first so a
 * backlog after downtime drains in the order members actually confirmed,
 * and capped — a sweep that woke to a thousand due rows should make steady
 * progress over several ticks rather than issue a thousand `DELETE`s in one
 * burst against Radarr/Sonarr.
 *
 * `scheduled_for` is typed nullable on the table (every pre-`FR-DEL-22` row
 * has none) but is NEVER null for a `scheduled` row — `scheduleDeletionBatch`
 * always writes both together. The `isNotNull` clause makes that explicit to
 * SQL rather than relying on the invariant, so a hand-edited row with a null
 * `scheduled_for` can never be swept up as "due since epoch".
 */
export function loadDueScheduledDeletions(db: SeerrQuotaDb, nowSeconds: number, limit: number): ScheduledDeletionRow[] {
  return db
    .select(SCHEDULED_COLUMNS)
    .from(deletion)
    .where(and(eq(deletion.state, 'scheduled'), isNotNull(deletion.scheduledFor), sql`${deletion.scheduledFor} <= ${nowSeconds}`))
    .orderBy(deletion.scheduledFor, deletion.id)
    .limit(limit)
    .all()
    .map((r) => ({ ...r, scheduledFor: r.scheduledFor! }));
}

/** Every still-pending scheduled deletion for one member — their "you can still undo this" list. */
export function loadScheduledDeletionsForMember(db: SeerrQuotaDb, ssoUsername: string): ScheduledDeletionRow[] {
  return db
    .select(SCHEDULED_COLUMNS)
    .from(deletion)
    .where(and(eq(deletion.ssoUsername, ssoUsername), eq(deletion.state, 'scheduled'), isNotNull(deletion.scheduledFor)))
    .orderBy(deletion.scheduledFor, deletion.id)
    .all()
    .map((r) => ({ ...r, scheduledFor: r.scheduledFor! }));
}

/** Every still-pending scheduled deletion, fleet-wide — the operator's view (`FR-ADM-15`). */
export function loadAllScheduledDeletions(db: SeerrQuotaDb): ScheduledDeletionRow[] {
  return db
    .select(SCHEDULED_COLUMNS)
    .from(deletion)
    .where(and(eq(deletion.state, 'scheduled'), isNotNull(deletion.scheduledFor)))
    .orderBy(deletion.scheduledFor, deletion.id)
    .all()
    .map((r) => ({ ...r, scheduledFor: r.scheduledFor! }));
}

/** One scheduled row by id, or `undefined` if it doesn't exist or has already left `scheduled`. */
export function findScheduledDeletion(db: SeerrQuotaDb, id: number): ScheduledDeletionRow | undefined {
  const row = db
    .select(SCHEDULED_COLUMNS)
    .from(deletion)
    .where(and(eq(deletion.id, id), eq(deletion.state, 'scheduled'), isNotNull(deletion.scheduledFor)))
    .get();
  return row ? { ...row, scheduledFor: row.scheduledFor! } : undefined;
}

/**
 * `SUM(bytes_claimed)` over a member's still-`scheduled` deletions — the
 * bytes they have already committed to giving back but which are still on
 * disk. Subtracted from raw claim usage to produce the effective usage the
 * member and enforcement both see (`FR-DEL-27`, the operator's "credit on
 * schedule" decision).
 *
 * Summed in JS rather than via SQL `SUM()` for the same reason
 * `enforcement/usage.ts`'s `getMemberUsageBytes` does it: an unambiguous JS
 * `number` instead of a driver-dependent `string | null` aggregate, at a
 * scale (single-digit members, tens of pending rows at most) where it costs
 * nothing.
 */
export function getPendingDeletionBytes(db: SeerrQuotaDb, ssoUsername: string): number {
  const rows = db
    .select({ bytesClaimed: deletion.bytesClaimed })
    .from(deletion)
    .where(and(eq(deletion.ssoUsername, ssoUsername), eq(deletion.state, 'scheduled')))
    .all();
  return rows.reduce((total, r) => total + r.bytesClaimed, 0);
}

/**
 * Moves a `scheduled` row to `cancelled`, but ONLY if it is still
 * `scheduled` — the `WHERE state = 'scheduled'` clause is the concurrency
 * guard, not decoration. The sweeper can be mid-flight on this exact row
 * when a member clicks Cancel; whichever statement lands first wins and the
 * other becomes a no-op. Returns `true` if this call is the one that
 * actually cancelled it, so the caller knows whether to write the audit row
 * (`FR-DEL-24`) or report "too late, it already ran".
 *
 * `cancelledBy` is an `sso_username`, or `system` when an execution-time
 * guard cancelled it rather than a person (`FR-DEL-26`).
 */
export function markDeletionCancelled(
  db: SeerrQuotaDb,
  id: number,
  patch: { cancelledAt: number; cancelledBy: string; cancelReason: string },
): boolean {
  const result = db
    .update(deletion)
    .set({ state: 'cancelled', cancelledAt: patch.cancelledAt, cancelledBy: patch.cancelledBy, cancelReason: patch.cancelReason })
    .where(and(eq(deletion.id, id), eq(deletion.state, 'scheduled')))
    .run();
  return result.changes > 0;
}

/**
 * Claims a due `scheduled` row for execution by flipping it to `executing`,
 * conditional on it still being `scheduled`. Same guard as
 * `markDeletionCancelled` and for the same reason, from the other side: two
 * overlapping sweeps (or a sweep racing a cancel) must never both proceed to
 * issue the `DELETE`. Only the caller that gets `true` may go on to call the
 * arr — AGENTS.md rule 11 (never retry a delete) starts here.
 */
export function claimScheduledDeletionForExecution(db: SeerrQuotaDb, id: number): boolean {
  const result = db
    .update(deletion)
    .set({ state: 'executing' })
    .where(and(eq(deletion.id, id), eq(deletion.state, 'scheduled')))
    .run();
  return result.changes > 0;
}
