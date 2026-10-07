/**
 * The extensible "is anyone watching this" guard set — `FR-DEL-4`/`FR-DEL-4a`/
 * `FR-DEL-4b`, added to the spec mid-build after live Jellyfin data showed
 * `recently_played` alone (the original `FR-DEL-4`) is badly insufficient:
 * 169 items are currently in progress, 132 of them (78%) with no playback in
 * the last 14 days — someone paused a series and hasn't come back yet, which
 * a 14-day recency window is blind to.
 *
 * `FR-DEL-4` is now THREE independent guards, each with its own reason, so
 * the UI can say which one fired:
 *
 *   - `recently_played` — anyone played it within `DELETE_RECENT_PLAY_DAYS`
 *     (default 14).
 *   - `in_progress` — anyone has it unfinished (a resume position and not
 *     marked played, or — for a series — some but not all episodes watched),
 *     with activity inside `DELETE_IN_PROGRESS_DAYS` (default 90). **Built
 *     here** now that `src/lib/playback/**`/`src/lib/db/schema.ts` capture
 *     `played`/`position_ticks`/`episodes_played`/`episodes_total`
 *     (`FR-ACCT-6`, revised).
 *   - `active_session` — **NOT built here**. Needs a live Jellyfin session
 *     check (`P3-8`). Per `FR-DEL-4`'s own text: "until then this guard is
 *     unavailable and MUST fail *safe*" — see `runDeletionGuards`'s
 *     `unavailable` invariant below, which is exactly the mechanism a future
 *     `active_session` guard would use to satisfy that.
 *
 * `FR-DEL-4b`: guards are evaluated as a plain array of independent
 * functions (`DeletionGuard`), each producing its own `GuardEvaluation`.
 * Adding `active_session` later is "write one more `DeletionGuard` and push
 * it onto `DELETION_GUARDS`" — nothing in `authorize.ts` or `execute.ts`
 * needs to change, since both already iterate "every fired guard"
 * generically rather than branching on guard identity.
 *
 * `FR-DEL-4a` — messaging is asymmetric by audience: a MEMBER is told
 * *that* someone else is watching, never *who*; the OPERATOR sees who. Each
 * `GuardEvaluation` therefore carries two parallel message/detail pairs
 * (`member*` / `operator*`) rather than one, so a caller (`plan.ts`,
 * `execute.ts`) can select the right one per viewer without ever having
 * another member's identity available to leak by accident on the member
 * path — `memberDetail`/`memberMessage` are constructed WITHOUT that
 * information in the first place, not filtered out after the fact.
 *
 * ## `FR-DEL-21` — the live fail-open this file now closes
 *
 * On the first real deployment, the playback reconciler step failed outright
 * (`attempt to write a readonly database` — SQLite cannot open Jellyfin's
 * WAL-mode DB read-only in a `:ro`-mounted container). `syncPlayback`
 * correctly wrote NOTHING on that failure (`src/lib/playback/sync.ts`'s own
 * "failure isolation" contract) — but that left every `title.
 * watched_by_anyone` at its schema default, `false`. `recentlyPlayedGuard`,
 * reading only `title.watchedByAnyone`, had no way to distinguish "we
 * successfully confirmed nobody watched this" from "we have no idea" — it
 * read `false` as the former and reported `fired: false`, a fail-OPEN across
 * the entire library. `runDeletionGuards`'s `unavailable ⇒ fired` invariant
 * was already correct; what was missing was anything that actually SET
 * `unavailable` when the playback source was simply absent/stale.
 *
 * The fix: `GuardContext.playbackUnavailable`, computed ONCE per
 * `plan.ts`/`execute.ts` call (see `buildGuardContext` below) from
 * `findLatestSuccessfulPlaybackSync` (`src/lib/playback/sync.ts`) — `true`
 * when the playback step has never completed successfully, or its last
 * success is older than `STALE_SNAPSHOT_MAX_AGE_S`. EVERY playback-dependent
 * guard checks this FIRST, before consulting any title/playback data at all,
 * and returns `unavailable: true, fired: true` if it's set — so "we don't
 * know" can never again be read as "nobody watched it." A genuinely fresh,
 * successful sync that observes real zero-playback data is unaffected: that
 * is a true negative, not missing data, and is trusted as such (matching
 * `src/lib/playback/sync.ts`'s own "case 2" distinction).
 */
