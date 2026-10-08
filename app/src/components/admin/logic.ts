/**
 * Pure derivation logic behind the admin dashboard (P1-9,
 * `wiki/Feature-07-Admin-Dashboard.md`). Same discipline as
 * `@/components/member/logic.ts` (AGENTS.md rule 9: "pure core, impure
 * shell") — no I/O, no `Date.now()`, no DB, every input is plain data, so
 * every derivation here is hand-testable. The impure shells that feed these
 * from the DB/upstream APIs live under `src/app/admin/_data/**`.
 *
 * Formatting primitives shared with the member view (`formatGB`,
 * `formatTimestamp`, `formatAge`, `computeFreshness`,
 * `resolveNumericRuntimeSetting`) are deliberately NOT duplicated here —
 * imported from `@/components/member/logic` instead, per the project's design
 * ("reuse the shell — it was built generic for exactly this").
 *
 * **Scope note (mid-flight, from the operator):** the admin dashboard gets
 * mutating controls in the very next wave (`FR-ADM-6/7/8/11`), once
 * `src/lib/quota/**` exists. Nothing here assumes read-only forever — see
 * each component's header comment for the seam a future action column/form
 * slots into — but nothing here, or anywhere in `src/app/admin/**` /
 * `src/components/admin/**`, writes.
 */
import type { EffectiveQuota } from '@/lib/members/quota';
import { MASS_REVOCATION_REFUSAL_MARKER } from '@/lib/members/classify';
import { computeFreshness, type Severity } from '@/components/member/logic';

// ---------------------------------------------------------------------------
// Member state (`FR-ADM-3`) — priority order mirrors
// `src/lib/enforcement/decide.ts`'s DecisionInput priority list so the admin
// table's "state" column can never disagree with what enforcement would
// actually do for the same member: operator exemption first (checked before
// any data-quality gate), then the non-`matched` fail-open reasons, then the
// three `FR-POL-2a` quota states, then over/under.
//
// `'operator'` and `'exempt'` are BOTH read off the layout mock in
// `wiki/Feature-07-Admin-Dashboard.md` (`admin` → "operator", `carol` →
// "exempt", both with an unlimited quota) even though FR-ADM-3's own prose
// enum only lists "exempt" — the two examples only make sense as distinct
// states (identity-based exemption vs. quota-based exemption), so this
// module treats `isOperator` as a state of its own, checked first. Flagged
// in the project notes as a resolved prose/mock inconsistency, not a
// silent guess.
//
// `'quota_unconfigured'` is likewise not in FR-ADM-3's literal prose enum,
// but is required by this task's explicit brief ("Handle all three quota
// states distinctly... unconfigured — which is an absence, never rendered as
// 0 or as unlimited") and by `FR-POL-2a` generally. A `not_entitled` member
// is deliberately NOT a case this function handles — `FR-ADM-2` requires the
// per-member table to exclude non-entitled accounts entirely, so the impure
// loader filters those out before this function is ever called.
// ---------------------------------------------------------------------------

/** Matches `member.sync_status`'s enum, minus `not_entitled` — filtered out of the member table before state derivation (`FR-ADM-2`). */
export type AdminMemberSyncStatus = 'matched' | 'no_seerr_account' | 'ambiguous';

export type MemberState = 'operator' | 'exempt' | 'quota_unconfigured' | 'no_acct' | 'ambiguous' | 'over' | 'would_be_over' | 'ok';

export interface MemberStateInput {
  isOperator: boolean;
  syncStatus: AdminMemberSyncStatus;
  quota: EffectiveQuota;
  /** `null` iff usage cannot be measured (no linked Seerr account, or an ambiguous match) — never a substitute `0`. */
  usedBytes: number | null;
  graceBytes: number;
  enforcementEnabled: boolean;
}

export function deriveMemberState(input: MemberStateInput): MemberState {
  if (input.isOperator) return 'operator'; // FR-ENF-6's own priority, mirrored here
  if (input.syncStatus === 'no_seerr_account') return 'no_acct';
  if (input.syncStatus === 'ambiguous') return 'ambiguous';
  if (input.quota.kind === 'unconfigured') return 'quota_unconfigured';
  if (input.quota.kind === 'unlimited') return 'exempt';
  const usedBytes = input.usedBytes ?? 0;
  const overQuota = usedBytes > input.quota.bytes + input.graceBytes;
  if (!overQuota) return 'ok';
  return input.enforcementEnabled ? 'over' : 'would_be_over';
}

