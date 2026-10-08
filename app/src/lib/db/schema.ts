/**
 * Sidecar SQLite schema — the ten tables from `wiki/Data-Model.md`, exactly.
 * WAL mode is set by `getDb()` (`src/lib/db/index.ts`), not here.
 *
 * **Additive-only.** This schema only ever grows (new tables/columns/
 * indexes) — AGENTS.md rule 10, and `wiki/Data-Model.md`'s own header:
 * "Nothing that has ever shipped gets dropped or retyped; the audit log in
 * particular must remain readable by every future version." `drizzle-kit
 * generate` turns changes here into a new numbered SQL file under
 * `drizzle/`; never hand-edit a previously-generated migration.
 *
 * Timestamps are stored as plain `integer` columns holding raw Unix epoch
 * values, NOT drizzle's `{ mode: 'timestamp' }` helper — deliberately, because
 * `wiki/Data-Model.md` documents two different units in the same schema
 * (`audit.ts` is Unix **milliseconds**; every other `*_at` column is Unix
 * **seconds**), and drizzle's timestamp mode assumes seconds uniformly
 * (multiplying by 1000 on read). Using raw integers everywhere keeps the
 * column's actual unit exactly what the doc says, with the unit called out
 * in each column's comment, rather than silently coercing one of them wrong.
 *
 * `audit` is included per this task (P1-1): schema only, append-only by
 * convention — the writer itself is a later backlog item (P1-7). See
 * `test/audit-append-only.test.ts` for the static guard that no code path in
 * this repo issues `UPDATE`/`DELETE` against it (AGENTS.md rule 4).
 */