import { and, eq, sql } from 'drizzle-orm';
import type { SeerrQuotaDb } from '@/lib/db';
import { member, playback } from '@/lib/db/schema';
import { findLatestSuccessfulPlaybackSync } from '@/lib/playback/sync';

export type DeletionGuardId = 'recently_played' | 'in_progress' | 'active_session';

export interface GuardEvaluation {
  guardId: DeletionGuardId;
  /** True = this guard blocks file deletion right now. */
  fired: boolean;
  /**
   * True if the guard could NOT be conclusively evaluated (missing data,
   * an unavailable upstream). `runDeletionGuards` enforces, as a structural
   * invariant rather than a convention any one guard has to remember, that
   * `unavailable: true` may never coexist with `fired: false` — "fail safe"
   * per `FR-DEL-4b`: absence of evidence is not evidence someone isn't
   * watching, so an unevaluable guard must present as a block.
   */
  unavailable?: boolean;
  /** Member-facing text. MUST NOT name another member (`FR-DEL-4a`). Present only when `fired`. */
  memberMessage?: string;
  /** Non-identifying structured detail, safe for a member-facing surface. Present only when `fired`. */
  memberDetail?: Record<string, unknown>;
  /** Operator-facing text. MAY name who (`FR-DEL-4a`). Present only when `fired`. */
  operatorMessage?: string;
  /** Structured detail for operator-facing surfaces (audit log, admin UI) ONLY — may include identity. Present only when `fired`. */
  operatorDetail?: Record<string, unknown>;
}

/**
 * One (title, user) row's "is this unfinished" signal for the `in_progress`
 * guard, resolved by the impure shell (`loadInProgressSignals` below) from
 * the `playback` table — deliberately per-USER, unlike `title.
 * watched_by_anyone`/`last_played_any_at`, because "in progress" is not a
 * property `playback/sync.ts` denormalises onto `title` (see this file's
 * header comment for what IS denormalised and why).
 */
export interface InProgressSignal {
  jellyfinUserId: string;
  /** Resolved via `member.jellyfin_user_id`, or `null` if this Jellyfin user has no linked member row — same "enrich, never gate" rule as `recentPlayerUsernames` below. */
  ssoUsername: string | null;
  lastPlayedAt: number | null;
  /** `true` when THIS user's playback state for the title is unfinished: movie = `positionTicks > 0 && !played`; series = `0 < episodesPlayed < episodesTotal` (`FR-DEL-4`). */
  unfinished: boolean;
}

export interface GuardContext {
  title: {
    watchedByAnyone: boolean;
    lastPlayedAnyAt: number | null;
  };
  nowSeconds: number;
  deleteRecentPlayDays: number;
  /** `DELETE_IN_PROGRESS_DAYS` — the `in_progress` guard's recency window (`FR-DEL-4`), deliberately wider than `deleteRecentPlayDays`. */
  deleteInProgressDays: number;
  /**
   * Usernames who played this title within the recency window, resolved by
   * the impure shell (`loadRecentPlayers` below) via a
   * `playback`⋈`member` join on `jellyfin_user_id`. Empty when nobody
   * resolves (no linked `member` row for the Jellyfin user, or genuinely
   * nobody played it) — this ONLY enriches the operator-facing detail; it
   * NEVER gates `fired` (identity resolution failing must not silently
   * un-fire a guard that the denormalised `title.watched_by_anyone` /
   * `title.last_played_any_at` columns already say fired).
   */
  recentPlayerUsernames: string[];
  /**
   * `true` when a Jellyfin user with NO linked `member` row played this title
   * within the recency window. Such a viewer can never be the subject, so it
   * always counts as "someone else" — it keeps the self-exemption below from
   * un-firing a guard just because the other viewer couldn't be identified.
   */
  recentUnlinkedPlay: boolean;
  /**
   * The member whose deletion this is (`subject` in `plan.ts`/`schedule.ts`/
   * `execute.ts` — the actor, or the member an operator acts on behalf of).
   * `FR-DEL-4` blocks on someone ELSE watching: the subject's own playback
   * never fires a guard against their own deletion. `null` exempts nobody.
   */
  subjectUsername: string | null;
  /** Every user's unfinished/timing signal for this title (`in_progress`'s raw input) — see `InProgressSignal`. */
  inProgressSignals: InProgressSignal[];
  /**
   * `FR-DEL-21` — `true` when the playback sync step has never completed
   * successfully, or its last success is older than
   * `STALE_SNAPSHOT_MAX_AGE_S`. Every playback-dependent guard MUST check
   * this FIRST and return `unavailable: true, fired: true` when it's set,
   * regardless of what `title`/`inProgressSignals` otherwise say — see this
   * file's header comment.
   */
  playbackUnavailable: boolean;
}

