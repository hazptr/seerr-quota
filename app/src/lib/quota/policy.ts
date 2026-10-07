/**
 * Quota policy CRUD — the impure shell (AGENTS.md rule 9) behind
 * `./preview.ts`'s pure functions. `FR-POL-1`/`FR-POL-2`: read/set/clear the
 * global `default_quota_bytes` (`app_setting`) and per-member overrides
 * (`quota_policy`). `FR-POL-3`: every write goes through `withAudit`
 * (`src/lib/audit`) so a change can never commit without its audit row.
 * `FR-POL-6`: read access is gated IN this module, not left to callers.
 *
 * ## Inheritance is resolved at READ time, never materialised
 *
 * `wiki/Data-Model.md` §`quota_policy`'s inheritance table is the authority.
 * `quota_policy.quota_bytes` is `null` for every member with no override —
 * FOREVER, until an operator sets one — and is NOT a live snapshot of
 * whatever the default happened to be when the row was created or last
 * touched. Every reader in this codebase (this module,
 * `src/lib/enforcement/process.ts`, `src/lib/quotaStatus/load.ts`,
 * `src/app/_data/memberDashboard.ts`, `src/app/admin/_data/**`) resolves the
 * effective quota by calling `resolveEffectiveQuota(overrideBytes,
 * defaultBytes)` (`src/lib/members/quota.ts`) with the STORED override AND
 * the CURRENT `default_quota_bytes` (`getGlobalDefaultQuotaBytes` below),
 * fetched fresh on every call.
 *
 * This is what makes the acceptance criterion true with NO fan-out write:
 *   - `setGlobalDefaultQuota` writes ONLY `app_setting.default_quota_bytes`.
 *     It does NOT touch `quota_policy` at all — every `source: 'default'`
 *     member's effective quota rises/falls on their very next read, because
 *     their row's `quota_bytes` was `null` all along and always resolves
 *     against the live default.
 *   - `clearMemberOverride` writes a bare `null` (not a resolved value) with
 *     `source: 'default'` — "inherits default (X GB)" is what
 *     `resolveEffectiveQuota(null, <current default>)` produces on the very
 *     next read, not a frozen copy taken at clear time. If the global
 *     default is itself unset, that resolves to the correct `FR-POL-2a`
 *     "unconfigured" state, not a bug.
 *
 * `source` still records WHY a row holds its value (an operator's explicit
 * number vs. "inherits whatever the default currently is"), for UI/audit
 * purposes — it is never itself read by `resolveEffectiveQuota`.
 *
 * Deliberately NOT built here: `enforcement_enabled` (`FR-POL-7`) and a
 * general `grace_bytes` setter (`FR-POL-8`) — both are read here (for
 * validation against a proposed default) but never written by this module.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { SeerrQuotaDb } from '@/lib/db';
import { withAudit } from '@/lib/audit';
import { getConfig } from '@/lib/config';
import { appSetting, claim, quotaPolicy } from '@/lib/db/schema';
import { resolveEffectiveQuota, type EffectiveQuota } from '@/lib/members/quota';
import { resolveNumericRuntimeSetting } from '@/components/member/logic';
import {
  previewClearOverride,
  previewDefaultChange,
  previewOverrideChange,
  type DefaultChangePreview,
  type DefaultChangePreviewMember,
  type MemberQuotaChangePreview,
} from './preview';
import { checkFreeSpaceWarning, readBulkDriveFreeBytes, validateGraceBytes, validateQuotaBytes } from './validation';

// ---------------------------------------------------------------------------
// Reads shared by the rest of this module — small, DB-touching helpers kept
// private so every public function goes through the same query shape.
// ---------------------------------------------------------------------------

/** JSON-parses one numeric `app_setting` row, `null` when the row is absent/unparseable/non-numeric — the same shape `src/lib/members/sync.ts`'s private `resolveDefaultQuotaBytes` uses, re-derived here because that function isn't exported. */
function readNullableNumericSetting(db: SeerrQuotaDb, key: string): number | null {
  const row = db.select().from(appSetting).where(eq(appSetting.key, key)).get();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value);
    return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** `app_setting.default_quota_bytes`, falling back to the `DEFAULT_QUOTA_BYTES` config seed (`wiki/Configuration.md`'s documented DB-wins-over-config precedence) — `null` when NEITHER is set (`FR-POL-2`: an absence, never coerced to `0`). */
export function getGlobalDefaultQuotaBytes(db: SeerrQuotaDb): number | null {
  const dbValue = readNullableNumericSetting(db, 'default_quota_bytes');
  if (dbValue !== null) return dbValue;
  const seeded = getConfig().runtime.defaultQuotaBytes;
  return typeof seeded === 'number' ? seeded : null;
}

/** `app_setting.grace_bytes`, falling back to the `GRACE_BYTES` config seed. Reuses `src/components/member/logic.ts`'s `resolveNumericRuntimeSetting` (already built for exactly this DB-row-or-config-fallback shape, for a different key) rather than re-deriving it a third time. */
export function getGraceBytes(db: SeerrQuotaDb): number {
  const row = db.select().from(appSetting).where(eq(appSetting.key, 'grace_bytes')).get();
  return resolveNumericRuntimeSetting(row, getConfig().runtime.graceBytes);
}

/** `SUM(claim.charged_bytes) WHERE sso_username = ? AND active = 1` — the same query `src/app/_data/memberDashboard.ts` uses for a single member's usage (`wiki/Data-Model.md` §claim). `0` when the member has no active claims (never `null` — an absence of claims is a real, known usage of zero, not an unknown). */
function loadMemberUsageBytes(db: SeerrQuotaDb, ssoUsername: string): number {
  const row = db
    .select({ total: sql<number>`coalesce(sum(${claim.chargedBytes}), 0)` })
    .from(claim)
    .where(and(eq(claim.ssoUsername, ssoUsername), eq(claim.active, true)))
    .get();
  return Number(row?.total ?? 0);
}

/** Every member's usage in one query — used by the fleet-wide default-change preview so it doesn't run N+1 queries. `active` claims only, per member (`FR-ACCT` — usage overlaps across members by design, see `wiki/Data-Model.md` §claim's "MUST NOT be summed" fleet-total warning; this is per-member, not a fleet total). */
function loadAllMemberUsageBytes(db: SeerrQuotaDb): Map<string, number> {
  const rows = db
    .select({ ssoUsername: claim.ssoUsername, total: sql<number>`coalesce(sum(${claim.chargedBytes}), 0)` })
    .from(claim)
    .where(eq(claim.active, true))
    .groupBy(claim.ssoUsername)
    .all();
  return new Map(rows.map((r) => [r.ssoUsername, Number(r.total)]));
}

interface QuotaPolicyRow {
  ssoUsername: string;
  quotaBytes: number | null;
  source: 'default' | 'override';
  note: string | null;
  updatedAt: number;
  updatedBy: string;
}

function loadQuotaPolicyRow(db: SeerrQuotaDb, ssoUsername: string): QuotaPolicyRow | undefined {
  return db.select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, ssoUsername)).get();
}