import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// ---------------------------------------------------------------------------
// member — one row per person known to the system (wiki/Data-Model.md §member)
// ---------------------------------------------------------------------------
export const member = sqliteTable(
  'member',
  {
  /**
   * Forward-auth login username, lowercase. PK — the stable identifier every
   * `claim`/`deletion`/`audit`/`quota_policy`/`request_decision` row keys
   * off of. CRITICAL (0.2.0): once a member row is linked to a Seerr
   * account (`seerr_user_id` set), this value must never be changed by sync
   * — see `src/lib/members/classify.ts`'s header comment on key stability.
   * Before 0.2.0 this was always the Authentik username; since 0.2.0 it is
   * whatever the forward-auth proxy's `AUTH_USER_HEADER` sends (any IdP),
   * normalized the same way.
   */
  ssoUsername: text('sso_username').primaryKey(),
  /**
   * DEPRECATED (0.2.0): was "for stable re-matching if a username is ever
   * changed" under the Authentik-entitlement sync. The roster now comes
   * straight from Seerr (`member.seerr_user_id` is the stable re-match key
   * instead — see `src/lib/members/classify.ts`), so this column is never
   * written by current code. Kept, not dropped (additive-only schema,
   * AGENTS.md rule 10) — old rows may still carry a value from before the
   * 0.2.0 cutover, and it stays harmless to read.
   */
  authentikUuid: text('authentik_uuid'),
  /** Display name — sourced from Seerr's `displayName`/`username` since 0.2.0 (was Authentik `name`). */
  displayName: text('display_name'),
  /** Email — sourced from Seerr since 0.2.0 (was Authentik email). Still the fallback header-based login match key (`src/lib/auth/memberGate.ts`). */
  email: text('email'),
  /**
   * Since 0.2.0: has a Seerr account (the roster source is Seerr itself, so
   * every known Seerr user is entitled; a member whose Seerr account
   * disappeared is flipped to `false` and kept, never deleted). Before
   * 0.2.0 this meant "has the `jellyseerr` application binding in
   * Authentik" — the column's meaning changed, not its shape.
   */
  entitled: integer('entitled', { mode: 'boolean' }).notNull().default(false),
  /**
   * `ADMIN_USERS`, or (request-time only — see `src/lib/auth/identity.ts`)
   * in `ADMIN_GROUP` via the forward-auth groups header. This column itself
   * is recomputed by `src/lib/members/sync.ts` from `ADMIN_USERS` ONLY
   * (`FR-ENF-6`'s background/enforcement-exemption half) — no groups header
   * exists off-request, so an `ADMIN_GROUP`-only admin is NOT reflected
   * here and stays subject to enforcement unless also in `ADMIN_USERS` or
   * given an unlimited quota override (see `wiki/Configuration.md`).
   */
  isOperator: integer('is_operator', { mode: 'boolean' }).notNull().default(false),
  /** Seerr `user.id`; null = no Seerr account yet. */
  seerrUserId: integer('seerr_user_id'),
  /** Jellyfin GUID, normalised (no dashes, lowercase). */
  jellyfinUserId: text('jellyfin_user_id'),
  /**
   * `matched` / `no_seerr_account` / `not_entitled` / `ambiguous`. Since
   * 0.2.0 (roster = Seerr directly), a current Seerr user is always
   * `matched` — `no_seerr_account` can no longer be PRODUCED for a new row
   * (it required a separate IdP-entitlement source with no Seerr account to
   * match against), but the value is kept in the enum (additive-only) so a
   * pre-0.2.0 row carrying it still reads back fine. `ambiguous` can still
   * occur in the rare case of two Seerr accounts deriving the same orphan
   * key (see `src/lib/members/classify.ts`).
   */
  syncStatus: text('sync_status', {
    enum: ['matched', 'no_seerr_account', 'not_entitled', 'ambiguous'],
  })
    .notNull()
    .default('no_seerr_account'),
  /** Unix seconds; null until the first hold notification is sent. Throttles hold notifications to at most one per `notify_cooldown_s` (`FR-ENF-14`). */
  lastHoldNotifiedAt: integer('last_hold_notified_at'),
  /** Why, when status isn't `matched`. */
  syncNote: text('sync_note'),
  /** Unix seconds. */
  firstSeenAt: integer('first_seen_at').notNull(),
  /** Unix seconds. */
  lastSyncedAt: integer('last_synced_at').notNull(),
  /**
   * Added 0.2.0 (`src/lib/auth/memberGate.ts`, FR-SSO-9-ish email-fallback
   * resolution). `null` until a forward-auth login header username is ever
   * resolved to this member via the configured email header rather than an
   * exact `sso_username` match — recorded the FIRST time that happens so
   * every later login from the same proxy-issued username resolves
   * instantly by alias instead of re-running the email search. Unique when
   * non-null (enforced by `memberLoginAliasUniqueIdx` below) and MUST NEVER
   * equal another member's `sso_username` or `login_alias` — both are
   * checked before writing (`src/lib/auth/memberGate.ts`).
   */
  loginAlias: text('login_alias'),
  },
  (t) => ({
    /** SQLite treats multiple `NULL`s as distinct, so this only constrains the non-null aliases actually in use — exactly what we want (`null` is "no alias yet", not a value to dedupe). */
    loginAliasUniqueIdx: uniqueIndex('member_login_alias_unique_idx').on(t.loginAlias),
  }),
);

// ---------------------------------------------------------------------------
// quota_policy (wiki/Data-Model.md §quota_policy)
// ---------------------------------------------------------------------------
export const quotaPolicy = sqliteTable('quota_policy', {
  ssoUsername: text('sso_username').primaryKey(),
  /** `null` = inherit global default. `0` = unlimited. Never conflate the two. */
  quotaBytes: integer('quota_bytes'),
  /** `default` / `override`. */
  source: text('source', { enum: ['default', 'override'] })
    .notNull()
    .default('default'),
  /** Free text the operator can leave, shown in admin UI. */
  note: text('note'),
  /** Unix seconds. */
  updatedAt: integer('updated_at').notNull(),
  /** `sso_username` of whoever set it. */
  updatedBy: text('updated_by').notNull(),
});

// ---------------------------------------------------------------------------
// app_setting — operator-editable runtime settings, key/value (wiki/Data-Model.md §app_setting)
// ---------------------------------------------------------------------------
export const appSetting = sqliteTable('app_setting', {
  /** `default_quota_bytes` / `enforcement_enabled` / `delete_recent_play_days` / `grace_bytes` / `stale_snapshot_max_age_s` / `delete_max_per_hour` / `hold_max_days` / `notify_cooldown_s`. Full list + defaults in wiki/Configuration.md. */
  key: text('key').primaryKey(),
  /** JSON-encoded value. */
  value: text('value').notNull(),
  /** Unix seconds. */
  updatedAt: integer('updated_at').notNull(),
  updatedBy: text('updated_by').notNull(),
});