/** Text label — `FR-UI-7`: colour is never the sole signal, so every state also has a distinct word/glyph. `'over'` renders upper-case, matching `QuotaPane`'s own "⚠ OVER QUOTA" convention. */
export function memberStateLabel(state: MemberState): string {
  switch (state) {
    case 'operator':
      return 'operator';
    case 'exempt':
      return 'exempt';
    case 'quota_unconfigured':
      return 'no quota set';
    case 'no_acct':
      return 'no acct';
    case 'ambiguous':
      return 'ambiguous';
    case 'over':
      return 'OVER';
    case 'would_be_over':
      return 'would be over';
    case 'ok':
      return 'ok';
  }
}

/** `undefined` for the purely-informational states (operator/exempt/no acct/ambiguous/no quota set) — those aren't a severity, just a fact. */
export function memberStateSeverity(state: MemberState): Severity | undefined {
  switch (state) {
    case 'over':
      return 'critical';
    case 'would_be_over':
      return 'warning';
    case 'ok':
      return 'good';
    default:
      return undefined;
  }
}

/** `undefined` for `skip` — no action was taken, so it isn't a severity either way. */
export function decisionSeverity(decision: string): Severity | undefined {
  switch (decision) {
    case 'approve':
      return 'good';
    case 'hold':
      return 'warning';
    case 'decline':
      return 'critical';
    default:
      return undefined;
  }
}

/** `null` when a percentage genuinely doesn't apply (no measurable usage, or quota isn't a finite limit) — never `0`, which would look like a real 0%. */
export function derivePercentUsed(usedBytes: number | null, quota: EffectiveQuota): number | null {
  if (usedBytes === null) return null;
  if (quota.kind !== 'limited') return null;
  if (quota.bytes <= 0) return null;
  return (usedBytes / quota.bytes) * 100;
}

/** One row of the member table (`FR-ADM-3`). Lives here (not the `_data` loader) so components can import it without depending on the loader module — same split `@/components/member/logic.ts`'s `MemberTitleRow` uses. */
export interface AdminMemberRow {
  ssoUsername: string;
  displayName: string | null;
  isOperator: boolean;
  syncStatus: AdminMemberSyncStatus;
  quota: EffectiveQuota;
  quotaSource: 'default' | 'override' | null;
  /** `null` = no linked Seerr account (or ambiguous) — "linked and using nothing" vs "not linked" (the project's design). Never a substitute `0`. */
  usedBytes: number | null;
  percentUsed: number | null;
  neverWatchedBytes: number | null;
  titleCount: number | null;
  state: MemberState;
}

/** Fleet totals (`FR-ADM-2`). */
export interface FleetTotals {
  freeBytes: number | null;
  freeBytesError: string | null;
  totalLibraryBytes: number;
  totalAttributedBytes: number;
  distinctAttributedTitleCount: number;
  /** Distinct members with at least one active claim — NOT the same as the member table's row count (that also includes members with zero usage). */
  attributedMemberCount: number;
  neverWatchedAttributedBytes: number;
  growthBytesPerDay: number;
  runwayDays: number | null;
}

/** The needs-attention panel's data (`FR-ADM-4`). */
export interface SyncDriftRow {
  ssoUsername: string;
  displayName: string | null;
  entitled: boolean;
  syncStatus: string;
  syncNote: string | null;
}

export interface InvariantViolationRow {
  titleId: string;
  ssoUsername: string;
  chargedBytes: number;
  expectedBytes: number;
  ts: number;
}

export interface NeedsAttentionData {
  skipped: SkipGroup[];
  /** Members whose `sync_status` isn't `matched` — includes `not_entitled` rows (e.g. `akadmin`), which the member table itself excludes (`FR-ADM-2`). */
  syncDrift: SyncDriftRow[];
  unresolvedAttribution: AttributionStepExtras;
  invariantViolations: InvariantViolationRow[];
}

