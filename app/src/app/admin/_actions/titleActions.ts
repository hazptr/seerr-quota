/**
 * `FR-ADM-7` — protect/unprotect a title, with an operator-supplied reason.
 * That reason is later shown, verbatim, to the member whose deletion it
 * blocks (`wiki/Feature-06-Self-Service-Deletion.md`'s guard surface) — it is
 * user-facing copy, not an internal operator note, which is why an empty
 * reason is rejected on `protect` (there is nothing to show the member) but
 * not required on `unprotect` (there is nothing left to show once the pin is
 * lifted).
 *
 * Impure shell: both writes go through `withAudit` (`@/lib/audit`) so
 * `title.protected`/`title.protected_reason` can never change without its
 * `title.protected`/`title.unprotected` audit row landing in the SAME
 * transaction (`FR-AUD-8`). Lives under `app/src/app/admin/_actions/`
 * (this task's own scope) rather than `src/lib/**` — no existing module in
 * this codebase owns title mutations, and every plausible `src/lib/**` home
 * (`library`, `attribution`, ...) is out of this task's scope to touch.
 */
import { eq } from 'drizzle-orm';
import { withAudit } from '@/lib/audit';
import type { SeerrQuotaDb } from '@/lib/db';
import { title } from '@/lib/db/schema';

interface TitleProtectionRow {
  protected: boolean;
  protectedReason: string | null;
}

function loadProtectionRow(db: SeerrQuotaDb, titleId: string): TitleProtectionRow | undefined {
  return db.select({ protected: title.protected, protectedReason: title.protectedReason }).from(title).where(eq(title.id, titleId)).get();
}

export type ProtectTitleOutcome =
  | { kind: 'ok'; titleId: string; reason: string }
  | { kind: 'not_found' }
  | { kind: 'invalid'; reason: string };

export function protectTitle(db: SeerrQuotaDb, input: { titleId: string; reason: string; actor: string }): ProtectTitleOutcome {
  const reason = input.reason.trim();
  if (reason.length === 0) {
    return { kind: 'invalid', reason: 'a reason is required — it is shown to the member whose deletion it blocks' };
  }

  const existing = loadProtectionRow(db, input.titleId);
  if (!existing) return { kind: 'not_found' };

  withAudit(db, ({ tx, audit }) => {
    tx.update(title).set({ protected: true, protectedReason: reason }).where(eq(title.id, input.titleId)).run();
    audit({
      actor: input.actor,
      actorRole: 'operator',
      action: 'title.protected',
      targetType: 'title',
      targetId: input.titleId,
      before: { protected: existing.protected, protectedReason: existing.protectedReason },
      after: { protected: true, protectedReason: reason },
      outcome: 'ok',
      source: 'ui',
    });
  });

  return { kind: 'ok', titleId: input.titleId, reason };
}

export type UnprotectTitleOutcome = { kind: 'ok'; titleId: string } | { kind: 'not_found' };

export function unprotectTitle(db: SeerrQuotaDb, input: { titleId: string; actor: string }): UnprotectTitleOutcome {
  const existing = loadProtectionRow(db, input.titleId);
  if (!existing) return { kind: 'not_found' };

  withAudit(db, ({ tx, audit }) => {
    tx.update(title).set({ protected: false, protectedReason: null }).where(eq(title.id, input.titleId)).run();
    audit({
      actor: input.actor,
      actorRole: 'operator',
      action: 'title.unprotected',
      targetType: 'title',
      targetId: input.titleId,
      before: { protected: existing.protected, protectedReason: existing.protectedReason },
      after: { protected: false, protectedReason: null },
      outcome: 'ok',
      source: 'ui',
    });
  });

  return { kind: 'ok', titleId: input.titleId };
}
