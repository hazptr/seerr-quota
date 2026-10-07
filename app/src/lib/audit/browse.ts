/**
 * Read-only, filtered, server-side-PAGINATED access to the `audit` table —
 * `FR-AUD-9` (operator browse + CSV/JSONL export, `wiki/Feature-08-Audit-
 * Log.md`) and `FR-AUD-10` (a member's own history). Added here (rather than
 * under `src/app/admin/audit/_data/**` alone) because the exact same query
 * shape is needed from THREE call sites — the operator browse page, the
 * operator export route, and the member's own `/history` page — and "read
 * the append-only audit log, paginated, with filters" is squarely audit-log
 * domain logic, the same reasoning `./write.ts`'s existing
 * `readAuditRowsByCorrelationId` read helper already established. Reported
 * as a `src/lib/audit/**` addition in the project notes, per its
 * constraint that this directory is otherwise off-limits except for a read
 * helper that "genuinely belongs" here.
 *
 * Strictly READ. Nothing in this file ever calls `.insert()`/`.update()`/
 * `.delete()` against `audit` — the append-only guard
 * (`test/audit-append-only.test.ts`, AGENTS.md rule 4) covers this file too.
 *
 * Every query here takes an explicit `limit`/`offset` and every caller is
 * expected to page through results — `wiki/Feature-08-Audit-Log.md`'s "the
 * table grows forever by design" and the project's design ("never load it all
 * into the browser, and never build an export that materialises the whole
 * table in memory"). `forEachAuditRowBatch` is the bounded-memory primitive
 * the export route uses instead of ever calling `.all()` with no limit.
 */
import { and, desc, eq, gte, lte, or, sql, type SQL } from 'drizzle-orm';
import type { SeerrQuotaDb } from '@/lib/db';
import { audit } from '@/lib/db/schema';
import type { Outcome, TargetType } from './actions';

/** The full, raw persisted shape of one `audit` row — `before`/`after`/`detail` are still the redacted, size-capped JSON TEXT `./write.ts` stored (never re-parsed here; callers decide whether/how to parse, since the operator export wants the raw text and the member-safe view wants to parse-then-allow-list). */
export type RawAuditRow = typeof audit.$inferSelect;

export interface AuditBrowseFilter {
  actor?: string;
  action?: string;
  targetType?: TargetType;
  targetId?: string;
  outcome?: Outcome;
  /** Unix ms, inclusive lower bound. */
  fromTs?: number;
  /** Unix ms, inclusive upper bound. */
  toTs?: number;
}

function buildWhere(filter: AuditBrowseFilter): SQL | undefined {
  const clauses: SQL[] = [];
  if (filter.actor) clauses.push(eq(audit.actor, filter.actor));
  if (filter.action) clauses.push(eq(audit.action, filter.action));
  if (filter.targetType) clauses.push(eq(audit.targetType, filter.targetType));
  if (filter.targetId) clauses.push(eq(audit.targetId, filter.targetId));
  if (filter.outcome) clauses.push(eq(audit.outcome, filter.outcome));
  if (filter.fromTs !== undefined) clauses.push(gte(audit.ts, filter.fromTs));
  if (filter.toTs !== undefined) clauses.push(lte(audit.ts, filter.toTs));
  return clauses.length > 0 ? and(...clauses) : undefined;
}

/** `FR-AUD-9`'s filtered COUNT — always paired with `queryAuditRowsPage` so a caller can compute page count without ever selecting more than one page of rows. */
export function countAuditRows(db: SeerrQuotaDb, filter: AuditBrowseFilter): number {
  const where = buildWhere(filter);
  const query = db.select({ count: sql<number>`count(*)` }).from(audit);
  return (where ? query.where(where) : query).get()?.count ?? 0;
}

/** `FR-AUD-9`'s filtered, paginated read — newest first (ties broken by `id` descending, so pagination stays stable even for two rows sharing one `ts`). */
export function queryAuditRowsPage(db: SeerrQuotaDb, filter: AuditBrowseFilter, limit: number, offset: number): RawAuditRow[] {
  const where = buildWhere(filter);
  const query = db.select().from(audit).orderBy(desc(audit.ts), desc(audit.id));
  return (where ? query.where(where) : query).limit(limit).offset(offset).all();
}

/**
 * Streams every row matching `filter` in fixed-size batches (newest first,
 * same order as `queryAuditRowsPage`), calling `onBatch` once per batch and
 * never holding more than `batchSize` rows in memory at once — the export
 * route's bounded-memory primitive (the project's design: "never build an
 * export that materialises the whole table in memory"). Returns the total
 * row count actually streamed.
 */
export async function forEachAuditRowBatch(
  db: SeerrQuotaDb,
  filter: AuditBrowseFilter,
  batchSize: number,
  onBatch: (rows: RawAuditRow[]) => void | Promise<void>,
): Promise<number> {
  let offset = 0;
  let total = 0;
  for (;;) {
    const rows = queryAuditRowsPage(db, filter, batchSize, offset);
    if (rows.length === 0) break;
    await onBatch(rows);
    total += rows.length;
    if (rows.length < batchSize) break;
    offset += rows.length;
  }
  return total;
}

/**
 * `FR-AUD-10`'s scope: rows where `username` is the `actor` OR the
 * `on_behalf_of` target — the SAME convention
 * `src/app/admin/members/[username]/_data/memberDetail.ts`'s `loadAuditPage`
 * already established for the operator's per-member drill-down (P2-5),
 * reused here (not imported from there — that file selects a narrower
 * column set for a different, operator-facing screen) for a member's own
 * view of their own history.
 */
export function ownAuditWhere(username: string): SQL {
  return or(eq(audit.actor, username), eq(audit.onBehalfOf, username))!;
}

export function countOwnAuditRows(db: SeerrQuotaDb, username: string): number {
  return db
    .select({ count: sql<number>`count(*)` })
    .from(audit)
    .where(ownAuditWhere(username))
    .get()?.count ?? 0;
}

export function queryOwnAuditRowsPage(db: SeerrQuotaDb, username: string, limit: number, offset: number): RawAuditRow[] {
  return db.select().from(audit).where(ownAuditWhere(username)).orderBy(desc(audit.ts), desc(audit.id)).limit(limit).offset(offset).all();
}