export type DeletionGuard = (ctx: GuardContext) => GuardEvaluation;

const SECONDS_PER_DAY = 86_400;

/**
 * `recently_played` — `FR-DEL-4`'s first guard. Reads `title`'s already-synced
 * denormalised columns (`watchedByAnyone`/`lastPlayedAnyAt` — see
 * `wiki/Data-Model.md` §title) — but ONLY once `FR-DEL-21`'s
 * `playbackUnavailable` check (first, below) has cleared, since those columns
 * default to `false`/`null` and are indistinguishable from a genuine "nobody
 * watched it" without that check.
 *
 * `age <= window` (inclusive), not `<` — mirrors this codebase's existing
 * enforcement convention of resolving a boundary the more conservative way
 * for a guard that exists to protect someone's in-progress viewing (see
 * `src/lib/enforcement/decide.ts`'s own `>` vs `>=` note for the opposite
 * direction on quota, where the conservative choice points the other way).
 *
 * `FR-DEL-19` — `watchedByAnyone: true` with `lastPlayedAnyAt: null` is NOT
 * the same state as "nobody ever played it". It means "we know someone
 * played it, we just don't know when" — reachable in practice, because
 * `playback/sync.ts` can set `watchedByAnyone` from a per-user aggregate
 * whose own `lastPlayedAt` is null. Absence of a timestamp is not evidence
 * nobody is watching, so this resolves to the `unavailable: true, fired:
 * true` fail-safe shape `runDeletionGuards`'s own invariant exists for —
 * never to `fired: false`, which would silently turn "we don't know" into
 * "allow".
 */
export const recentlyPlayedGuard: DeletionGuard = (ctx) => {
  // FR-DEL-21 — checked FIRST, before anything else this guard would
  // otherwise read: the playback step failed, never ran, or is stale. See
  // this file's header comment ("the live fail-open this file now closes").
  if (ctx.playbackUnavailable) {
    return {
      guardId: 'recently_played',
      fired: true,
      unavailable: true,
      memberMessage: 'Whether anyone has played this could not be confirmed right now.',
      operatorMessage: 'Playback data is unavailable or stale (sync failed, never ran, or is older than the staleness window) — treated as recently played to fail safe (FR-DEL-21).',
    };
  }

  const { watchedByAnyone, lastPlayedAnyAt } = ctx.title;
  if (!watchedByAnyone) {
    return { guardId: 'recently_played', fired: false };
  }
  if (lastPlayedAnyAt === null) {
    // FR-DEL-19 — played, but when is unknown: fail safe, block.
    return {
      guardId: 'recently_played',
      fired: true,
      unavailable: true,
      memberMessage: 'Played by someone, but exactly when could not be confirmed.',
      operatorMessage: 'watched_by_anyone is true but last_played_any_at is null — treated as recently played to fail safe.',
    };
  }
  const ageSeconds = ctx.nowSeconds - lastPlayedAnyAt;
  if (ageSeconds > ctx.deleteRecentPlayDays * SECONDS_PER_DAY) {
    return { guardId: 'recently_played', fired: false };
  }

  // FR-DEL-4: the subject's own recent play doesn't block their own delete.
  // Only exempt when the subject is the ONLY recent viewer we can see — an
  // unlinked viewer, or no resolvable viewer at all, still fails safe.
  const who = ctx.recentPlayerUsernames.filter((u) => u !== ctx.subjectUsername);
  if (ctx.subjectUsername !== null && who.length === 0 && !ctx.recentUnlinkedPlay && ctx.recentPlayerUsernames.includes(ctx.subjectUsername)) {
    return { guardId: 'recently_played', fired: false };
  }
  return {
    guardId: 'recently_played',
    fired: true,
    memberMessage: `Played by someone else within the last ${ctx.deleteRecentPlayDays} days.`,
    memberDetail: { lastPlayedAnyAt },
    operatorMessage:
      who.length > 0
        ? `Played within the last ${ctx.deleteRecentPlayDays} days by ${who.join(', ')}.`
        : `Played within the last ${ctx.deleteRecentPlayDays} days (player could not be identified from linked accounts).`,
    operatorDetail: { lastPlayedAnyAt, playedBy: who },
  };
};