function loadAllQuotaPolicyRows(db: SeerrQuotaDb): QuotaPolicyRow[] {
  return db.select().from(quotaPolicy).all();
}

function freeSpaceWarning(proposedBytes: number, freeBytesOverride?: number): string | undefined {
  const freeBytes = freeBytesOverride ?? readBulkDriveFreeBytes(getConfig().paths.mediaFreeSpacePath);
  return checkFreeSpaceWarning(proposedBytes, freeBytes).message;
}

// ---------------------------------------------------------------------------
// FR-POL-4 (read-only): preview panels the admin UI calls BEFORE committing.
// No writes, no audit rows — see `./preview.ts` for the pure computation.
// ---------------------------------------------------------------------------

/** Fleet-wide preview of a proposed global default — `FR-POL-4`. Read-only: no write, no audit row. */
export function previewGlobalDefaultChange(db: SeerrQuotaDb, proposedDefaultBytes: number, graceBytesOverride?: number): DefaultChangePreview {
  const usageByMember = loadAllMemberUsageBytes(db);
  const rows = loadAllQuotaPolicyRows(db);
  const graceBytes = graceBytesOverride ?? getGraceBytes(db);
  const currentDefault = getGlobalDefaultQuotaBytes(db);

  const members: DefaultChangePreviewMember[] = rows.map((r) => ({
    ssoUsername: r.ssoUsername,
    usageBytes: usageByMember.get(r.ssoUsername) ?? 0,
    currentEffective: resolveEffectiveQuota(r.quotaBytes, currentDefault),
    source: r.source,
  }));

  return previewDefaultChange(members, proposedDefaultBytes, graceBytes);
}

