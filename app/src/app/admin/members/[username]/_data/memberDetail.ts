/**
 * Impure shell for the member drill-down (`FR-ADM-5`: "the operator MUST be
 * able to drill into any member and see their full title list, claims,
 * decisions, and audit history"). Every list here is paginated SERVER-SIDE
 * (`or(FR-ADM-5's edge case: "a member drill-down must not load 500 rows
 * into the browser"`) — each section runs its own `COUNT(*)` plus a
 * `LIMIT`/`OFFSET` query, using `@/components/admin/logic`'s
 * `paginationMeta` for the page-math, so the DB (and the HTTP response) never
 * carries more than one page's worth of rows for that section.
 *
 * Read-only, same as `./_data/../dashboard.ts` — no writes anywhere in this
 * file. The member's title list already carries `protected`/
 * `protectedReason` (read-only here; toggling it is `FR-ADM-7`, a later
 * task) precisely so that wave can slot a control onto an existing column
 * rather than adding a new query.
 */
import { and, desc, eq, or, sql } from 'drizzle-orm';
import { getConfig } from '@/lib/config';
import { getDb, type SeerrQuotaDb } from '@/lib/db';
import { appSetting, audit, claim, member, quotaPolicy, requestDecision, syncRun, title } from '@/lib/db/schema';
import { resolveEffectiveQuota, type EffectiveQuota } from '@/lib/members/quota';
import { getGlobalDefaultQuotaBytes } from '@/lib/quota/policy';
import { findLatestAttributionSnapshot, resolveNumericRuntimeSetting } from '@/components/member/logic';
import { paginationMeta, type PageMeta } from '@/components/admin/logic';
import { loadEpisodeProgress } from '@/lib/playback/progress';

const PAGE_SIZE = 20;

export interface MemberDetailHeader {
  ssoUsername: string;
  displayName: string | null;
  email: string | null;
  entitled: boolean;
  isOperator: boolean;
  syncStatus: 'matched' | 'no_seerr_account' | 'not_entitled' | 'ambiguous';
  syncNote: string | null;
  /** Set once an `AUTH_EMAIL_HEADER` fallback login resolved to this member (`src/lib/auth/memberGate.ts`). Operator-clearable via `POST /api/admin/members/clear-alias` (`member.alias_cleared`) — the alias is a trust decision, so undoing it is an explicit operator action, not automatic. */
  loginAlias: string | null;
  quota: EffectiveQuota;
  quotaSource: 'default' | 'override' | null;
  quotaNote: string | null;
  usedBytes: number | null;
  firstSeenAt: number;
  lastSyncedAt: number;
}

export interface MemberClaimRow {
  titleId: string;
  titleName: string;
  year: number | null;
  chargedBytes: number;
  active: boolean;
  createdAt: number;
  releasedAt: number | null;
  releasedBy: string | null;
  watchedByAnyone: boolean;
  lastPlayedAnyAt: number | null;
  /** For the three-state watched label — a part-watched series is not "watched" (`@/lib/playback/watchState`). */
  mediaType: 'movie' | 'tv';
  episodesPlayed: number | null;
  episodesTotal: number | null;
  protected: boolean;
  protectedReason: string | null;
}

export interface MemberDecisionRow {
  seerrRequestId: number;
  decision: 'approve' | 'hold' | 'decline' | 'skip';
  reason: string;
  enforced: boolean;
  usageBytes: number | null;
  quotaBytes: number | null;
  source: 'webhook' | 'poller' | 'manual';
  seerrStatus: number | null;
  heldSince: number | null;
  notifiedAt: number | null;
  decidedAt: number;
}

export interface MemberAuditRow {
  id: number;
  ts: number;
  actor: string;
  actorRole: 'member' | 'operator' | 'system';
  onBehalfOf: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  outcome: 'ok' | 'denied' | 'error';
  source: string;
}

/** `FR-ADM-13`: "Every screen MUST carry the snapshot timestamp and a clear staleness indicator" — the same attribution snapshot the member table/fleet totals are grounded in, applied here too so `header.usedBytes` carries the same freshness guarantee. `attributionSnapshotAt: null` means no attribution reconcile has EVER completed (matches `@/app/admin/_data/dashboard.ts`'s `no_data` gate, but a member page still has plenty else worth showing even then, so this degrades to "no snapshot yet" rather than blocking the whole page). */
export interface SnapshotInfo {
  attributionSnapshotAt: number | null;
  staleAfterSeconds: number;
}

export type MemberDetailResult =
  | { kind: 'not_found' }
  | {
      kind: 'ok';
      header: MemberDetailHeader;
      snapshot: SnapshotInfo;
      claims: { rows: MemberClaimRow[]; meta: PageMeta };
      decisions: { rows: MemberDecisionRow[]; meta: PageMeta };
      auditRows: { rows: MemberAuditRow[]; meta: PageMeta };
    };

function loadHeader(db: SeerrQuotaDb, ssoUsername: string): MemberDetailHeader | undefined {
  const row = db.select().from(member).where(eq(member.ssoUsername, ssoUsername)).get();
  if (!row) return undefined;

  const quotaRow = db.select().from(quotaPolicy).where(eq(quotaPolicy.ssoUsername, ssoUsername)).get();
  // `FR-POL-2a`: resolved at read time from BOTH the stored override and the current global default.
  const quota = resolveEffectiveQuota(quotaRow?.quotaBytes ?? null, getGlobalDefaultQuotaBytes(db));

  const usedBytes =
    row.syncStatus === 'matched'
      ? (db
          .select({ total: sql<number>`coalesce(sum(${claim.chargedBytes}), 0)` })
          .from(claim)
          .where(and(eq(claim.ssoUsername, ssoUsername), eq(claim.active, true)))
          .get()?.total ?? 0)
      : null;

  return {
    ssoUsername: row.ssoUsername,
    displayName: row.displayName,
    email: row.email,
    entitled: row.entitled,
    isOperator: row.isOperator,
    syncStatus: row.syncStatus,
    syncNote: row.syncNote,
    loginAlias: row.loginAlias,
    quota,
    quotaSource: quotaRow?.source ?? null,
    quotaNote: quotaRow?.note ?? null,
    usedBytes,
    firstSeenAt: row.firstSeenAt,
    lastSyncedAt: row.lastSyncedAt,
  };
}

