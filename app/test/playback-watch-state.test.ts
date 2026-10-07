/**
 * The three-state watched label. The regression that prompted this: a
 * long-running series showed as `watched` after only a couple of its
 * episodes had been seen. The fixtures below mirror realistic series sizes,
 * because the point of this module is that the boolean is
 * *technically correct and practically misleading* — synthetic 1-of-2 cases
 * would not show why it mattered.
 */
import { describe, expect, it } from 'vitest';
import { deriveWatchState, watchStateLabel, watchStateSentence } from '@/lib/playback/watchState';

describe('deriveWatchState — the FR-ACCT-6 boolean is not a label', () => {
  it('the reported case: 2 of 20 episodes of a series is partly watched, not watched', () => {
    const state = deriveWatchState({ watchedByAnyone: true, mediaType: 'tv', episodesPlayed: 2, episodesTotal: 20 });
    expect(state).toEqual({ kind: 'partly_watched', episodesPlayed: 2, episodesTotal: 20 });
    expect(watchStateLabel(state)).toBe('2/20 eps');
  });

  it.each([
    ['Example Series A', 1, 89],
    ['Example Series B', 1, 84],
    ['Example Series C', 1, 134],
    ['Example Series D', 1, 123],
    ['Example Series E', 11, 234],
  ])('%s (%i of %i) — large long-running titles, all previously mislabelled "watched"', (_name, played, total) => {
    expect(deriveWatchState({ watchedByAnyone: true, mediaType: 'tv', episodesPlayed: played, episodesTotal: total }).kind).toBe('partly_watched');
  });

  it('a series with every episode played IS watched', () => {
    expect(deriveWatchState({ watchedByAnyone: true, mediaType: 'tv', episodesPlayed: 20, episodesTotal: 20 }).kind).toBe('watched');
  });

  it('a played movie is watched — episode counts are null and must not make it "partly"', () => {
    expect(deriveWatchState({ watchedByAnyone: true, mediaType: 'movie', episodesPlayed: null, episodesTotal: null }).kind).toBe('watched');
  });

  it('nothing played is unwatched, whatever the episode counts say', () => {
    expect(deriveWatchState({ watchedByAnyone: false, mediaType: 'tv', episodesPlayed: 0, episodesTotal: 20 }).kind).toBe('unwatched');
    expect(watchStateLabel({ kind: 'unwatched' })).toBe('unwatched');
  });

  it('zero episodes played but flagged watched falls back to `watched`, never a nonsense "0/20"', () => {
    // Reachable if the denormalised flag and the per-user rows disagree
    // (a re-sync mid-flight). Overstating is the safe direction for a label
    // whose job is to discourage a careless delete.
    expect(deriveWatchState({ watchedByAnyone: true, mediaType: 'tv', episodesPlayed: 0, episodesTotal: 20 }).kind).toBe('watched');
  });

  it('missing episode counts fall back to `watched` rather than inventing progress', () => {
    expect(deriveWatchState({ watchedByAnyone: true, mediaType: 'tv', episodesPlayed: null, episodesTotal: null }).kind).toBe('watched');
    expect(deriveWatchState({ watchedByAnyone: true, mediaType: 'tv', episodesPlayed: 3, episodesTotal: 0 }).kind).toBe('watched');
  });

  it('more episodes played than total (a series that shrank upstream) is watched, not a >100% fraction', () => {
    expect(deriveWatchState({ watchedByAnyone: true, mediaType: 'tv', episodesPlayed: 25, episodesTotal: 20 }).kind).toBe('watched');
  });
});

describe('watchStateSentence — the delete-flow warning says how much', () => {
  it('names both the seen and the unseen count, so 1-of-89 cannot read like a finished show', () => {
    const sentence = watchStateSentence(deriveWatchState({ watchedByAnyone: true, mediaType: 'tv', episodesPlayed: 1, episodesTotal: 89 }));
    expect(sentence).toContain('1 of 89');
    expect(sentence).toContain('88');
  });

  it('an unwatched title produces no warning at all', () => {
    expect(watchStateSentence({ kind: 'unwatched' })).toBeNull();
  });

  it('a fully watched title keeps the original wording', () => {
    expect(watchStateSentence({ kind: 'watched' })).toBe('Someone else has played this title at some point.');
  });
});