/**
 * `in_progress` — `FR-DEL-4`'s second guard: anyone has this title
 * UNFINISHED (a resume position and not marked played, or — for a series —
 * some but not all episodes watched), with activity inside
 * `DELETE_IN_PROGRESS_DAYS` (default 90, deliberately much wider than
 * `recently_played`'s window — a false block costs one undeletable title, a
 * false allow costs someone their show).
 *
 * Same FR-DEL-21 fail-safe-first shape as `recentlyPlayedGuard`, plus its own
 * FR-DEL-19-style fail-safe: an unfinished signal whose `lastPlayedAt` is
 * unknown blocks rather than silently passing through the recency window
 * check (there is no age to compare against `deleteInProgressDays` if the
 * timestamp itself is missing).
 *
 * Operates over `ctx.inProgressSignals` (per-user, from `loadInProgressSignals`
 * below) rather than a single denormalised title-level pair, because unlike
 * `watchedByAnyone`/`lastPlayedAnyAt`, "in progress" genuinely varies per
 * user and `playback/sync.ts` deliberately does not collapse it onto `title`.
 */
export const inProgressGuard: DeletionGuard = (ctx) => {
  if (ctx.playbackUnavailable) {
    return {
      guardId: 'in_progress',
      fired: true,
      unavailable: true,
      memberMessage: 'Whether someone has this partway through could not be confirmed right now.',
      operatorMessage: 'Playback data is unavailable or stale (sync failed, never ran, or is older than the staleness window) — treated as in progress to fail safe (FR-DEL-21).',
    };
  }

  // FR-DEL-4: the subject's own unfinished playback doesn't block their own delete.
  const unfinished = ctx.inProgressSignals.filter((s) => s.unfinished && (ctx.subjectUsername === null || s.ssoUsername !== ctx.subjectUsername));
  if (unfinished.length === 0) {
    return { guardId: 'in_progress', fired: false };
  }

  const unknownTiming = unfinished.filter((s) => s.lastPlayedAt === null);
  if (unknownTiming.length > 0) {
    // Mirrors FR-DEL-19's fail-safe shape: unfinished for at least one
    // viewer, but exactly when is unknown for at least one of them — cannot
    // rule out "within the window", so fail safe rather than silently
    // ignoring that viewer's progress.
    return {
      guardId: 'in_progress',
      fired: true,
      unavailable: true,
      memberMessage: 'Someone has this partway through, but exactly when could not be confirmed.',
      operatorMessage: `Unfinished with no recorded last-played date for ${unknownTiming.length} viewer(s) — treated as in progress to fail safe.`,
    };
  }

  const windowSeconds = ctx.deleteInProgressDays * SECONDS_PER_DAY;
  const withinWindow = unfinished.filter((s) => ctx.nowSeconds - (s.lastPlayedAt as number) <= windowSeconds);
  if (withinWindow.length === 0) {
    return { guardId: 'in_progress', fired: false };
  }

  const who = [...new Set(withinWindow.map((s) => s.ssoUsername).filter((u): u is string => u !== null))];
  return {
    guardId: 'in_progress',
    fired: true,
    memberMessage: `Someone else has this partway through, within the last ${ctx.deleteInProgressDays} days.`,
    memberDetail: { count: withinWindow.length },
    operatorMessage:
      who.length > 0
        ? `Partway through, within the last ${ctx.deleteInProgressDays} days, for ${who.join(', ')}.`
        : `Partway through, within the last ${ctx.deleteInProgressDays} days (viewer(s) could not be identified from linked accounts).`,
    operatorDetail: { playedBy: who, count: withinWindow.length },
  };
};