// ---------------------------------------------------------------------------
// Fleet runway (`FR-ADM-2`) — a deliberately simple LINEAR estimate from
// recent `title.added_at` growth, not the full monthly-bucketed trend engine
// `FR-ADM-12` will build (out of this task's scope). `computeRecentGrowthBytesPerDay`
// sums `size_bytes` for titles added within the trailing window and divides
// by the window length; `estimateRunwayDays` divides free space by that rate.
// ---------------------------------------------------------------------------

export interface TitleGrowthInput {
  sizeBytes: number;
  /** Unix seconds; `null` when Radarr/Sonarr never reported an `added` date. */
  addedAt: number | null;
}

export function computeRecentGrowthBytesPerDay(titles: readonly TitleGrowthInput[], nowSeconds: number, windowDays: number): number {
  if (windowDays <= 0) return 0;
  const windowStart = nowSeconds - windowDays * 86_400;
  let bytes = 0;
  for (const t of titles) {
    if (t.addedAt !== null && t.addedAt >= windowStart && t.addedAt <= nowSeconds) bytes += t.sizeBytes;
  }
  return bytes / windowDays;
}

/** `null` when no runway can be estimated: free space unknown, or no measurable recent growth (division by a non-positive rate would be meaningless, not "infinite"). */
export function estimateRunwayDays(freeBytes: number | null, growthBytesPerDay: number): number | null {
  if (freeBytes === null) return null;
  if (growthBytesPerDay <= 0) return null;
  return freeBytes / growthBytesPerDay;
}

export function formatRunway(days: number | null): string {
  if (days === null || !Number.isFinite(days)) return 'insufficient data';
  if (days < 1) return '<1d runway';
  const months = days / 30;
  if (months < 1) return `~${Math.round(days)}d runway`;
  if (months < 24) return `~${Math.round(months)}mo runway`;
  return `~${(months / 12).toFixed(1)}yr runway`;
}

// ---------------------------------------------------------------------------
// sync_run pipeline classification (`FR-ADM-10`, `FR-ADM-4`'s "stale upstream
// data, per sync step"). There is no `pipeline` column — `wiki/Data-Model.md`
// §sync_run just has one `steps` JSON blob per row, and this app has FIVE
// independent reconciler entry points (`src/lib/{members,library,playback,
// attribution}/sync.ts`, `src/lib/enforcement/poller.ts`), each writing its
// OWN `sync_run` row with a distinct set of step keys. Classifying a row by
// which keys its `steps` JSON has is the only way to group "the last run of
// each pipeline" without a schema change (out of this task's scope).
// ---------------------------------------------------------------------------

export type PipelineKind = 'members' | 'library_requests' | 'playback' | 'attribution' | 'pending_sweep' | 'unknown';

/** Every known pipeline kind except `unknown`, in the display order the sync-status pane uses. */
export const ALL_PIPELINE_KINDS: readonly Exclude<PipelineKind, 'unknown'>[] = [
  'members',
  'library_requests',
  'playback',
  'attribution',
  'pending_sweep',
];

export const PIPELINE_LABELS: Record<Exclude<PipelineKind, 'unknown'>, string> = {
  members: 'account sync (seerr accounts / classify)',
  library_requests: 'library + requests (movies / series / requests)',
  playback: 'playback (Jellyfin)',
  attribution: 'attribution (claims / usage)',
  pending_sweep: 'pending sweep (enforcement)',
};

/**
 * `movies`/`series` uniquely identify the library+request pipeline even
 * though it ALSO writes a `requests` key (also written by the attribution
 * pipeline) — checked before the bare `attribution` check for that reason.
 * `classify` uniquely identifies the members pipeline. A row matching none
 * of the five known shapes (e.g. some future step key) classifies `unknown`
 * rather than guessing.
 */
export function classifyPipeline(stepKeys: readonly string[]): PipelineKind {
  const keys = new Set(stepKeys);
  if (keys.has('classify')) return 'members';
  if (keys.has('movies') || keys.has('series')) return 'library_requests';
  if (keys.has('playback')) return 'playback';
  if (keys.has('attribution')) return 'attribution';
  if (keys.has('pending_sweep')) return 'pending_sweep';
  return 'unknown';
}

export interface SyncRunLike {
  id: number;
  startedAt: number;
  /** `null` while a run is still in progress. */
  finishedAt: number | null;
  /** Raw `sync_run.steps` JSON text. */
  steps: string;
  ok: boolean | null;
}

