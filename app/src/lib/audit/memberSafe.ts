/**
 * `FR-AUD-10`'s "the careful part": turning one raw `audit` row into what a
 * MEMBER is allowed to see of it. Added here (not under
 * `src/components/member/**`) because this is fundamentally the same kind of
 * problem `./redact.ts` already solves for a different audience — "what in
 * this row is safe to show WHO" — and belongs next to it as an audit-log
 * concern, not a UI concern. Reported in the project notes per its
 * constraint that `src/lib/audit/**` is otherwise off-limits except for a
 * read helper that "genuinely belongs" here; this one is pure (no I/O), so
 * it's closer to `./redact.ts` than to `./browse.ts`'s DB reads, but both
 * live in this module for the same reason.
 *
 * ## Why this exists — `FR-DEL-4a` collides with `FR-AUD-10`
 *
 * `src/lib/deletion/guards.ts`'s guard set carries TWO parallel detail
 * shapes per fired guard: `memberMessage`/`memberDetail` (safe for a member
 * to read) and `operatorMessage`/`operatorDetail` (may name who else was
 * watching). `src/lib/deletion/execute.ts`'s `delete.blocked` audit row
 * stores ONLY the operator-facing half (`guards: [...].map(g => ({ guardId,
 * operatorMessage, operatorDetail }))`) — correct for an audit log that
 * `execute.ts`'s own header comment calls "an operator-facing forensic
 * tool, not a surface a member reads." `FR-AUD-10` now makes it exactly
 * that for the row's OWNER, and `delete.blocked`'s `operatorDetail.playedBy`
 * is a literal array of other members' usernames — the review found this
 * mid-build. A member's own `delete.blocked` row (`actor` or `on_behalf_of`
 * matches them) is about a title THEY tried to delete, but its `detail`
 * blob can still name a DIFFERENT member (whoever's recent playback fired
 * the guard). Filtering "everything except the bad parts" is exactly the
 * shape that goes wrong when a new field is added later and nobody
 * remembers to blocklist it.
 *
 * ## The allow-list, with defense in depth
 *
 * `memberSafeDetail` below is DENY-BY-DEFAULT twice over, independently:
 *
 *   1. **Key allow-list.** Only the exact top-level key names listed for a
 *      given `action` in `ACTION_FIELD_ALLOWLIST` are ever read from
 *      `before`/`after`/`detail`. An action with no entry (every system-actor
 *      action — `member.*`, `request.*`, `webhook.rejected`, `sync.failed`,
 *      `invariant.violated` — plus deliberately-omitted operator-only
 *      actions like `title.protected`/`claim.reassigned`) yields no fields
 *      at all, not "whatever happens to look safe."
 *   2. **Scalar-only value guard.** Even a listed key is dropped unless its
 *      value is a JSON scalar (`string | number | boolean | null`) — never
 *      an array or nested object. This is what stops a FUTURE change from
 *      leaking silently: e.g. `setting.changed`'s default-quota-change
 *      variant (`src/lib/quota/policy.ts`) stores `detail.newlyOver`/
 *      `newlyUnder` — arrays of OTHER members' usernames — on a row whose
 *      `actor` is the OPERATOR. If the operator ever views their OWN
 *      `/history`, that row is in scope by the same `actor = me` rule a
 *      plain member's rows use; `newlyOver`/`newlyUnder` are not on
 *      `setting.changed`'s allow-list, and even if they were, they'd still
 *      be dropped here for not being scalars. Proven directly in
 *      `test/audit-member-safe.test.ts`.
 *
 * `protectedReason` (operator free text on `delete.blocked`'s `protected`
 * branch) and any raw upstream error message/name (`delete.failed`) are
 * deliberately NOT allow-listed anywhere, even though both happen to be
 * strings today — free text an operator typed, or text echoed back from
 * Radarr/Sonarr/Seerr, is unpredictable by construction and cannot be proven
 * never to mention another member. Sparse-but-safe beats rich-but-leaky.
 */

export type JsonScalar = string | number | boolean | null;

function asScalar(value: unknown): JsonScalar | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return undefined; // arrays/objects/undefined — never passed through, even if the key was allow-listed.
}