/**
 * The full, extensible guard set (`FR-DEL-4b`): `recently_played` and
 * `in_progress` are implemented; `active_session` is not — see this file's
 * header comment for why, and what a follow-up round needs to add it: a new
 * `DeletionGuard` function, pushed onto this array. Nothing else in this
 * module, `authorize.ts`, or `execute.ts` branches on guard identity, so this
 * is a genuine drop-in seam, not just a comment promising one — proven
 * directly in `test/deletion-guards.test.ts` by running a third, fake guard
 * through `runDeletionGuards` alongside these two.
 */
export const DELETION_GUARDS: readonly DeletionGuard[] = [recentlyPlayedGuard, inProgressGuard];

/**
 * Runs every guard in `guards` against `ctx` and enforces the fail-safe
 * invariant: a guard reporting `unavailable: true` MUST also report
 * `fired: true`. Throwing here (rather than silently coercing) makes a
 * violation a loud bug in the GUARD's own implementation, not a runtime
 * condition `execute.ts` has to remember to defend against — the same
 * "design the API so a caller can't easily get this wrong" discipline
 * `@/lib/audit`'s `withAudit`/`runRemoteEffect` already use in this codebase.
 */
export function runDeletionGuards(guards: readonly DeletionGuard[], ctx: GuardContext): GuardEvaluation[] {
  return guards.map((guard) => {
    const result = guard(ctx);
    if (result.unavailable && !result.fired) {
      throw new Error(
        `deletion guard '${result.guardId}' reported unavailable=true but fired=false — FR-DEL-4b's fail-safe rule requires a guard that cannot be evaluated to block (fired=true), never to silently allow. This is a bug in the guard's own implementation.`,
      );
    }
    return result;
  });
}

/** Every guard that actually fired — what `authorize.ts` blocks on. */
export function firedGuards(evaluations: readonly GuardEvaluation[]): GuardEvaluation[] {
  return evaluations.filter((g) => g.fired);
}

/**
 * Impure shell: resolves WHO played `titleId` within the last
 * `deleteRecentPlayDays` — used only to populate `recently_played`'s
 * operator-facing detail (`FR-DEL-4a`). Joins `playback` (per-user rows) to
 * `member` on `jellyfin_user_id`, both already normalised (no dashes,
 * lowercase) per `wiki/Data-Model.md` §playback/§member, so an equality join
 * is correct without extra normalisation here. Deliberately reads the
 * schema tables directly (the same "impure shell reads schema tables
 * directly" pattern `src/app/_data/memberDashboard.ts` already uses for
 * `claim`/`title`) rather than going through `src/lib/playback/**`, which
 * doesn't expose per-title-per-user resolution as a public function.
 */
export function loadRecentPlayers(db: SeerrQuotaDb, titleId: string, sinceSeconds: number): { usernames: string[]; unlinked: boolean } {
  const rows = db
    .select({ ssoUsername: member.ssoUsername })
    .from(playback)
    .leftJoin(member, eq(member.jellyfinUserId, playback.jellyfinUserId))
    .where(and(eq(playback.titleId, titleId), sql`${playback.lastPlayedAt} IS NOT NULL AND ${playback.lastPlayedAt} >= ${sinceSeconds}`))
    .all();
  const usernames = rows.map((r) => r.ssoUsername).filter((u): u is string => u !== null);
  return { usernames: [...new Set(usernames)], unlinked: rows.some((r) => r.ssoUsername === null) };
}

/**
 * Impure shell for `in_progress`'s raw input: every (title, user) playback
 * row for `titleId`, left-joined to `member` for an operator-facing
 * username (may be `null` — same "enrich, never gate" rule as
 * `loadRecentPlayers`), with `unfinished` computed per
 * `mediaType`'s rule (`FR-DEL-4`, see `InProgressSignal`'s own doc comment).
 * `mediaType` is the SUBJECT title's type (from `FreshTitleClaimState.
 * mediaType`, `deletionStore.ts`) — every row read here belongs to the same
 * title, so it applies uniformly.
 */