function loadClaimsPage(db: SeerrQuotaDb, ssoUsername: string, page: number): { rows: MemberClaimRow[]; meta: PageMeta } {
  const totalCount = db.select({ count: sql<number>`count(*)` }).from(claim).where(eq(claim.ssoUsername, ssoUsername)).get()?.count ?? 0;
  const meta = paginationMeta(page, PAGE_SIZE, totalCount);

  const rows = db
    .select({
      titleId: claim.titleId,
      titleName: title.title,
      year: title.year,
      chargedBytes: claim.chargedBytes,
      active: claim.active,
      createdAt: claim.createdAt,
      releasedAt: claim.releasedAt,
      releasedBy: claim.releasedBy,
      watchedByAnyone: title.watchedByAnyone,
      lastPlayedAnyAt: title.lastPlayedAnyAt,
      mediaType: title.mediaType,
      protected: title.protected,
      protectedReason: title.protectedReason,
    })
    .from(claim)
    .innerJoin(title, eq(claim.titleId, title.id))
    .where(eq(claim.ssoUsername, ssoUsername))
    // Largest first (what's worth deleting), active claims before released
    // ones; createdAt only breaks ties between equal-size claims — it is not
    // the primary key, unlike this query's old desc(createdAt)-only order.
    .orderBy(desc(claim.active), desc(claim.chargedBytes), desc(claim.createdAt))
    .limit(meta.pageSize)
    .offset(meta.offset)
    .all();

  // Episode progress for the page's titles only — the claims list is paged, so
  // this never loads the whole `playback` table.
  const progress = loadEpisodeProgress(db, rows.map((r) => r.titleId));
  const withProgress: MemberClaimRow[] = rows.map((r) => ({
    ...r,
    episodesPlayed: progress.get(r.titleId)?.episodesPlayed ?? null,
    episodesTotal: progress.get(r.titleId)?.episodesTotal ?? null,
  }));

  return { rows: withProgress, meta };
}

function loadDecisionsPage(db: SeerrQuotaDb, ssoUsername: string, page: number): { rows: MemberDecisionRow[]; meta: PageMeta } {
  const totalCount = db.select({ count: sql<number>`count(*)` }).from(requestDecision).where(eq(requestDecision.ssoUsername, ssoUsername)).get()?.count ?? 0;
  const meta = paginationMeta(page, PAGE_SIZE, totalCount);

  const rows = db
    .select()
    .from(requestDecision)
    .where(eq(requestDecision.ssoUsername, ssoUsername))
    .orderBy(desc(requestDecision.decidedAt))
    .limit(meta.pageSize)
    .offset(meta.offset)
    .all();

  return { rows, meta };
}

function loadAuditPage(db: SeerrQuotaDb, ssoUsername: string, page: number): { rows: MemberAuditRow[]; meta: PageMeta } {
  const whereClause = or(eq(audit.actor, ssoUsername), eq(audit.onBehalfOf, ssoUsername));
  const totalCount = db.select({ count: sql<number>`count(*)` }).from(audit).where(whereClause).get()?.count ?? 0;
  const meta = paginationMeta(page, PAGE_SIZE, totalCount);

  const rows = db
    .select({
      id: audit.id,
      ts: audit.ts,
      actor: audit.actor,
      actorRole: audit.actorRole,
      onBehalfOf: audit.onBehalfOf,
      action: audit.action,
      targetType: audit.targetType,
      targetId: audit.targetId,
      outcome: audit.outcome,
      source: audit.source,
    })
    .from(audit)
    .where(whereClause)
    .orderBy(desc(audit.ts))
    .limit(meta.pageSize)
    .offset(meta.offset)
    .all();

  return { rows, meta };
}

function loadSnapshotInfo(db: SeerrQuotaDb): SnapshotInfo {
  const rows = db.select({ id: syncRun.id, finishedAt: syncRun.finishedAt, steps: syncRun.steps }).from(syncRun).all();
  const snapshot = findLatestAttributionSnapshot(rows);
  const staleRow = db.select().from(appSetting).where(eq(appSetting.key, 'stale_snapshot_max_age_s')).get();
  const staleAfterSeconds = resolveNumericRuntimeSetting(staleRow, getConfig().runtime.staleSnapshotMaxAgeS);
  return { attributionSnapshotAt: snapshot?.finishedAt ?? null, staleAfterSeconds };
}

export interface MemberDetailPages {
  claimsPage?: number;
  decisionsPage?: number;
  auditPage?: number;
}

export async function loadMemberDetail(ssoUsername: string, pages: MemberDetailPages = {}): Promise<MemberDetailResult> {
  const db = getDb();

  const header = loadHeader(db, ssoUsername);
  if (!header) return { kind: 'not_found' };

  return {
    kind: 'ok',
    header,
    snapshot: loadSnapshotInfo(db),
    claims: loadClaimsPage(db, ssoUsername, pages.claimsPage ?? 1),
    decisions: loadDecisionsPage(db, ssoUsername, pages.decisionsPage ?? 1),
    auditRows: loadAuditPage(db, ssoUsername, pages.auditPage ?? 1),
  };
}