/** Single-member preview of a proposed override — `FR-POL-4`/`FR-POL-5`. Read-only. `undefined` if the member has no `quota_policy` row at all (shouldn't happen for a synced member — `src/lib/members/sync.ts` seeds one — but this module doesn't assume it). */
export function previewMemberOverrideChange(
  db: SeerrQuotaDb,
  ssoUsername: string,
  proposedOverrideBytes: number,
  graceBytesOverride?: number,
): MemberQuotaChangePreview | undefined {
  const row = loadQuotaPolicyRow(db, ssoUsername);
  if (!row) return undefined;
  const usageBytes = loadMemberUsageBytes(db, ssoUsername);
  const graceBytes = graceBytesOverride ?? getGraceBytes(db);
  return previewOverrideChange({
    ssoUsername,
    usageBytes,
    currentEffective: resolveEffectiveQuota(row.quotaBytes, getGlobalDefaultQuotaBytes(db)),
    proposedOverrideBytes,
    graceBytes,
  });
}

/** Preview of clearing a member's override (reverting to whatever the current default resolves to). Read-only. */
export function previewMemberClearOverride(db: SeerrQuotaDb, ssoUsername: string, graceBytesOverride?: number): MemberQuotaChangePreview | undefined {
  const row = loadQuotaPolicyRow(db, ssoUsername);
  if (!row) return undefined;
  const usageBytes = loadMemberUsageBytes(db, ssoUsername);
  const graceBytes = graceBytesOverride ?? getGraceBytes(db);
  const currentDefault = getGlobalDefaultQuotaBytes(db);
  return previewClearOverride({
    ssoUsername,
    usageBytes,
    currentEffective: resolveEffectiveQuota(row.quotaBytes, currentDefault),
    currentDefaultQuotaBytes: currentDefault,
    graceBytes,
  });
}

// ---------------------------------------------------------------------------
// Writes — FR-POL-1/2/3/9. Every one goes through `withAudit`.
// ---------------------------------------------------------------------------

export type PolicyWriteOutcome<T> = { kind: 'ok'; result: T; warning?: string } | { kind: 'invalid'; reason: string };

export interface SetGlobalDefaultInput {
  proposedBytes: number;
  /** `sso_username` of the operator making the change — `audit.actor`/`quota_policy.updated_by`. */
  actor: string;
  note?: string;
  /** Test seam for `FR-POL-9`'s free-space warning — see `./validation.ts`'s `readBulkDriveFreeBytes`. */
  freeBytesOverride?: number;
  graceBytesOverride?: number;
}

export interface SetGlobalDefaultResult {
  before: number | null;
  after: number;
  preview: DefaultChangePreview;
}

/**
 * `FR-POL-1`/`FR-POL-2a`: sets `app_setting.default_quota_bytes` — and
 * ONLY that. No `quota_policy` row is touched: every `source: 'default'`
 * member's row already stores `null` and always will, so their effective
 * quota rises/falls on their very next read with no fan-out write and
 * nothing to drift out of sync (see this file's header comment). One audit
 * row (`setting.changed`, target `default_quota_bytes`) carries the
 * before/after default plus a summary of who is newly over/under (computed
 * from the SAME preview a caller would show before committing) in `detail`
 * — not one row per affected member, to avoid an audit-log spike
 * proportional to fleet size for what is, semantically, a single decision.
 */
export function setGlobalDefaultQuota(db: SeerrQuotaDb, input: SetGlobalDefaultInput): PolicyWriteOutcome<SetGlobalDefaultResult> {
  const quotaCheck = validateQuotaBytes(input.proposedBytes, 'default_quota_bytes');
  if (!quotaCheck.valid) return { kind: 'invalid', reason: quotaCheck.reason };

  const graceBytes = input.graceBytesOverride ?? getGraceBytes(db);
  const graceCheck = validateGraceBytes(graceBytes, input.proposedBytes);
  if (!graceCheck.valid) return { kind: 'invalid', reason: graceCheck.reason };

  const before = getGlobalDefaultQuotaBytes(db);
  // Computed BEFORE the transaction — same pattern as the rest of this
  // module (reads happen on the plain `db` handle before `withAudit`, writes
  // happen on `tx` inside it). Purely for the audit row's `detail` (who this
  // change newly pushes over/under) — `preview.allAffected` is never used as
  // a write target; there is no batch update to make.
  const preview = previewGlobalDefaultChange(db, input.proposedBytes, graceBytes);
  const now = Math.floor(Date.now() / 1000);

  withAudit(db, ({ tx, audit }) => {
    tx.insert(appSetting)
      .values({ key: 'default_quota_bytes', value: JSON.stringify(input.proposedBytes), updatedAt: now, updatedBy: input.actor })
      .onConflictDoUpdate({
        target: appSetting.key,
        set: { value: JSON.stringify(input.proposedBytes), updatedAt: now, updatedBy: input.actor },
      })
      .run();

    audit({
      actor: input.actor,
      actorRole: 'operator',
      action: 'setting.changed',
      targetType: 'setting',
      targetId: 'default_quota_bytes',
      before: { defaultQuotaBytes: before },
      after: { defaultQuotaBytes: input.proposedBytes, note: input.note ?? null },
      outcome: 'ok',
      source: 'ui',
      detail: {
        affectedMemberCount: preview.allAffected.length,
        newlyOver: preview.newlyOver.map((e) => ({ ssoUsername: e.ssoUsername, usageBytes: e.usageBytes, overageAfterBytes: e.overageAfterBytes })),
        newlyUnder: preview.newlyUnder.map((e) => e.ssoUsername),
      },
    });
  });

  return { kind: 'ok', result: { before, after: input.proposedBytes, preview }, warning: freeSpaceWarning(input.proposedBytes, input.freeBytesOverride) };
}