// ---------------------------------------------------------------------------
// title — a synced projection of one library item from Radarr/Sonarr (wiki/Data-Model.md §title)
// ---------------------------------------------------------------------------
export const title = sqliteTable('title', {
  /** `movie:{radarrId}` / `series:{sonarrId}`. */
  id: text('id').primaryKey(),
  mediaType: text('media_type', { enum: ['movie', 'tv'] }).notNull(),
  /** `radarr` / `radarr-4k` / `sonarr` / `sonarr-4k` — distinguishes intent, not host; both Radarr slots point at the same physical Radarr (see the "4K caveat" note in wiki/Data-Model.md). */
  arrInstance: text('arr_instance', { enum: ['radarr', 'radarr-4k', 'sonarr', 'sonarr-4k'] }).notNull(),
  /** The id to call DELETE with. */
  arrId: integer('arr_id').notNull(),
  /** Join key to Seerr `media.tmdbId`. */
  tmdbId: integer('tmdb_id'),
  /** Join key for TV. */
  tvdbId: integer('tvdb_id'),
  title: text('title').notNull(),
  year: integer('year'),
  /** `sizeOnDisk` (movie) / `statistics.sizeOnDisk` (series). */
  sizeBytes: integer('size_bytes').notNull(),
  /** For the confirm screen — show people the real path. */
  path: text('path').notNull(),
  /** Radarr/Sonarr `added`. Unix seconds. */
  addedAt: integer('added_at'),
  /** Operator pin; blocks member deletion (`D-6`). */
  protected: integer('protected', { mode: 'boolean' }).notNull().default(false),
  protectedReason: text('protected_reason'),
  /**
   * Derived, denormalised convenience computed from `playback` (see
   * wiki/Data-Model.md §playback: "Plus a derived, denormalised convenience
   * on `title`"). TV counts as played if ANY episode has been played
   * (`FR-ACCT-6`). Not written by this scaffold (no reconciler yet).
   */
  watchedByAnyone: integer('watched_by_anyone', { mode: 'boolean' }).notNull().default(false),
  /** Unix seconds; null if never played. */
  lastPlayedAnyAt: integer('last_played_any_at'),
  /**
   * P4-1 Wave 1 (additive, gated off by default). `true` once this
   * whole-series row has been explicitly split by the operator into
   * per-season `series:{sonarrId}:s{n}` rows (a later wave's action — no
   * trigger exists yet). Default `false` for every title today, movies
   * included (the flag is only ever meaningful for `media_type: 'tv'`).
   * Once split, the whole-series row is never deleted — only excluded from
   * new attribution and fleet distinct-byte totals, a rule enforced
   * elsewhere, not by this column alone. See `wiki/Data-Model.md` §title.
   */
  splitIntoSeasons: integer('split_into_seasons', { mode: 'boolean' }).notNull().default(false),
  /** Unix seconds. Titles that vanish upstream are marked stale here and excluded from usage, never deleted — keeps audit foreign references resolvable. */
  lastSyncedAt: integer('last_synced_at').notNull(),
});

