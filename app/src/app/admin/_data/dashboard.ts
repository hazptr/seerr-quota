/**
 * Impure shell for the admin dashboard's main screen (P1-9,
 * `wiki/Feature-07-Admin-Dashboard.md` `FR-ADM-2/3/4/13`). Reads the DB
 * (plus one filesystem `statfs` call for free space, `FR-ADM-2`) and hands
 * plain data to the pure derivation functions in `@/components/admin/logic`.
 * Kept under `src/app/admin/_data/` (underscore-prefixed, so Next's App
 * Router never treats it as a route), mirroring
 * `src/app/_data/memberDashboard.ts`'s placement convention from P1-8 — but
 * nested inside `admin/`, since this loader is specific to the admin
 * dashboard (`app/src/app/admin/**`).
 *
 * Every export here is READ-ONLY: no `INSERT`/`UPDATE`/`DELETE` anywhere in
 * this file. The next wave (`FR-ADM-6/7/8/11`) adds mutating routes once
 * `src/lib/quota/**` exists — this loader's job is only to describe the
 * current state clearly enough for that wave to render an action next to it.
 */
import fs from 'node:fs';
import { desc, eq } from 'drizzle-orm';
import { getConfig } from '@/lib/config';
import { getDb, type SeerrQuotaDb } from '@/lib/db';
import { appSetting, audit, claim, member, quotaPolicy, requestDecision, syncRun, title } from '@/lib/db/schema';
import { resolveEffectiveQuota } from '@/lib/members/quota';
import { getGlobalDefaultQuotaBytes } from '@/lib/quota/policy';
import { buildTitlesById, computeFleetDistinctTitleTotal, computeNeverWatchedBytes } from '@/lib/attribution/compute';
import type { AttributionClaim, AttributionTitleInput } from '@/lib/attribution/types';
import { resolveNumericRuntimeSetting } from '@/components/member/logic';
import {
  ALL_PIPELINE_KINDS,
  GROWTH_WINDOW_DAYS,
  buildPipelineStatus,
  computeRecentGrowthBytesPerDay,
  deriveMemberState,
  derivePercentUsed,
  estimateRunwayDays,
  groupSkipsByReason,
  parseSteps,
  pickLatestPerPipeline,
  readAttributionStepExtras,
  resolveBooleanRuntimeSetting,
  type AdminMemberRow,
  type AdminMemberSyncStatus,
  type FleetTotals,
  type NeedsAttentionData,
  type PipelineStatus,
  type SkippedDecisionLike,
  type SyncRunLike,
} from '@/components/admin/logic';

// ---------------------------------------------------------------------------
// Free space (`FR-ADM-2`) — `statvfs` via Node's `fs.statfsSync`, against the
// read-only bind mount already declared in `docker-compose.yml`
// (e.g. `/mnt/media:/mnt/media:ro`) at `Config.paths.mediaFreeSpacePath`.
// `bavail` (blocks available to an unprivileged user) matches what `df`
// reports as "Avail", not the raw `bfree` (which includes root-reserved
// blocks) — the more honest "space you could actually use" figure.
// Injectable so a test can point it at a throwaway directory instead of the
// real host mount.
// ---------------------------------------------------------------------------
export function readFreeBytes(mediaFreeSpacePath: string): { freeBytes: number; freeBytesError: null } | { freeBytes: null; freeBytesError: string } {
  try {
    const stats = fs.statfsSync(mediaFreeSpacePath);
    return { freeBytes: stats.bavail * stats.bsize, freeBytesError: null };
  } catch (err) {
    return { freeBytes: null, freeBytesError: err instanceof Error ? err.message : String(err) };
  }
}

export type AdminDashboardResult =
  | { kind: 'no_data' }
  | {
      kind: 'ok';
      now: number;
      staleAfterSeconds: number;
      enforcementEnabled: boolean;
      attributionSnapshotAt: number;
      fleet: FleetTotals;
      members: AdminMemberRow[];
      attention: NeedsAttentionData;
      pipelines: PipelineStatus[];
    };

/** Safety cap on how many recent `sync_run` rows are scanned for pipeline classification — defends against a pathological table, matching `src/lib/enforcement/usage.ts`'s `SYNC_RUN_SCAN_LIMIT` convention. */
const SYNC_RUN_SCAN_LIMIT = 200;

