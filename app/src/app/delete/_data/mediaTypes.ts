/**
 * Tiny impure shell for the delete flow's title-level display fields that
 * `@/lib/deletion`'s `planDeletionItems` deliberately doesn't return (it
 * only returns what authorization/execution need — see `plan.ts`'s own
 * header comment): `mediaType` (for the "whole series, not one season"
 * warning, `wiki/Feature-06-Self-Service-Deletion.md` "Interactions") and
 * `watchedByAnyone`/`lastPlayedAnyAt` (for the per-title "someone else has
 * played this" warning, `FR-DEL-6`). Deliberately separate from
 * `@/app/_data/memberDashboard.ts` (P1-8's already-tested contract, not
 * touched by this task) rather than adding fields to its `MemberTitleRow`
 * shape, and reused identically across all three delete-flow screens
 * (select/review/confirm) so their warnings never disagree.
 *
 * `titleIds` MUST already be filtered to ids the caller has confirmed
 * standing on (e.g. `DeletionPlanItem.found === true`, from
 * `planDeletionItems`) — this function itself does no claim/ownership
 * check. None of these three fields carry attribution information (who
 * else claims/watched it), only "is this a TV title" and "has ANYONE ever
 * played it" — both already denormalised, non-identifying columns on
 * `title` itself — so querying by a pre-authorized id list keeps this file
 * boring rather than a second, easy-to-miss place that needs its own IDOR
 * reasoning.
 */
import { inArray } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { title } from '@/lib/db/schema';
import { loadEpisodeProgress } from '@/lib/playback/progress';

export interface TitleDisplayFields {
  mediaType: 'movie' | 'tv';
  watchedByAnyone: boolean;
  lastPlayedAnyAt: number | null;
  /** Furthest-progressed viewer's episode count, so the per-title warning can say how MUCH was watched (`@/lib/playback/watchState`). Aggregate across viewers, carrying no per-person information — same non-identifying standard as the other fields here. */
  episodesPlayed: number | null;
  episodesTotal: number | null;
}

export type TitleDisplayFieldsMap = ReadonlyMap<string, TitleDisplayFields>;

export function loadTitleDisplayFields(titleIds: readonly string[]): TitleDisplayFieldsMap {
  if (titleIds.length === 0) return new Map();
  const db = getDb();
  const rows = db
    .select({ id: title.id, mediaType: title.mediaType, watchedByAnyone: title.watchedByAnyone, lastPlayedAnyAt: title.lastPlayedAnyAt })
    .from(title)
    .where(inArray(title.id, [...titleIds]))
    .all();
  const progress = loadEpisodeProgress(db, rows.map((r) => r.id));
  return new Map(
    rows.map((r) => [
      r.id,
      {
        mediaType: r.mediaType,
        watchedByAnyone: r.watchedByAnyone,
        lastPlayedAnyAt: r.lastPlayedAnyAt,
        episodesPlayed: progress.get(r.id)?.episodesPlayed ?? null,
        episodesTotal: progress.get(r.id)?.episodesTotal ?? null,
      },
    ]),
  );
}
