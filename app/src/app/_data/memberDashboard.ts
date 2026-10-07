/**
 * Impure shell for the member view (P1-8). Reads exactly the rows the
 * signed-in member is entitled to see — never another member's data
 * (`FR-POL-6`) — and hands them to the pure derivation functions in
 * `@/components/member/logic.ts`. Kept under `src/app/_data/` (an
 * underscore-prefixed folder, so Next's App Router never treats it as a
 * route) rather than `src/lib/**`, per this file's scope: everything
 * under `src/lib/{members,attribution,...}/**` is another task's territory
 * to modify, but importing their already-exported read helpers
 * (`getDb`, the schema tables, `resolveEffectiveQuota`, `getConfig`) is
 * exactly how a consumer is meant to use them.
 *
 * `FR-ACCT-8` — every figure on the page comes from ONE attribution
 * snapshot (`findLatestAttributionSnapshot`); if that snapshot doesn't
 * exist yet (no reconcile has ever completed), this returns `no_snapshot`
 * rather than a set of zeros that would read as a real measurement (this
 * task's item 6).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getConfig } from '@/lib/config';
import { getDb, type SeerrQuotaDb } from '@/lib/db';
import { appSetting, claim, quotaPolicy, syncRun, title } from '@/lib/db/schema';
import { loadScheduledDeletionsForMember } from '@/lib/deletion';
import { loadEpisodeProgress } from '@/lib/playback/progress';
import { resolveEffectiveQuota, type EffectiveQuota } from '@/lib/members/quota';
import { getGlobalDefaultQuotaBytes } from '@/lib/quota/policy';
import {
  findLatestAttributionSnapshot,
  resolveNumericRuntimeSetting,
  type MemberTitleRow,
  type SyncRunLike,
} from '@/components/member/logic';

/** One of this member's still-cancellable scheduled deletions (`FR-DEL-24`). */
export interface PendingDeletion {
  deletionId: number;
  titleId: string;
  name: string;
  bytesClaimed: number;
  scheduledFor: number;
}

export interface MemberDashboardOk {
  kind: 'ok';
  quota: EffectiveQuota;
  quotaNote: string | null;
  /** Still-pending deletions this member can cancel, soonest first. */
  pendingDeletions: PendingDeletion[];
  /** Bytes already credited back by those pending deletions (`FR-DEL-27`) — what `usedBytes` has ALREADY had subtracted. */
  pendingDeletionBytes: number;
  usedBytes: number;
  titles: MemberTitleRow[];
  /** Unix seconds — when the attribution snapshot these figures came from finished (`FR-ACCT-8`). */
  snapshotAt: number;
  /** `stale_snapshot_max_age_s` — DB (`app_setting`) if set, else `STALE_SNAPSHOT_MAX_AGE_S`'s config-resolved value. */
  staleAfterSeconds: number;
}

/** No attribution reconcile has EVER completed — this task's item 6: never render zeros that look like measurements. */
export interface MemberDashboardNoSnapshot {
  kind: 'no_snapshot';
}

export type MemberDashboardResult = MemberDashboardOk | MemberDashboardNoSnapshot;

function loadAttributionSnapshot(db: SeerrQuotaDb): { syncRunId: number; finishedAt: number } | undefined {
  const rows: SyncRunLike[] = db.select({ id: syncRun.id, finishedAt: syncRun.finishedAt, steps: syncRun.steps }).from(syncRun).all();
  return findLatestAttributionSnapshot(rows);
}

function loadStaleThresholdSeconds(db: SeerrQuotaDb): number {
  const row = db.select().from(appSetting).where(eq(appSetting.key, 'stale_snapshot_max_age_s')).get();
  return resolveNumericRuntimeSetting(row, getConfig().runtime.staleSnapshotMaxAgeS);
}

/** The member's own active claims, joined to their title — never another member's row. */
function loadMemberClaims(
  db: SeerrQuotaDb,
  ssoUsername: string,
): Array<{
  titleId: string;
  name: string;
  year: number | null;
  chargedBytes: number;
  mediaType: 'movie' | 'tv';
  watchedByAnyone: boolean;
  lastPlayedAnyAt: number | null;
}> {
  return db
    .select({
      titleId: title.id,
      name: title.title,
      year: title.year,
      chargedBytes: claim.chargedBytes,
      mediaType: title.mediaType,
      watchedByAnyone: title.watchedByAnyone,
      lastPlayedAnyAt: title.lastPlayedAnyAt,
    })
    .from(claim)
    .innerJoin(title, eq(claim.titleId, title.id))
    .where(and(eq(claim.ssoUsername, ssoUsername), eq(claim.active, true)))
    .all();
}

