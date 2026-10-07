/**
 * How much of a title has actually been watched, as a three-state value
 * rather than the binary `title.watched_by_anyone` boolean.
 *
 * ## Why this exists
 *
 * `FR-ACCT-6` makes a series count as played if **any** episode has been
 * played, and `title.watched_by_anyone` is that rule denormalised. The rule is
 * correct for what it was written for — the `recently_played` deletion guard
 * has to fail safe, and "somebody touched this recently" is exactly the signal
 * it needs. It is badly wrong as a **label**: rendering that boolean as
 * "watched" tells a member that a 438 GiB, 89-episode series they sampled once
 * has been watched, when 88 episodes are untouched.
 *
 * That is not cosmetic. The member's title list exists to answer "what can I
 * delete?", and the single largest reclaimable items in this library are
 * exactly the ones the binary mislabels — a member scanning for "unwatched"
 * skips straight past them.
 *
 * ## No new data
 *
 * `playback.episodes_played` / `episodes_total` have been captured since
 * `P1-4`; nothing surfaced them. This module is pure derivation over columns
 * that already exist, so it needs no re-sync and no schema change.
 *
 * ## What this does NOT change
 *
 * `title.watched_by_anyone` keeps its meaning and stays the guards' input.
 * The `in_progress` guard is already episode-aware (`guards.ts`:
 * `0 < episodesPlayed < episodesTotal`), so deletion safety was never
 * affected by this — only what the member was told.
 */

export type WatchState =
  /** Nobody has played any of it. */
  | { kind: 'unwatched' }
  /** A series somebody has started but not finished — the case the boolean got wrong. */
  | { kind: 'partly_watched'; episodesPlayed: number; episodesTotal: number }
  /** A played movie, or a series whose episodes have all been played. */
  | { kind: 'watched' };

export interface WatchStateInput {
  watchedByAnyone: boolean;
  mediaType?: 'movie' | 'tv' | null;
  /** Furthest-progressed viewer's episode count; `null` for movies or when unknown. */
  episodesPlayed?: number | null;
  /** The series' episode count at last sync; `null` for movies or when unknown. */
  episodesTotal?: number | null;
}

export function deriveWatchState(input: WatchStateInput): WatchState {
  if (!input.watchedByAnyone) return { kind: 'unwatched' };

  const played = input.episodesPlayed;
  const total = input.episodesTotal;

  // Only a series can be partly watched, and only when we actually know both
  // numbers. Missing counts fall through to `watched` — the status quo, and
  // the safe direction for a label whose job is to discourage careless
  // deletion: overstating how much has been seen never encourages a delete.
  if (input.mediaType === 'tv' && played != null && total != null && total > 0 && played > 0 && played < total) {
    return { kind: 'partly_watched', episodesPlayed: played, episodesTotal: total };
  }

  return { kind: 'watched' };
}

/** Compact table-cell label. Deliberately shows the raw fraction — "partly watched" alone would still hide the difference between 1 of 89 and 88 of 89. */
export function watchStateLabel(state: WatchState): string {
  switch (state.kind) {
    case 'unwatched':
      return 'unwatched';
    case 'partly_watched':
      return `${state.episodesPlayed}/${state.episodesTotal} eps`;
    case 'watched':
      return 'watched';
  }
}

/** Longer phrasing for the delete flow's per-title warning, where there is room for a sentence. */
export function watchStateSentence(state: WatchState): string | null {
  switch (state.kind) {
    case 'unwatched':
      return null;
    case 'partly_watched':
      return `Someone has watched ${state.episodesPlayed} of ${state.episodesTotal} episodes — the other ${state.episodesTotal - state.episodesPlayed} have never been played.`;
    case 'watched':
      return 'Someone else has played this title at some point.';
  }
}
