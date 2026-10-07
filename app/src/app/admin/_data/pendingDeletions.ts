/**
 * Fleet-wide pending deletions for the operator dashboard (`FR-ADM-15`).
 *
 * The operator needs this for two reasons the member view doesn't cover:
 * seeing what is about to leave the library before it does, and being able
 * to cancel a member's mistaken deletion on their behalf — including the
 * case where the member themselves cannot, because cancelling would put
 * them back over quota (`FR-DEL-28`).
 */
import { getDb } from '@/lib/db';
import { title } from '@/lib/db/schema';
import { loadAllScheduledDeletions } from '@/lib/deletion';
import { inArray } from 'drizzle-orm';

export interface AdminPendingDeletion {
  deletionId: number;
  titleId: string;
  name: string;
  owner: string;
  bytesClaimed: number;
  scheduledFor: number;
}

export function loadPendingDeletions(): AdminPendingDeletion[] {
  const db = getDb();
  const rows = loadAllScheduledDeletions(db);
  if (rows.length === 0) return [];

  // Names come from `title`, not from the member's claim rows: an operator
  // must still see a pending deletion whose claim has since been dropped by
  // attribution, which is exactly the state most worth noticing.
  const names = new Map(
    db
      .select({ id: title.id, name: title.title })
      .from(title)
      .where(inArray(title.id, [...new Set(rows.map((r) => r.titleId))]))
      .all()
      .map((r) => [r.id, r.name]),
  );

  return rows.map((r) => ({
    deletionId: r.id,
    titleId: r.titleId,
    name: names.get(r.titleId) ?? r.titleId,
    owner: r.ssoUsername,
    bytesClaimed: r.bytesClaimed,
    scheduledFor: r.scheduledFor,
  }));
}