function loadSyncRuns(db: SeerrQuotaDb): SyncRunLike[] {
  return db
    .select({ id: syncRun.id, startedAt: syncRun.startedAt, finishedAt: syncRun.finishedAt, steps: syncRun.steps, ok: syncRun.ok })
    .from(syncRun)
    .orderBy(desc(syncRun.id))
    .limit(SYNC_RUN_SCAN_LIMIT)
    .all();
}

/**
 * Selects every field `AttributionTitleInput` needs (`mediaType`, `tmdbId`,
 * `tvdbId`, `sizeBytes`, `lastSyncedAt`) PLUS `addedAt`/`watchedByAnyone` this
 * loader also needs — so the result can be passed straight into
 * `buildTitlesById`/`computeRecentGrowthBytesPerDay` without an unsafe cast
 * (a narrower projection isn't structurally assignable to
 * `AttributionTitleInput`, which TypeScript correctly rejects).
 */
function loadTitles(db: SeerrQuotaDb) {
  return db
    .select({
      id: title.id,
      mediaType: title.mediaType,
      tmdbId: title.tmdbId,
      tvdbId: title.tvdbId,
      sizeBytes: title.sizeBytes,
      lastSyncedAt: title.lastSyncedAt,
      addedAt: title.addedAt,
      watchedByAnyone: title.watchedByAnyone,
    })
    .from(title)
    .all();
}

/** Selects every field `AttributionClaim` needs (including `seerrRequestId`, nullable in the schema — coerced to `0` only where a caller's TYPE requires a `number` and never reads it, see `computeFleetTotals`) alongside `titleId`/`ssoUsername`/`chargedBytes`, which this loader's own per-member aggregation also needs directly. */
function loadActiveClaims(db: SeerrQuotaDb): { titleId: string; ssoUsername: string; seerrRequestId: number | null; chargedBytes: number }[] {
  return db
    .select({ titleId: claim.titleId, ssoUsername: claim.ssoUsername, seerrRequestId: claim.seerrRequestId, chargedBytes: claim.chargedBytes })
    .from(claim)
    .where(eq(claim.active, true))
    .all();
}

/** `AttributionTitleInput`'s fields plus the two this loader also needs (`addedAt` for the growth estimate, `watchedByAnyone` for the never-watched split) — `loadTitles`'s query selects exactly this shape. */
type TitleForFleetCompute = AttributionTitleInput & { addedAt: number | null; watchedByAnyone: boolean };

/** `FR-ADM-2`: fleet byte totals include every title on disk / every active claim, REGARDLESS of member entitlement (`not_entitled` accounts like `akadmin` still reflect real disk usage) — so this reads ALL active claims, unfiltered. Only the per-member TABLE (`loadMemberRows` below) filters to entitled members. */
function computeFleetTotals(
  mediaFreeSpacePath: string,
  titles: TitleForFleetCompute[],
  activeClaims: { titleId: string; ssoUsername: string; seerrRequestId: number | null; chargedBytes: number }[],
  nowSeconds: number,
): FleetTotals {
  const { freeBytes, freeBytesError } = readFreeBytes(mediaFreeSpacePath);
  const totalLibraryBytes = titles.reduce((sum, t) => sum + t.sizeBytes, 0);

  const titlesById = buildTitlesById(titles);
  // `computeNeverWatchedBytes` types its parameter as the full `AttributionClaim[]`
  // (it never actually reads `seerrRequestId` at runtime) — `?? 0` is a
  // type-satisfying placeholder only, never a real "request 0".
  const claimsForCompute: AttributionClaim[] = activeClaims.map((c) => ({ ...c, seerrRequestId: c.seerrRequestId ?? 0 }));
  const totalAttributedBytes = computeFleetDistinctTitleTotal(activeClaims, titlesById);
  const distinctAttributedTitleCount = new Set(activeClaims.map((c) => c.titleId)).size;
  const attributedMemberCount = new Set(activeClaims.map((c) => c.ssoUsername)).size;

  const watchedByTitleId = new Map(titles.map((t) => [t.id, t.watchedByAnyone]));
  const neverWatchedAttributedBytes = computeNeverWatchedBytes(claimsForCompute, watchedByTitleId).distinctTitleBytes;

  const growthBytesPerDay = computeRecentGrowthBytesPerDay(titles, nowSeconds, GROWTH_WINDOW_DAYS);
  const runwayDays = estimateRunwayDays(freeBytes, growthBytesPerDay);

  return {
    freeBytes,
    freeBytesError,
    totalLibraryBytes,
    totalAttributedBytes,
    distinctAttributedTitleCount,
    attributedMemberCount,
    neverWatchedAttributedBytes,
    growthBytesPerDay,
    runwayDays,
  };
}