/** The most recent COMPLETED row for each of the five known pipelines, keyed by kind. A pipeline with no row yet is simply absent from the map — callers render "never run" for it, never a fabricated empty run. */
export function pickLatestPerPipeline(rows: readonly SyncRunLike[]): Map<PipelineKind, SyncRunLike> {
  const latest = new Map<PipelineKind, SyncRunLike>();
  for (const row of rows) {
    if (row.finishedAt === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.steps);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') continue;
    const kind = classifyPipeline(Object.keys(parsed as Record<string, unknown>));
    if (kind === 'unknown') continue;
    const existing = latest.get(kind);
    if (!existing || (existing.finishedAt !== null && row.finishedAt > existing.finishedAt)) {
      latest.set(kind, row);
    }
  }
  return latest;
}

/** One step's `{ok,count,ms,error}` as recorded in `sync_run.steps` (`src/lib/http/syncStep.ts`'s `StepResult`, transcribed locally so this module stays independent of that lib import for a plain-data shape). */
export interface StepResultLike {
  ok: boolean;
  count: number;
  ms: number;
  error?: string;
}

/** Parses one `sync_run.steps` JSON blob into its named steps, tolerantly — a malformed blob yields `{}` rather than throwing (this is DISPLAY code; a parse failure should degrade, not crash the dashboard). */
export function parseSteps(raw: string): Record<string, StepResultLike> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, StepResultLike>;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Unresolved requests / unmatched requesters (`FR-ADM-4`, `FR-ACCT-4`) —
// "read from sync_run.steps" per the project's design. **Known gap**: as of
// this task, `src/lib/attribution/sync.ts`'s `recordSyncRun` call only
// persists `{requests, attribution}` `StepResult`s (`{ok,count,ms,error}`)
// into `sync_run.steps` — it does NOT include the `unresolved`/
// `unmatchedRequesters` arrays `runAttributionSync` computes and returns from
// the function call itself. That data is therefore not actually durable
// across a process restart today; only a synchronous caller of
// `runAttributionSync()` (not this dashboard, a separate request path) ever
// sees it. This reader is written DEFENSIVELY and FORWARD-COMPATIBLY: it
// looks for optional `unresolvedCount`/`unmatchedRequesterCount` numeric
// fields on the `attribution` step (the natural, additive JSON extension a
// future fix to that file — out of this task's scope to make — would add),
// and reports `available: false` rather than fabricating a `0` when they're
// absent, per this codebase's "never render a zero that looks like a real
// measurement" convention. Flagged prominently in the project notes.
// ---------------------------------------------------------------------------

export interface AttributionStepExtras {
  available: boolean;
  unresolvedCount: number | null;
  unmatchedRequesterCount: number | null;
}

interface AttributionStepRaw extends StepResultLike {
  unresolvedCount?: unknown;
  unmatchedRequesterCount?: unknown;
}

export function readAttributionStepExtras(steps: Record<string, StepResultLike>): AttributionStepExtras {
  const attr = steps.attribution as AttributionStepRaw | undefined;
  const unresolvedCount = attr && typeof attr.unresolvedCount === 'number' ? attr.unresolvedCount : null;
  const unmatchedRequesterCount = attr && typeof attr.unmatchedRequesterCount === 'number' ? attr.unmatchedRequesterCount : null;
  return {
    available: unresolvedCount !== null || unmatchedRequesterCount !== null,
    unresolvedCount,
    unmatchedRequesterCount,
  };
}

// ---------------------------------------------------------------------------
// Skipped-decision grouping (`FR-ADM-4`, `FR-ENF-4`) — the five skip reasons
// MUST stay distinct, never collapsed into one "skipped" count.
// ---------------------------------------------------------------------------

export type SkipReason = 'stale_snapshot' | 'unknown_member' | 'member_not_matched' | 'quota_unconfigured' | 'usage_unavailable';

/** Display order matches `decide.ts`'s own priority-check order (`src/lib/enforcement/decide.ts`), so the panel reads top-to-bottom the same way the decision function evaluates. */
export const SKIP_REASON_ORDER: readonly SkipReason[] = [
  'unknown_member',
  'member_not_matched',
  'usage_unavailable',
  'stale_snapshot',
  'quota_unconfigured',
];

