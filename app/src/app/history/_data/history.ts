/**
 * Impure shell for `FR-AUD-10` — a member's own audit history. Scope is
 * `@/lib/audit`'s `ownAuditWhere` (`actor = username OR on_behalf_of =
 * username`), server-side PAGINATED (same discipline as every other
 * `_data/**` loader in this app — never load the whole log into the
 * browser), and every row is passed through `toMemberSafeAuditRow`
 * (`@/lib/audit`) BEFORE it leaves this function — nothing downstream of
 * `loadOwnAuditHistory` ever sees a raw `before`/`after`/`detail` blob
 * (`FR-DEL-4a` x `FR-AUD-10`, see `src/lib/audit/memberSafe.ts`'s header
 * comment for why that matters).
 */
import { getDb } from '@/lib/db';
import { countOwnAuditRows, queryOwnAuditRowsPage, toMemberSafeAuditRow, type MemberSafeAuditRow } from '@/lib/audit';
import { paginationMeta, type PageMeta } from '@/components/admin/logic';

const PAGE_SIZE = 25;

export interface OwnAuditHistoryResult {
  rows: MemberSafeAuditRow[];
  meta: PageMeta;
}

export async function loadOwnAuditHistory(username: string, page: number): Promise<OwnAuditHistoryResult> {
  const db = getDb();
  const totalCount = countOwnAuditRows(db, username);
  const meta = paginationMeta(page, PAGE_SIZE, totalCount);
  const rawRows = queryOwnAuditRowsPage(db, username, meta.pageSize, meta.offset);
  const rows = rawRows.map((row) => toMemberSafeAuditRow(row, username));
  return { rows, meta };
}