// ---------------------------------------------------------------------------
// claim — who is responsible for which bytes (wiki/Data-Model.md §claim)
//
// `D-3` was REVERSED after an early spike
// (wiki/Architecture.md §D-3): the even-split model (`share_num`/`share_den`/
// `share_bytes`) is gone. Real-world data showed co-requested titles were
// rare, and the split was exploitable by collusion (spread one big
// request across friends to shrink everyone's charge). Every active
// requester is now charged the title's FULL `size_bytes` — no division.
// Per-member usage therefore OVERLAPS and must not be summed for a fleet
// total (wiki/Data-Model.md: "Fleet totals go over distinct `title_id`",
// `FR-ACCT-3`); that aggregation lives with the (not-yet-built) accounting
// engine, not this schema.
// ---------------------------------------------------------------------------
export const claim = sqliteTable(
  'claim',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    titleId: text('title_id')
      .notNull()
      .references(() => title.id),
    ssoUsername: text('sso_username')
      .notNull()
      .references(() => member.ssoUsername),
    /** The request that created it; null for operator-assigned. */
    seerrRequestId: integer('seerr_request_id'),
    /** The title's FULL `size_bytes` at last reconcile — claims are no longer divided (`D-3`, revised). */
    chargedBytes: integer('charged_bytes').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    /** Unix seconds. */
    createdAt: integer('created_at').notNull(),
    /** Unix seconds; set when a member releases their claim. */
    releasedAt: integer('released_at'),
    releasedBy: text('released_by'),
  },
  (t) => ({
    ssoActiveIdx: index('claim_sso_active_idx').on(t.ssoUsername, t.active),
    titleActiveIdx: index('claim_title_active_idx').on(t.titleId, t.active),
    /**
     * `FR-DEL-20`: at most one ACTIVE claim per (title, member). Without
     * this, a duplicate active row for the same pair makes
     * `deletionStore.ts`'s claimant count diverge from the number of
     * DISTINCT members actually holding a claim, turning a sole claimant
     * into an apparent co-claimant and handing them the release `FR-DEL-2`
     * forbids. Partial (`WHERE active = 1`), not a flat 3-column unique
     * constraint — historical released (`active = 0`) rows for the same
     * pair are expected and legitimate (release, then re-claim later);
     * only the ACTIVE row needs to be unique.
     */
    activeUniqueIdx: uniqueIndex('claim_title_sso_active_unique').on(t.titleId, t.ssoUsername).where(sql`${t.active} = 1`),
  }),
);

// ---------------------------------------------------------------------------
// playback (wiki/Data-Model.md §playback)
// ---------------------------------------------------------------------------
export const playback = sqliteTable(
  'playback',
  {
    titleId: text('title_id')
      .notNull()
      .references(() => title.id),
    /** Normalised (no dashes, lowercase), matching `member.jellyfin_user_id`. */
    jellyfinUserId: text('jellyfin_user_id').notNull(),
    playCount: integer('play_count').notNull().default(0),
    /**
     * Jellyfin's `Played` flag — finished, as opposed to merely started
     * (`FR-ACCT-6`, `wiki/Data-Model.md` §playback). For a `tv` title this is
     * an aggregate across the user's episodes: `true` if ANY episode has been
     * played, matching the same rule already used for the denormalised
     * `title.watched_by_anyone` column.
     */
    played: integer('played', { mode: 'boolean' }).notNull().default(false),
    /**
     * Jellyfin's `PlaybackPositionTicks`. `> 0` with `played = 0` means
     * **unfinished** — the signal `FR-DEL-4`'s `in_progress` guard turns on.
     * For a `tv` title this is the MAX across the user's episodes (the
     * furthest-progressed one) — informational; the `in_progress` guard for
     * TV keys on `episodes_played`/`episodes_total` below, not this column.
     */
    positionTicks: integer('position_ticks').notNull().default(0),
    /** TV only; `null` for a movie. How many of this series' episodes this user has played at least once (`FR-ACCT-6`). */
    episodesPlayed: integer('episodes_played'),
    /** TV only; `null` for a movie. Total episode count for the series at last sync — same value for every user of a given title. */
    episodesTotal: integer('episodes_total'),
    /** Unix seconds. */
    lastPlayedAt: integer('last_played_at'),
    /** Unix seconds. */
    lastSyncedAt: integer('last_synced_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.titleId, t.jellyfinUserId] }),
  }),
);

