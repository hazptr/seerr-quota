/**
 * Per-title episode progress, aggregated across viewers — the impure half of
 * `./watchState.ts`.
 *
 * `playback` is keyed per (title, user), so a series with three viewers has
 * three rows with different `episodes_played`. For "how much of this has
 * anyone seen", the honest collapse is **MAX**: the furthest-progressed
 * viewer. Summing would be nonsense (three people each watching episode 1
 * would read as 3 episodes watched), and averaging would understate the one
 * person actually watching it.
 *
 * `episodes_total` is the same for every viewer of a title (it is a property
 * of the series, not the person), so MAX over it is just "read the value".
 */
import { inArray, sql } from 'drizzle-orm';
import type { SeerrQuotaDb } from '@/lib/db';
import { playback } from '@/lib/db/schema';

export interface TitleEpisodeProgress {
  episodesPlayed: number | null;
  episodesTotal: number | null;
}

export type TitleEpisodeProgressMap = ReadonlyMap<string, TitleEpisodeProgress>;

export function loadEpisodeProgress(db: SeerrQuotaDb, titleIds: readonly string[]): TitleEpisodeProgressMap {
  if (titleIds.length === 0) return new Map();
  const rows = db
    .select({
      titleId: playback.titleId,
      episodesPlayed: sql<number | null>`max(${playback.episodesPlayed})`,
      episodesTotal: sql<number | null>`max(${playback.episodesTotal})`,
    })
    .from(playback)
    .where(inArray(playback.titleId, [...titleIds]))
    .groupBy(playback.titleId)
    .all();
  return new Map(rows.map((r) => [r.titleId, { episodesPlayed: r.episodesPlayed, episodesTotal: r.episodesTotal }]));
}