/**
 * How many ACTIVE claimants (including this member) each of the given
 * titles has — used only to derive `otherActiveClaimants` (`titleId ->
 * count - 1`). Never surfaces who the other claimants are (`FR-POL-6`: a
 * member must not see other members' data), only that the title is shared.
 */
function loadActiveClaimantCounts(db: SeerrQuotaDb, titleIds: string[]): Map<string, number> {
  if (titleIds.length === 0) return new Map();
  const rows = db
    .select({ titleId: claim.titleId, count: sql<number>`count(*)` })
    .from(claim)
    .where(and(eq(claim.active, true), inArray(claim.titleId, titleIds)))
    .groupBy(claim.titleId)
    .all();
  return new Map(rows.map((r) => [r.titleId, Number(r.count)]));
}

/** Loads exactly `ssoUsername`'s own quota/usage/titles — the page's caller MUST have already confirmed (via `getMemberGate`) that this member is `matched` (`FR-SSO-8`). */
export async function loadMemberDashboard(ssoUsername: string): Promise<MemberDashboardResult> {
  const db = getDb();

  const snapshot = loadAttributionSnapshot(db);
  if (!snapshot) return { kind: 'no_snapshot' };

  const claimRows = loadMemberClaims(db, ssoUsername);
  const claimantCounts = loadActiveClaimantCounts(
    db,
    claimRows.map((r) => r.titleId),
  );

  // Episode progress so the watched column can tell the truth about a series
  // somebody sampled one episode of, rather than flatly calling it "watched"
  // (`deriveWatchState`, `@/lib/playback/watchState.ts`).
  const progress = loadEpisodeProgress(db, claimRows.map((r) => r.titleId));

  const titles: MemberTitleRow[] = claimRows.map((r) => ({
    titleId: r.titleId,
    name: r.name,
    year: r.year,
    chargedBytes: r.chargedBytes,
    watchedByAnyone: r.watchedByAnyone,
    lastPlayedAnyAt: r.lastPlayedAnyAt,
    mediaType: r.mediaType,
    episodesPlayed: progress.get(r.titleId)?.episodesPlayed ?? null,
    episodesTotal: progress.get(r.titleId)?.episodesTotal ?? null,
    otherActiveClaimants: Math.max(0, (claimantCounts.get(r.titleId) ?? 1) - 1),
  }));

  // Usage = SUM(claim.charged_bytes) WHERE active=1, per this member's own
  // claims only (wiki/Feature-03-Usage-Accounting.md "The model") …
  const rawUsedBytes = claimRows.reduce((sum, r) => sum + r.chargedBytes, 0);

  // … minus anything already scheduled for deletion (`FR-DEL-27`, "credit on
  // schedule"). The claim rows themselves are deliberately left alone: the
  // files are still on disk and attribution still says they are this
  // member's, so the titles list keeps showing them. Only the headline
  // number moves — and `PendingDeletionsPane` says so on the same screen, so
  // the two can't be read as contradicting each other.
  const scheduled = loadScheduledDeletionsForMember(db, ssoUsername);
  const titleNameById = new Map(claimRows.map((r) => [r.titleId, r.name]));
  const pendingDeletions: PendingDeletion[] = scheduled.map((row) => ({
    deletionId: row.id,
    titleId: row.titleId,
    name: titleNameById.get(row.titleId) ?? row.titleId,
    bytesClaimed: row.bytesClaimed,
    scheduledFor: row.scheduledFor,
  }));
  const pendingDeletionBytes = scheduled.reduce((sum, r) => sum + r.bytesClaimed, 0);
  const usedBytes = Math.max(0, rawUsedBytes - pendingDeletionBytes);

  const quotaRow = db.select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, ssoUsername)).get();
  // `FR-POL-2a`: resolved at read time from BOTH the stored override and the current global default.
  const quota = resolveEffectiveQuota(quotaRow?.quotaBytes ?? null, getGlobalDefaultQuotaBytes(db));
  const quotaNote = quotaRow?.note ?? null;

  return {
    kind: 'ok',
    quota,
    quotaNote,
    pendingDeletions,
    pendingDeletionBytes,
    usedBytes,
    titles,
    snapshotAt: snapshot.finishedAt,
    staleAfterSeconds: loadStaleThresholdSeconds(db),
  };
}