// ---------------------------------------------------------------------------
// request_decision — one row per enforcement verdict (wiki/Data-Model.md §request_decision)
//
// `D-4a` (wiki/Feature-05-Enforcement.md, added after an early spike):
// Seerr's approve/decline API takes no body and carries no reason field, so
// an over-quota request is no longer declined — it's HELD (left pending,
// zero Seerr writes) and this app notifies the member itself. `decline` now
// only happens via operator action or `HOLD_MAX_DAYS` age-out
// (`FR-ENF-11`/`FR-ENF-12`), never as the direct over-quota outcome.
// ---------------------------------------------------------------------------
export const requestDecision = sqliteTable('request_decision', {
  /** Also the idempotency key — the poller must not re-decide something the webhook already handled. */
  seerrRequestId: integer('seerr_request_id').primaryKey(),
  ssoUsername: text('sso_username').notNull(),
  /** `hold` is the normal over-quota outcome; `decline` only via operator action or hold age-out (`D-4a`). */
  decision: text('decision', { enum: ['approve', 'hold', 'decline', 'skip'] }).notNull(),
  /**
   * Machine-readable, and always the TRUE reason for the verdict — never
   * overwritten to record that enforcement was off. That fact lives in
   * `enforced` below, so the operator's shadow-mode preview can say
   * "would have held (over quota)" rather than just "would have held".
   */
  reason: text('reason', {
    enum: [
      'under_quota',
      'over_quota',
      'operator_exempt',
      'hold_expired',
      // --- skip reasons: distinct because the operator's attention panel has
      // to act differently on each. Collapsing them into `unknown_member`
      // loses the difference between "not linked yet" and "you never set a
      // default quota", which need completely different responses.
      'stale_snapshot',
      'unknown_member', // no member row at all
      'member_not_matched', // ambiguous / no_seerr_account / not_entitled
      'quota_unconfigured', // FR-POL-2a: an absence, NOT unlimited
      'usage_unavailable', // attribution could not compute a figure
    ],
  }).notNull(),
  /**
   * False when `enforcement_enabled` was off at decision time — i.e. this row
   * is a shadow verdict and no Seerr call was made (`FR-ENF-5`).
   */
  enforced: integer('enforced', { mode: 'boolean' }).notNull().default(true),
  /**
   * Snapshot of the inputs, so a past verdict stays explainable.
   * Both are NULLABLE: a `quota_unconfigured` skip has no quota to record and
   * a `usage_unavailable` skip has no usage. Writing 0 for either would be a
   * lie of exactly the kind FR-POL-2a warns about (absence != zero).
   */
  usageBytes: integer('usage_bytes'),
  quotaBytes: integer('quota_bytes'),
  source: text('source', { enum: ['webhook', 'poller', 'manual'] }).notNull(),
  /** HTTP status Seerr returned. Null for `hold`/`skip` — neither makes a Seerr call. */
  seerrStatus: integer('seerr_status'),
  /** Unix seconds; when the hold started. Drives `HOLD_MAX_DAYS` age-out (`FR-ENF-12`). Null for non-`hold` decisions. */
  heldSince: integer('held_since'),
  /** Unix seconds; when the member was told about this decision (`FR-ENF-15`). Null until a notification is actually sent. */
  notifiedAt: integer('notified_at'),
  /** Unix seconds. */
  decidedAt: integer('decided_at').notNull(),
});

// ---------------------------------------------------------------------------
// deletion (wiki/Data-Model.md §deletion)
// ---------------------------------------------------------------------------
export const deletion = sqliteTable('deletion', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** Who acted. */
  ssoUsername: text('sso_username').notNull(),
  titleId: text('title_id')
    .notNull()
    .references(() => title.id),
  mode: text('mode', { enum: ['delete_files', 'release_claim'] }).notNull(),
  /**
   * `scheduled` is the state a member-initiated file deletion now STARTS in
   * (`D-7`, `FR-DEL-22`): the human has clicked through all three steps, but
   * the destructive call does not happen until `scheduled_for`. From there a
   * row goes to `done` (the sweeper ran it), `cancelled` (someone undid it,
   * or an execution-time guard fired — `FR-DEL-26`), or `failed`.
   *
   * `release_claim` rows never enter `scheduled` — releasing a claim destroys
   * nothing and is re-claimable by the next reconcile, so it still executes
   * immediately and lands straight in `done` (`FR-DEL-23`).
   *
   * Drizzle enums are a TS-level constraint only — the generated SQLite
   * column is plain `text`, so adding `scheduled`/`cancelled` needed no
   * migration of its own (the new COLUMNS below did).
   */
  state: text('state', { enum: ['requested', 'scheduled', 'executing', 'done', 'failed', 'blocked', 'cancelled'] }).notNull(),
  /** Their share at the time. */
  bytesClaimed: integer('bytes_claimed').notNull(),
  /** Actual, post-execution. */
  bytesFreed: integer('bytes_freed'),
  /** The exact URL+method issued. */
  arrCall: text('arr_call'),
  arrStatus: integer('arr_status'),
  error: text('error'),
  /** Unix seconds. */
  requestedAt: integer('requested_at').notNull(),
  /**
   * Unix seconds; when the sweeper becomes allowed to execute this deletion
   * (`requested_at + DELETE_GRACE_PERIOD`). Null for rows that were never
   * scheduled — every `release_claim` row, every `blocked` row, and every
   * `delete_files` row written before this column existed.
   */
  scheduledFor: integer('scheduled_for'),
  /** Unix seconds; set when the row moved to `cancelled`. */
  cancelledAt: integer('cancelled_at'),
  /**
   * Who cancelled: an `sso_username`, or `system` when an execution-time
   * guard cancelled it rather than a person (`FR-DEL-26`).
   */
  cancelledBy: text('cancelled_by'),
  /** Why it was cancelled — a short machine-readable token, not prose. */
  cancelReason: text('cancel_reason'),
  /** Unix seconds; null until the delete has actually run. */
  executedAt: integer('executed_at'),
}, (t) => ({
  /** The sweeper's only query: `state = 'scheduled' AND scheduled_for <= now`. */
  scheduledForIdx: index('deletion_state_scheduled_for_idx').on(t.state, t.scheduledFor),
  /** Per-member pending-bytes lookup, on the member dashboard's hot path. */
  ssoStateIdx: index('deletion_sso_state_idx').on(t.ssoUsername, t.state),
}));