function loadMemberRows(
  db: SeerrQuotaDb,
  activeClaims: { titleId: string; ssoUsername: string; chargedBytes: number }[],
  titles: { id: string; watchedByAnyone: boolean }[],
  graceBytes: number,
  enforcementEnabled: boolean,
): AdminMemberRow[] {
  const memberRows = db
    .select({
      ssoUsername: member.ssoUsername,
      displayName: member.displayName,
      isOperator: member.isOperator,
      syncStatus: member.syncStatus,
      entitled: member.entitled,
    })
    .from(member)
    .where(eq(member.entitled, true)) // FR-ADM-2: the per-member TABLE excludes non-entitled accounts (fleet byte totals do not)
    .all();

  const quotaRows = db.select().from(quotaPolicy).all();
  const quotaByMember = new Map(quotaRows.map((q) => [q.ssoUsername, q]));
  // `FR-POL-2a`: resolved at read time from BOTH the row's stored override
  // AND the current global default — fetched once, not per member.
  const currentDefaultQuotaBytes = getGlobalDefaultQuotaBytes(db);

  const watchedByTitleId = new Map(titles.map((t) => [t.id, t.watchedByAnyone]));
  const usedByMember = new Map<string, number>();
  const neverWatchedByMember = new Map<string, number>();
  const titleCountByMember = new Map<string, number>();
  for (const c of activeClaims) {
    usedByMember.set(c.ssoUsername, (usedByMember.get(c.ssoUsername) ?? 0) + c.chargedBytes);
    titleCountByMember.set(c.ssoUsername, (titleCountByMember.get(c.ssoUsername) ?? 0) + 1);
    if (watchedByTitleId.get(c.titleId) === false) {
      neverWatchedByMember.set(c.ssoUsername, (neverWatchedByMember.get(c.ssoUsername) ?? 0) + c.chargedBytes);
    }
  }

  const rows: AdminMemberRow[] = memberRows.map((m) => {
    const quotaRow = quotaByMember.get(m.ssoUsername);
    const quota = resolveEffectiveQuota(quotaRow?.quotaBytes ?? null, currentDefaultQuotaBytes);
    const quotaSource = quotaRow?.source ?? null;
    // `not_entitled` members are excluded from this query entirely (WHERE entitled=1), so `m.syncStatus` here is only ever matched/no_seerr_account/ambiguous.
    const syncStatus = m.syncStatus as AdminMemberSyncStatus;
    const hasMeasurableUsage = syncStatus === 'matched';
    const usedBytes = hasMeasurableUsage ? (usedByMember.get(m.ssoUsername) ?? 0) : null;
    const neverWatchedBytes = hasMeasurableUsage ? (neverWatchedByMember.get(m.ssoUsername) ?? 0) : null;
    const titleCount = hasMeasurableUsage ? (titleCountByMember.get(m.ssoUsername) ?? 0) : null;

    const state = deriveMemberState({
      isOperator: m.isOperator,
      syncStatus,
      quota,
      usedBytes,
      graceBytes,
      enforcementEnabled,
    });

    return {
      ssoUsername: m.ssoUsername,
      displayName: m.displayName,
      isOperator: m.isOperator,
      syncStatus,
      quota,
      quotaSource,
      usedBytes,
      percentUsed: derivePercentUsed(usedBytes, quota),
      neverWatchedBytes,
      titleCount,
      state,
    };
  });

  // Largest usage first, matching the layout mock; members with unmeasurable
  // usage (no account / ambiguous) sort to the bottom rather than colliding
  // with a genuine 0.
  rows.sort((a, b) => (b.usedBytes ?? -1) - (a.usedBytes ?? -1));
  return rows;
}