export function loadInProgressSignals(db: SeerrQuotaDb, titleId: string, mediaType: 'movie' | 'tv'): InProgressSignal[] {
  const rows = db
    .select({
      jellyfinUserId: playback.jellyfinUserId,
      played: playback.played,
      positionTicks: playback.positionTicks,
      episodesPlayed: playback.episodesPlayed,
      episodesTotal: playback.episodesTotal,
      lastPlayedAt: playback.lastPlayedAt,
      ssoUsername: member.ssoUsername,
    })
    .from(playback)
    .leftJoin(member, eq(member.jellyfinUserId, playback.jellyfinUserId))
    .where(eq(playback.titleId, titleId))
    .all();

  return rows.map((r) => ({
    jellyfinUserId: r.jellyfinUserId,
    ssoUsername: r.ssoUsername ?? null,
    lastPlayedAt: r.lastPlayedAt,
    unfinished:
      mediaType === 'movie'
        ? r.positionTicks > 0 && !r.played
        : r.episodesPlayed !== null && r.episodesTotal !== null && r.episodesPlayed > 0 && r.episodesPlayed < r.episodesTotal,
  }));
}

/**
 * `FR-DEL-21`'s staleness rule, pure and hand-testable in isolation: no
 * successful playback snapshot has EVER completed (`ageSeconds === null`),
 * or the last one is older than `maxAgeS`. Mirrors `src/lib/enforcement/
 * decide.ts`'s identical `snapshotAgeS` convention (kept as an independent
 * copy rather than an import — that module is out of this task's file
 * scope to modify).
 */
export function isPlaybackSnapshotStale(ageSeconds: number | null, maxAgeS: number): boolean {
  return ageSeconds === null || ageSeconds > maxAgeS;
}

export interface BuildGuardContextInput {
  titleId: string;
  mediaType: 'movie' | 'tv';
  watchedByAnyone: boolean;
  lastPlayedAnyAt: number | null;
  nowSeconds: number;
  deleteRecentPlayDays: number;
  deleteInProgressDays: number;
  playbackUnavailable: boolean;
  /** See `GuardContext.subjectUsername`. */
  subjectUsername: string;
}

/**
 * Assembles one title's `GuardContext` from freshly-read DB state — the
 * single place `plan.ts` and `execute.ts` both build it, so the two paths
 * can never disagree about what a given title's guard inputs are (the same
 * "one function, every path" discipline `authorize.ts`'s `deriveTitleAction`
 * documents). `playbackUnavailable` is passed in rather than computed here
 * because it's a BATCH-level property (one playback sync step, not one per
 * title) — callers compute it once via `findLatestSuccessfulPlaybackSync` +
 * `isPlaybackSnapshotStale` before looping over titles, not once per title.
 */
export function buildGuardContext(db: SeerrQuotaDb, input: BuildGuardContextInput): GuardContext {
  const recentPlayers = loadRecentPlayers(db, input.titleId, input.nowSeconds - input.deleteRecentPlayDays * SECONDS_PER_DAY);
  const inProgressSignals = loadInProgressSignals(db, input.titleId, input.mediaType);
  return {
    title: { watchedByAnyone: input.watchedByAnyone, lastPlayedAnyAt: input.lastPlayedAnyAt },
    nowSeconds: input.nowSeconds,
    deleteRecentPlayDays: input.deleteRecentPlayDays,
    deleteInProgressDays: input.deleteInProgressDays,
    recentPlayerUsernames: recentPlayers.usernames,
    recentUnlinkedPlay: recentPlayers.unlinked,
    subjectUsername: input.subjectUsername,
    inProgressSignals,
    playbackUnavailable: input.playbackUnavailable,
  };
}

/**
 * `FR-DEL-21`'s batch-level check, wired to a real DB: `true` when the
 * playback step has never completed successfully, or its last success is
 * older than `staleSnapshotMaxAgeS`. Callers (`plan.ts`, `execute.ts`) call
 * this ONCE per batch, before the per-title loop.
 */
export function isPlaybackUnavailable(db: SeerrQuotaDb, nowSeconds: number, staleSnapshotMaxAgeS: number): boolean {
  const snapshot = findLatestSuccessfulPlaybackSync(db);
  const ageSeconds = snapshot ? nowSeconds - snapshot.finishedAt : null;
  return isPlaybackSnapshotStale(ageSeconds, staleSnapshotMaxAgeS);
}