export const SKIP_REASON_LABELS: Record<SkipReason, string> = {
  stale_snapshot: 'stale snapshot',
  unknown_member: 'unknown member — no member row at all',
  member_not_matched: 'member not matched (ambiguous / no Seerr account / not entitled)',
  quota_unconfigured: 'quota not configured',
  usage_unavailable: 'usage could not be computed',
};

export interface SkippedDecisionLike {
  seerrRequestId: number;
  ssoUsername: string;
  reason: SkipReason;
  decidedAt: number;
}

export interface SkipGroup {
  reason: SkipReason;
  count: number;
  /** Most-recent-first, capped — the attention panel links a sample, not the full list (a genuinely large skip pile is itself a symptom, not something to paginate through here). */
  sample: SkippedDecisionLike[];
}

const SKIP_SAMPLE_LIMIT = 5;

export function groupSkipsByReason(skipped: readonly SkippedDecisionLike[]): SkipGroup[] {
  const byReason = new Map<SkipReason, SkippedDecisionLike[]>();
  for (const s of skipped) {
    const list = byReason.get(s.reason);
    if (list) list.push(s);
    else byReason.set(s.reason, [s]);
  }
  const groups: SkipGroup[] = [];
  for (const reason of SKIP_REASON_ORDER) {
    const list = byReason.get(reason);
    if (!list || list.length === 0) continue;
    groups.push({
      reason,
      count: list.length,
      sample: [...list].sort((a, b) => b.decidedAt - a.decidedAt).slice(0, SKIP_SAMPLE_LIMIT),
    });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Decision rendering (this task's item 5 — "shadow mode must read
// correctly"). `enforced: false` (`request_decision.enforced`, `FR-ENF-5`)
// means this row is a SHADOW verdict: the true `decision`/`reason` are what
// enforcement WOULD have done, not what it did. `describeDecision` renders
// exactly the phrasing the project's design specifies for the hold/over_quota
// case — "would have held — over quota", never a bare "would have held" and
// never "held" outright for a shadow row.
// ---------------------------------------------------------------------------

const DECISION_VERBS: Record<string, string> = { approve: 'approved', hold: 'held', decline: 'declined', skip: 'skipped' };

export function describeDecision(decision: string, reason: string, enforced: boolean): string {
  const verb = DECISION_VERBS[decision] ?? decision;
  const prefix = enforced ? '' : 'would have ';
  return `${prefix}${verb} — ${reason.replace(/_/g, ' ')}`;
}

// ---------------------------------------------------------------------------
// `FR-ADM-9` (the jellyseerr-vs-seerr-quota Authentik entitlement mismatch
// check) was REMOVED in 0.2.0 along with the rest of the Authentik
// integration — the member roster is Seerr's own user list now, so there is
// no second entitlement list left to drift from. See `CHANGELOG.md` 0.2.0.
// ---------------------------------------------------------------------------
// Server-side pagination math (`FR-ADM-5`: "paginate server-side... a member
// drill-down must not load 500 rows into the browser"). Pure: given a
// requested page, a page size, and a total row COUNT, computes the clamped
// page and the LIMIT/OFFSET a caller's SQL query should use — the actual DB
// query (which never fetches more than one page) lives in the impure loader.
// ---------------------------------------------------------------------------

export interface PageMeta {
  page: number;
  pageSize: number;
  totalCount: number;
  pageCount: number;
  offset: number;
}

export function paginationMeta(requestedPage: number, pageSize: number, totalCount: number): PageMeta {
  const pageCount = Math.max(1, Math.ceil(totalCount / pageSize));
  const page = Math.min(Math.max(1, Math.floor(requestedPage) || 1), pageCount);
  return { page, pageSize, totalCount, pageCount, offset: (page - 1) * pageSize };
}

// ---------------------------------------------------------------------------
// Runtime settings — boolean flavour of `@/components/member/logic`'s
// `resolveNumericRuntimeSetting` (same DB-wins-over-config-default precedence,
// `wiki/Configuration.md`), needed here for `enforcement_enabled`: item 5 of
// the project's design ("shadow mode must read correctly") requires knowing the
// CURRENT toggle state to render "would have held" vs "held" correctly, even
// though flipping it is `FR-ADM-11` (a later, mutating task).
// ---------------------------------------------------------------------------
export function resolveBooleanRuntimeSetting(row: { value: string } | undefined, fallback: boolean): boolean {
  if (!row) return fallback;
  try {
    const parsed = JSON.parse(row.value);
    return typeof parsed === 'boolean' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Per-pipeline sync status (`FR-ADM-10`'s read half, and `FR-ADM-4`'s "stale
// upstream data, per sync step" — built ONCE and shared by both the
// needs-attention panel and the dedicated sync-status pane, so the two
// screens can never disagree about which run is "latest"). Pure: takes the
// already-selected latest row for one pipeline (or `undefined` if that
// pipeline has never completed a run) plus `nowSeconds`/`staleAfterSeconds`.
// ---------------------------------------------------------------------------

export interface PipelineStepStatus {
  stepKey: string;
  ok: boolean;
  count: number;
  ms: number;
  error: string | null;
}

export interface PipelineStatus {
  kind: Exclude<PipelineKind, 'unknown'>;
  label: string;
  /** No completed `sync_run` row has ever matched this pipeline's step shape. */
  neverRun: boolean;
  finishedAt: number | null;
  ageSeconds: number | null;
  stale: boolean;
  /** `sync_run.ok` — `null` when `neverRun`. */
  overallOk: boolean | null;
  steps: PipelineStepStatus[];
}

export function buildPipelineStatus(
  kind: Exclude<PipelineKind, 'unknown'>,
  latestRow: SyncRunLike | undefined,
  nowSeconds: number,
  staleAfterSeconds: number,
): PipelineStatus {
  if (!latestRow || latestRow.finishedAt === null) {
    return { kind, label: PIPELINE_LABELS[kind], neverRun: true, finishedAt: null, ageSeconds: null, stale: true, overallOk: null, steps: [] };
  }
  const freshness = computeFreshness(latestRow.finishedAt, nowSeconds, staleAfterSeconds);
  const parsed = parseSteps(latestRow.steps);
  const steps: PipelineStepStatus[] = Object.entries(parsed).map(([stepKey, s]) => ({
    stepKey,
    ok: s.ok === true,
    count: typeof s.count === 'number' ? s.count : 0,
    ms: typeof s.ms === 'number' ? s.ms : 0,
    error: typeof s.error === 'string' ? s.error : null,
  }));
  return {
    kind,
    label: PIPELINE_LABELS[kind],
    neverRun: false,
    finishedAt: latestRow.finishedAt,
    ageSeconds: freshness.ageSeconds,
    stale: freshness.stale,
    overallOk: latestRow.ok,
    steps,
  };
}

/**
 * Second security review (PR #17), "SHOULD-FIX 2": detects "the most recent
 * `members` sync cycle was refused by `checkMassRevocationRisk`" purely
 * from the already-loaded `pipelines` array, so the admin dashboard can
 * conditionally show the one-shot "apply roster sync anyway" override
 * control (`ForceMembersSyncControl`) only when it's actually relevant —
 * never on an ordinary successful or merely-stale cycle.
 */
export function wasMembersSyncRefusedByMassRevocationGuard(pipelines: readonly PipelineStatus[]): boolean {
  const membersPipeline = pipelines.find((p) => p.kind === 'members');
  if (!membersPipeline) return false;
  const classifyStep = membersPipeline.steps.find((s) => s.stepKey === 'classify');
  return classifyStep?.error?.includes(MASS_REVOCATION_REFUSAL_MARKER) ?? false;
}

/** Trailing-window length for the linear runway estimate (`estimateRunwayDays`) — see that function's header comment for why this isn't the full monthly-bucketed trend engine. */
export const GROWTH_WINDOW_DAYS = 30;

// ---------------------------------------------------------------------------
// P2-5 (`FR-ADM-6/7/8/11`) — pure logic behind the mutating admin controls.
// Same discipline as the rest of this file: no I/O, no `Date.now()`, no DB.
// The impure shells that call these live under `src/app/admin/_actions/**`
// and `src/app/api/admin/**`.
// ---------------------------------------------------------------------------

/**
 * `FR-ADM-11`'s enforcement-toggle confirmation: "how many members would be
 * affected right now (reuse the FR-POL-4 preview machinery)." Counts members
 * whose table `state` is `over` or `would_be_over` — i.e. genuinely over
 * their effective quota by the SAME `usedBytes > quota.bytes + graceBytes`
 * comparison `@/lib/quota`'s `isOverQuota` makes (this module's
 * `deriveMemberState` mirrors that formula exactly, see its own header
 * comment) — rather than re-deriving over/under from scratch here. Using the
 * already-categorised `AdminMemberRow[]` (not a bare re-run of `isOverQuota`
 * over raw usage/quota pairs) is deliberate: it's the only version of "who's
 * over" that ALSO correctly excludes the operator (`FR-ENF-6`) and
 * unconfigured/unlimited members without re-deriving that exclusion logic a
 * second time and risking it drifting from the member table's own count.
 */
export function countMembersCurrentlyOverQuota(members: readonly AdminMemberRow[]): { count: number; usernames: string[] } {
  const over = members.filter((m) => m.state === 'over' || m.state === 'would_be_over');
  return { count: over.length, usernames: over.map((m) => m.ssoUsername).sort() };
}

/** `FR-ADM-11`: generic non-negative-integer validation for the five plain-count/day/second settings (everything except `grace_bytes`, which reuses `@/lib/quota`'s `validateGraceBytes` instead, since it has its own ceiling-against-the-default rule). */
export function validateNonNegativeIntegerSetting(value: number, label: string): { valid: true } | { valid: false; reason: string } {
  if (!Number.isFinite(value)) return { valid: false, reason: `${label} must be a finite number` };
  if (!Number.isInteger(value)) return { valid: false, reason: `${label} must be a whole number` };
  if (value < 0) return { valid: false, reason: `${label} must not be negative (got ${value})` };
  return { valid: true };
}

/** The six `app_setting` keys `FR-ADM-11` names besides `enforcement_enabled` (which gets its own dedicated confirm flow, `enforcement.toggled`). */
export type EditableNumericSettingKey =
  | 'grace_bytes'
  | 'delete_recent_play_days'
  | 'stale_snapshot_max_age_s'
  | 'delete_max_per_hour'
  | 'hold_max_days'
  | 'notify_cooldown_s';

export const EDITABLE_NUMERIC_SETTINGS: readonly EditableNumericSettingKey[] = [
  'grace_bytes',
  'delete_recent_play_days',
  'stale_snapshot_max_age_s',
  'delete_max_per_hour',
  'hold_max_days',
  'notify_cooldown_s',
];

export type SettingUnit = 'bytes_gb' | 'days' | 'seconds' | 'count';

export interface SettingMeta {
  key: EditableNumericSettingKey;
  label: string;
  unit: SettingUnit;
  help: string;
}

/** Display metadata for the settings form — pure data, no DB. `unit: 'bytes_gb'` means the DB stores raw bytes but the form (matching `FR-POL-9`'s GB convention for the closely-related quota fields) reads/writes decimal GB via `@/lib/quota`'s `gbToBytes`/`bytesToGb`. */
export const SETTING_METADATA: Record<EditableNumericSettingKey, SettingMeta> = {
  grace_bytes: { key: 'grace_bytes', label: 'grace', unit: 'bytes_gb', help: 'allowance above quota before a request is held (FR-POL-8)' },
  delete_recent_play_days: { key: 'delete_recent_play_days', label: 'delete recent-play guard', unit: 'days', help: 'blocks self-service deletion of a title played this recently' },
  stale_snapshot_max_age_s: { key: 'stale_snapshot_max_age_s', label: 'stale snapshot threshold', unit: 'seconds', help: 'attribution data older than this makes enforcement skip rather than decide' },
  delete_max_per_hour: { key: 'delete_max_per_hour', label: 'delete rate limit', unit: 'count', help: 'per-member deletions allowed per hour' },
  hold_max_days: { key: 'hold_max_days', label: 'hold max days', unit: 'days', help: 'a held request this old is auto-declined as a safety valve; 0 = never' },
  notify_cooldown_s: { key: 'notify_cooldown_s', label: 'notify cooldown', unit: 'seconds', help: 'minimum gap between hold notifications to one member' },
};