function loadNeedsAttention(db: SeerrQuotaDb, attributionRow: SyncRunLike | undefined): NeedsAttentionData {
  const skipRows = db
    .select({ seerrRequestId: requestDecision.seerrRequestId, ssoUsername: requestDecision.ssoUsername, reason: requestDecision.reason, decidedAt: requestDecision.decidedAt })
    .from(requestDecision)
    .where(eq(requestDecision.decision, 'skip'))
    .all();
  // Narrow to the five documented skip reasons — `decision='skip'` rows can
  // only ever carry one of these per `src/lib/enforcement/types.ts`'s
  // `EnforcementReason` union, but that's not visible to this file's own
  // `SkippedDecisionLike` type without a cast.
  const skipped = skipRows as SkippedDecisionLike[];
  const skippedGroups = groupSkipsByReason(skipped);

  const driftRows = db
    .select({ ssoUsername: member.ssoUsername, displayName: member.displayName, entitled: member.entitled, syncStatus: member.syncStatus, syncNote: member.syncNote })
    .from(member)
    .all()
    .filter((m) => m.syncStatus !== 'matched');

  // Read the RAW `steps` JSON, not `PipelineStatus.steps` (`buildPipelineStatus`
  // reconstructs a fixed `{stepKey,ok,count,ms,error}` shape and would silently
  // drop any extra field like `unresolvedCount` even once a future fix adds
  // it — see `readAttributionStepExtras`'s header comment on this gap).
  const attributionExtras = readAttributionStepExtras(attributionRow ? parseSteps(attributionRow.steps) : {});

  const invariantRows = db
    .select({ targetId: audit.targetId, detail: audit.detail, ts: audit.ts })
    .from(audit)
    .where(eq(audit.action, 'invariant.violated'))
    .all();
  const sinceMs = attributionRow ? attributionRow.startedAt * 1000 : 0;
  const invariantViolations = invariantRows
    .filter((r) => r.ts >= sinceMs)
    .map((r) => {
      let detail: { ssoUsername?: unknown; chargedBytes?: unknown; expectedBytes?: unknown } = {};
      try {
        detail = r.detail ? JSON.parse(r.detail) : {};
      } catch {
        detail = {};
      }
      return {
        titleId: r.targetId ?? 'unknown',
        ssoUsername: typeof detail.ssoUsername === 'string' ? detail.ssoUsername : 'unknown',
        chargedBytes: typeof detail.chargedBytes === 'number' ? detail.chargedBytes : 0,
        expectedBytes: typeof detail.expectedBytes === 'number' ? detail.expectedBytes : 0,
        ts: r.ts,
      };
    });

  return {
    skipped: skippedGroups,
    syncDrift: driftRows,
    unresolvedAttribution: attributionExtras,
    invariantViolations,
  };
}

/** The P1-9 admin dashboard's main read. `nowSeconds` is injectable for tests; production callers omit it. */
export async function loadAdminDashboard(nowSeconds: number = Math.floor(Date.now() / 1000)): Promise<AdminDashboardResult> {
  const db = getDb();
  const config = getConfig();

  const syncRuns = loadSyncRuns(db);
  const latestPerPipeline = pickLatestPerPipeline(syncRuns);

  const staleRow = db.select().from(appSetting).where(eq(appSetting.key, 'stale_snapshot_max_age_s')).get();
  const staleAfterSeconds = resolveNumericRuntimeSetting(staleRow, config.runtime.staleSnapshotMaxAgeS);

  const enforcementRow = db.select().from(appSetting).where(eq(appSetting.key, 'enforcement_enabled')).get();
  const enforcementEnabled = resolveBooleanRuntimeSetting(enforcementRow, config.runtime.enforcementEnabled);

  const graceRow = db.select().from(appSetting).where(eq(appSetting.key, 'grace_bytes')).get();
  const graceBytes = resolveNumericRuntimeSetting(graceRow, config.runtime.graceBytes);

  const pipelines = ALL_PIPELINE_KINDS.map((kind) => buildPipelineStatus(kind, latestPerPipeline.get(kind), nowSeconds, staleAfterSeconds));

  const attributionPipeline = latestPerPipeline.get('attribution');
  if (!attributionPipeline || attributionPipeline.finishedAt === null) {
    return { kind: 'no_data' };
  }

  const titles = loadTitles(db);
  const activeClaims = loadActiveClaims(db);

  const fleet = computeFleetTotals(config.paths.mediaFreeSpacePath, titles, activeClaims, nowSeconds);
  const members = loadMemberRows(db, activeClaims, titles, graceBytes, enforcementEnabled);
  const attention = loadNeedsAttention(db, attributionPipeline);

  return {
    kind: 'ok',
    now: nowSeconds,
    staleAfterSeconds,
    enforcementEnabled,
    attributionSnapshotAt: attributionPipeline.finishedAt,
    fleet,
    members,
    attention,
    pipelines,
  };
}