export interface SetMemberOverrideInput {
  ssoUsername: string;
  proposedBytes: number;
  actor: string;
  note?: string;
  freeBytesOverride?: number;
  graceBytesOverride?: number;
}

export interface SetMemberOverrideResult {
  before: EffectiveQuota;
  after: EffectiveQuota;
  effect: MemberQuotaChangePreview;
}

/**
 * `FR-POL-2`: sets a per-member override. `0` means unlimited — a real
 * decision, stored and audited exactly like any other value, never
 * special-cased into a different code path. `FR-POL-5`'s overage/
 * confirmation data is computed HERE (server-side, from the real `claim`
 * usage at commit time) and written into the audit row's `detail` — the
 * confirmation UI itself is out of this module's scope, but the row it
 * produces is authoritative regardless of what the UI showed beforehand.
 */
export function setMemberOverride(db: SeerrQuotaDb, input: SetMemberOverrideInput): PolicyWriteOutcome<SetMemberOverrideResult> {
  const check = validateQuotaBytes(input.proposedBytes, 'override');
  if (!check.valid) return { kind: 'invalid', reason: check.reason };

  const existing = loadQuotaPolicyRow(db, input.ssoUsername);
  const usageBytes = loadMemberUsageBytes(db, input.ssoUsername);
  const graceBytes = input.graceBytesOverride ?? getGraceBytes(db);
  const beforeEffective = resolveEffectiveQuota(existing?.quotaBytes ?? null, getGlobalDefaultQuotaBytes(db));
  const effect = previewOverrideChange({
    ssoUsername: input.ssoUsername,
    usageBytes,
    currentEffective: beforeEffective,
    proposedOverrideBytes: input.proposedBytes,
    graceBytes,
  });
  const now = Math.floor(Date.now() / 1000);

  withAudit(db, ({ tx, audit }) => {
    tx.insert(quotaPolicy)
      .values({ ssoUsername: input.ssoUsername, quotaBytes: input.proposedBytes, source: 'override', note: input.note ?? null, updatedAt: now, updatedBy: input.actor })
      .onConflictDoUpdate({
        target: quotaPolicy.ssoUsername,
        set: { quotaBytes: input.proposedBytes, source: 'override', note: input.note ?? null, updatedAt: now, updatedBy: input.actor },
      })
      .run();

    audit({
      actor: input.actor,
      actorRole: 'operator',
      action: 'quota.set',
      targetType: 'member',
      targetId: input.ssoUsername,
      before: { quotaBytes: existing?.quotaBytes ?? null, source: existing?.source ?? null },
      after: { quotaBytes: input.proposedBytes, source: 'override', note: input.note ?? null },
      outcome: 'ok',
      source: 'ui',
      detail: { usageBytes, wasOver: effect.wasOver, isOver: effect.isOver, overageAfterBytes: effect.overageAfterBytes, requiresConfirmation: effect.requiresConfirmation },
    });
  });

  return {
    kind: 'ok',
    result: { before: beforeEffective, after: effect.after, effect },
    warning: freeSpaceWarning(input.proposedBytes, input.freeBytesOverride),
  };
}

export interface ClearMemberOverrideInput {
  ssoUsername: string;
  actor: string;
  note?: string;
}

export interface ClearMemberOverrideResult {
  before: EffectiveQuota;
  /** What the member's quota resolves to now that they inherit the default — `resolveEffectiveQuota(null, <current default>)`, NOT a value stored anywhere; `unconfigured` only if the global default is itself unset. */
  after: EffectiveQuota;
}