/** Parses a `before`/`after`/`detail` TEXT column (or `null`) back into an object to pick from. Never throws — a malformed/non-object blob yields `{}` (no fields), matching this codebase's other DISPLAY-code parse tolerance (e.g. `@/components/admin/logic`'s `parseSteps`). */
function parseBlobObject(raw: string | null): Record<string, unknown> {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

function pickAllowed(obj: Record<string, unknown>, keys: readonly string[]): Record<string, JsonScalar> {
  const out: Record<string, JsonScalar> = {};
  for (const key of keys) {
    const scalar = asScalar(obj[key]);
    if (scalar !== undefined) out[key] = scalar;
  }
  return out;
}

/**
 * Per-action allow-lists, keyed by which blob the field comes from. Only
 * actions actually reachable under `./browse.ts`'s `ownAuditWhere` (actor OR
 * on_behalf_of = the viewing member) are listed with non-empty entries;
 * every other action falls through to the `default` case (no fields) below
 * — see this file's header comment for exactly why that's the safe default,
 * not an oversight.
 */
const ACTION_FIELD_ALLOWLIST: Record<string, { before?: readonly string[]; after?: readonly string[]; detail?: readonly string[] }> = {
  'access.denied': { detail: ['attemptedRoute', 'reason'] },
  'delete.requested': { detail: ['requestedMode', 'path', 'sizeBytes', 'downgradedTo', 'reason'] },
  'delete.executed': { detail: ['bytesFreed', 'alreadyGone'] },
  // Deliberately excludes the raw upstream error (`name`/`message`) and any
  // `arrCall`/`seerrCall` URL — see this file's header comment.
  'delete.failed': { detail: ['stage'] },
  // Deliberately excludes `protectedReason` (operator free text) and
  // `guards` (an array — would be dropped by the scalar guard regardless,
  // but excluded from the allow-list too, belt and suspenders) — this is
  // the exact field this task's leak scenario is about.
  'delete.blocked': { detail: ['reason'] },
  'claim.released': { before: ['chargedBytes'], detail: ['downgradedFromDelete', 'remainingActiveClaimants'] },
  // `quota.set`/`quota.cleared` can only appear under an OPERATOR's own
  // `actor = me` scope (never `on_behalf_of`, per `src/lib/quota/policy.ts`)
  // — `note` is operator free text, deliberately excluded for the same
  // reason as `protectedReason` above.
  'quota.set': { after: ['quotaBytes', 'source'] },
  'quota.cleared': {},
  // `setting.changed` covers TWO different detail shapes from two different
  // callers (see this file's header comment) — only the plain-setting
  // shape's `value` is allow-listed; the default-quota-change shape's
  // `newlyOver`/`newlyUnder` are not listed AND would fail the scalar guard.
  'setting.changed': { before: ['value'], after: ['value'] },
  'enforcement.toggled': { before: ['enabled'], after: ['enabled'] },
};

export interface MemberSafeAuditRow {
  id: number;
  /** Unix ms. */
  ts: number;
  action: string;
  outcome: 'ok' | 'denied' | 'error';
  targetType: string | null;
  targetId: string | null;
  actorRole: 'member' | 'operator' | 'system';
  /** True when this row is an OPERATOR's action taken on the viewing member's behalf (`audit.on_behalf_of` — only ever set by an operator, per `src/lib/deletion/execute.ts`), rather than something the member did themselves. Naming the operator is not the leak this module guards against (`FR-DEL-4a` is about OTHER MEMBERS' identities, not the operator's). */
  byOperator: boolean;
  /**
   * Allow-listed, scalar-only fields from `before`/`after`/`detail` — see
   * this file's header comment. Kept as three SEPARATE namespaces (not
   * merged into one flat object) because several actions allow-list the
   * SAME key name from both `before` and `after` (e.g. `setting.changed`'s
   * `value`) — merging would silently let `after` clobber `before`. Any
   * blob with no allow-list entry for this row's action is `{}`.
   */
  before: Record<string, JsonScalar>;
  after: Record<string, JsonScalar>;
  detail: Record<string, JsonScalar>;
}

/** Input shape this module needs from a raw audit row — deliberately narrower than `./browse.ts`'s `RawAuditRow` so this stays independent of the DB row type. */
export interface AuditRowLike {
  id: number;
  ts: number;
  actor: string;
  actorRole: 'member' | 'operator' | 'system';
  onBehalfOf: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  before: string | null;
  after: string | null;
  outcome: 'ok' | 'denied' | 'error';
  detail: string | null;
  source: string;
}

/**
 * Builds the member-safe view of one row. `viewerUsername` is the member
 * whose `/history` this is — used only to compute `byOperator` (whether the
 * row is `on_behalf_of` them rather than something they did themselves), NOT
 * to re-check scope: callers MUST already have selected only rows where
 * `actor = viewerUsername OR on_behalf_of = viewerUsername`
 * (`./browse.ts`'s `ownAuditWhere`) before calling this — this function does
 * not re-filter by actor/on_behalf_of itself, only by FIELD content.
 */
export function toMemberSafeAuditRow(row: AuditRowLike, viewerUsername: string): MemberSafeAuditRow {
  const allow = ACTION_FIELD_ALLOWLIST[row.action] ?? {};
  const before = allow.before ? pickAllowed(parseBlobObject(row.before), allow.before) : {};
  const after = allow.after ? pickAllowed(parseBlobObject(row.after), allow.after) : {};
  const detail = allow.detail ? pickAllowed(parseBlobObject(row.detail), allow.detail) : {};

  return {
    id: row.id,
    ts: row.ts,
    action: row.action,
    outcome: row.outcome,
    targetType: row.targetType,
    targetId: row.targetId,
    actorRole: row.actorRole,
    byOperator: row.onBehalfOf !== null && row.onBehalfOf === viewerUsername,
    before,
    after,
    detail,
  };
}