// ---------------------------------------------------------------------------
// sync_run (wiki/Data-Model.md §sync_run)
// ---------------------------------------------------------------------------
export const syncRun = sqliteTable('sync_run', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** Unix seconds. */
  startedAt: integer('started_at').notNull(),
  /** Unix seconds; null while the run is still in progress. */
  finishedAt: integer('finished_at'),
  /** JSON: per-step `{ok, count, ms, error}` for the six reconciler steps. */
  steps: text('steps').notNull().default('{}'),
  ok: integer('ok', { mode: 'boolean' }),
});

// ---------------------------------------------------------------------------
// audit — append-only. No `UPDATE`, no `DELETE`, no retention job.
// (wiki/Data-Model.md §audit; the writer is a later backlog item, P1-7 — this
// task ships the schema only, per this task's instructions.)
// ---------------------------------------------------------------------------
export const audit = sqliteTable(
  'audit',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Unix MILLISECONDS — the one table in this schema that isn't seconds. */
    ts: integer('ts').notNull(),
    /** `sso_username`, or `system` for reconciler/webhook actions. */
    actor: text('actor').notNull(),
    actorRole: text('actor_role', { enum: ['member', 'operator', 'system'] }).notNull(),
    /** Set when an operator acts on a member's data. */
    onBehalfOf: text('on_behalf_of'),
    /** See the action vocabulary in wiki/Feature-08-Audit-Log.md. */
    action: text('action').notNull(),
    targetType: text('target_type', {
    // `route` exists for `access.denied`, whose target is an attempted URL rather
    // than a domain object. Drizzle enums are a TS-level constraint only — the
    // generated SQLite column is plain `text`, so adding a value needs no migration.
    enum: ['member', 'title', 'request', 'setting', 'route'],
  }),
    targetId: text('target_id'),
    /** JSON. */
    before: text('before'),
    /** JSON. */
    after: text('after'),
    outcome: text('outcome', { enum: ['ok', 'denied', 'error'] }).notNull(),
    /** JSON: reason, upstream response, error message. */
    detail: text('detail'),
    source: text('source', { enum: ['ui', 'webhook', 'poller', 'cron', 'cli'] }).notNull(),
    /** Groups the rows of one multi-step operation. */
    correlationId: text('correlation_id').notNull(),
  },
  (t) => ({
    tsIdx: index('audit_ts_idx').on(t.ts),
    actorIdx: index('audit_actor_idx').on(t.actor),
    actionIdx: index('audit_action_idx').on(t.action),
    targetIdIdx: index('audit_target_id_idx').on(t.targetId),
    correlationIdIdx: index('audit_correlation_id_idx').on(t.correlationId),
  }),
);

// Re-exported so drizzle-kit (drizzle.config.ts) and getDb()'s schema param
// see every table from this one module.
export const schema = {
  member,
  quotaPolicy,
  appSetting,
  title,
  claim,
  playback,
  requestDecision,
  deletion,
  syncRun,
  audit,
};