/**
 * `FR-POL-2`/`FR-POL-2a`: "A `null`/cleared override MUST mean 'inherit the
 * default'." Writes a bare `null` (`source: 'default'`) — NOT a resolved
 * value (see this file's header comment). "Inherits default (X GB)" is what
 * the NEXT `resolveEffectiveQuota(null, <current default>)` read produces,
 * always against the live default, never a copy frozen at clear time.
 */
export function clearMemberOverride(db: SeerrQuotaDb, input: ClearMemberOverrideInput): ClearMemberOverrideResult {
  const existing = loadQuotaPolicyRow(db, input.ssoUsername);
  const currentDefault = getGlobalDefaultQuotaBytes(db);
  const beforeEffective = resolveEffectiveQuota(existing?.quotaBytes ?? null, currentDefault);
  const afterEffective = resolveEffectiveQuota(null, currentDefault);
  const now = Math.floor(Date.now() / 1000);

  withAudit(db, ({ tx, audit }) => {
    tx.insert(quotaPolicy)
      .values({ ssoUsername: input.ssoUsername, quotaBytes: null, source: 'default', note: input.note ?? null, updatedAt: now, updatedBy: input.actor })
      .onConflictDoUpdate({
        target: quotaPolicy.ssoUsername,
        set: { quotaBytes: null, source: 'default', note: input.note ?? null, updatedAt: now, updatedBy: input.actor },
      })
      .run();

    audit({
      actor: input.actor,
      actorRole: 'operator',
      action: 'quota.cleared',
      targetType: 'member',
      targetId: input.ssoUsername,
      before: { quotaBytes: existing?.quotaBytes ?? null, source: existing?.source ?? null },
      after: { quotaBytes: null, source: 'default' },
      outcome: 'ok',
      source: 'ui',
      detail: { note: input.note ?? null },
    });
  });

  return { before: beforeEffective, after: afterEffective };
}

// ---------------------------------------------------------------------------
// FR-POL-6: member self-view, gated IN this module.
// ---------------------------------------------------------------------------

export interface QuotaViewer {
  ssoUsername: string;
  isOperator: boolean;
}

export interface MemberQuotaPolicyView {
  ssoUsername: string;
  quotaBytes: number | null;
  source: 'default' | 'override';
  note: string | null;
  effective: EffectiveQuota;
  usageBytes: number;
  updatedAt: number;
  updatedBy: string;
}

export type QuotaPolicyReadResult =
  | { kind: 'ok'; record: MemberQuotaPolicyView }
  | { kind: 'not_found' }
  | { kind: 'forbidden' };

/**
 * `FR-POL-6`: "A member MUST be able to see their own quota... and MUST NOT
 * see other members' quotas." Enforced HERE, not left to the caller — a
 * non-operator `viewer` requesting anyone but themselves gets `forbidden`
 * regardless of what `targetSsoUsername` the caller was handed (e.g. from an
 * unvalidated route param).
 */
export function getMemberQuotaPolicy(db: SeerrQuotaDb, viewer: QuotaViewer, targetSsoUsername: string): QuotaPolicyReadResult {
  if (!viewer.isOperator && viewer.ssoUsername !== targetSsoUsername) {
    return { kind: 'forbidden' };
  }
  const row = loadQuotaPolicyRow(db, targetSsoUsername);
  if (!row) return { kind: 'not_found' };
  const currentDefault = getGlobalDefaultQuotaBytes(db);
  return {
    kind: 'ok',
    record: {
      ssoUsername: row.ssoUsername,
      quotaBytes: row.quotaBytes,
      source: row.source,
      note: row.note,
      effective: resolveEffectiveQuota(row.quotaBytes, currentDefault),
      usageBytes: loadMemberUsageBytes(db, targetSsoUsername),
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    },
  };
}

/** `FR-POL-6`, the operator-only fleet listing (the admin dashboard's table). `'forbidden'` for a non-operator viewer — never a partial/self-only list, which would silently look like "everyone" to a UI that isn't expecting the distinction. */
export function listMemberQuotaPolicies(db: SeerrQuotaDb, viewer: QuotaViewer): MemberQuotaPolicyView[] | 'forbidden' {
  if (!viewer.isOperator) return 'forbidden';
  const usageByMember = loadAllMemberUsageBytes(db);
  const currentDefault = getGlobalDefaultQuotaBytes(db);
  return loadAllQuotaPolicyRows(db).map((row) => ({
    ssoUsername: row.ssoUsername,
    quotaBytes: row.quotaBytes,
    source: row.source,
    note: row.note,
    effective: resolveEffectiveQuota(row.quotaBytes, currentDefault),
    usageBytes: usageByMember.get(row.ssoUsername) ?? 0,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  }));
}
