/**
 * Impure shell for the operator audit browse page (`FR-AUD-9`, P2-7).
 * Server-side PAGINATED (the project's design: "the table grows forever by
 * design — never load it all into the browser"): one `COUNT(*)` plus one
 * `LIMIT`/`OFFSET` read via `@/lib/audit`'s `countAuditRows`/
 * `queryAuditRowsPage`, same shape `src/app/admin/members/[username]/_data/
 * memberDetail.ts`'s per-section loaders already use. Read-only — no writes
 * anywhere in this file, matching every other `_data/**` loader in this app.
 */
import { getDb } from '@/lib/db';
import { countAuditRows, queryAuditRowsPage, type AuditBrowseFilter, type RawAuditRow } from '@/lib/audit';
import { paginationMeta, type PageMeta } from '@/components/admin/logic';

const PAGE_SIZE = 25;

export interface AuditBrowseResult {
  rows: RawAuditRow[];
  meta: PageMeta;
}

export async function loadAuditBrowse(filter: AuditBrowseFilter, page: number): Promise<AuditBrowseResult> {
  const db = getDb();
  const totalCount = countAuditRows(db, filter);
  const meta = paginationMeta(page, PAGE_SIZE, totalCount);
  const rows = queryAuditRowsPage(db, filter, meta.pageSize, meta.offset);
  return { rows, meta };
}
