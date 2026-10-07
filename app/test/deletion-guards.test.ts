import { describe, expect, it } from 'vitest';
import { DELETION_GUARDS, firedGuards, inProgressGuard, isPlaybackSnapshotStale, recentlyPlayedGuard, runDeletionGuards, type DeletionGuard, type GuardContext, type InProgressSignal } from '@/lib/deletion/guards';

const DAY = 86_400;

function ctx(overrides: Partial<GuardContext> = {}): GuardContext {
  return {
    title: { watchedByAnyone: false, lastPlayedAnyAt: null },
    nowSeconds: 1_800_000_000,
    deleteRecentPlayDays: 14,
    deleteInProgressDays: 90,
    recentPlayerUsernames: [],
    recentUnlinkedPlay: false,
    subjectUsername: null,
    inProgressSignals: [],
    playbackUnavailable: false,
    ...overrides,
  };
}

describe('recentlyPlayedGuard (FR-DEL-4)', () => {
  it('does not fire when nobody has ever played it', () => {
    const result = recentlyPlayedGuard(ctx({ title: { watchedByAnyone: false, lastPlayedAnyAt: null } }));
    expect(result).toEqual({ guardId: 'recently_played', fired: false });
  });

  it('FR-DEL-19: FIRES (fail-safe, unavailable) when watchedByAnyone is true but lastPlayedAnyAt is null — "played, time unknown" is not "nobody watching"', () => {
    // This is reachable in practice (playback/sync.ts can set
    // watchedByAnyone from a per-user aggregate whose own lastPlayedAt is
    // null) and MUST block, not allow: absence of a timestamp is not
    // evidence nobody is watching. A prior version of this test asserted
    // fired:false here — that was pinning the bug FR-DEL-19 exists to fix,
    // not a real requirement.
    const result = recentlyPlayedGuard(ctx({ title: { watchedByAnyone: true, lastPlayedAnyAt: null } }));
    expect(result.fired).toBe(true);
    expect(result.unavailable).toBe(true);
    expect(result.memberMessage).toBeDefined();
  });

  it('fires when played exactly at the boundary (age === window, inclusive)', () => {
    const now = 1_800_000_000;
    const result = recentlyPlayedGuard(
      ctx({ nowSeconds: now, deleteRecentPlayDays: 14, title: { watchedByAnyone: true, lastPlayedAnyAt: now - 14 * DAY } }),
    );
    expect(result.fired).toBe(true);
  });

  it('does not fire one second past the boundary', () => {
    const now = 1_800_000_000;
    const result = recentlyPlayedGuard(
      ctx({ nowSeconds: now, deleteRecentPlayDays: 14, title: { watchedByAnyone: true, lastPlayedAnyAt: now - 14 * DAY - 1 } }),
    );
    expect(result.fired).toBe(false);
  });

  it('fires with member-facing message/detail that never names who (FR-DEL-4a)', () => {
    const now = 1_800_000_000;
    const result = recentlyPlayedGuard(
      ctx({
        nowSeconds: now,
        deleteRecentPlayDays: 14,
        title: { watchedByAnyone: true, lastPlayedAnyAt: now - DAY },
        recentPlayerUsernames: ['erin'],
      }),
    );
    expect(result.fired).toBe(true);
    expect(result.memberMessage).toBeDefined();
    expect(result.memberMessage).not.toContain('erin');
    expect(JSON.stringify(result.memberDetail)).not.toContain('erin');
  });

  it('fires with operator-facing message/detail that DOES name who, when resolvable (FR-DEL-4a)', () => {
    const now = 1_800_000_000;
    const result = recentlyPlayedGuard(
      ctx({
        nowSeconds: now,
        deleteRecentPlayDays: 14,
        title: { watchedByAnyone: true, lastPlayedAnyAt: now - DAY },
        recentPlayerUsernames: ['erin'],
      }),
    );
    expect(result.operatorMessage).toContain('erin');
    expect(result.operatorDetail?.playedBy).toEqual(['erin']);
  });

  it('operator message degrades gracefully when nobody resolves to a linked member', () => {
    const now = 1_800_000_000;
    const result = recentlyPlayedGuard(
      ctx({ nowSeconds: now, deleteRecentPlayDays: 14, title: { watchedByAnyone: true, lastPlayedAnyAt: now - DAY }, recentPlayerUsernames: [] }),
    );
    expect(result.fired).toBe(true);
    expect(result.operatorMessage).toBeDefined();
    expect(result.operatorDetail?.playedBy).toEqual([]);
  });
});

describe('DELETION_GUARDS (FR-DEL-4b — the extensible seam)', () => {
  it('today contains recently_played and in_progress — active_session is the documented future seam, not built here', () => {
    expect(DELETION_GUARDS.map((g) => g(ctx()).guardId)).toEqual(['recently_played', 'in_progress']);
  });
});

describe('FR-DEL-21 — missing/stale playback data MUST block every playback-dependent guard, not silently allow', () => {
  it('recentlyPlayedGuard fires (unavailable) when playbackUnavailable is true, even though title.watchedByAnyone is false', () => {
    // This is the EXACT shape of the deployed bug: the playback step failed
    // outright (readonly-DB error), wrote nothing, and every title's
    // watched_by_anyone sat at its schema default (false). Before this fix,
    // that read as "confirmed nobody watched it" — a fail-open across the
    // whole library.
    const result = recentlyPlayedGuard(ctx({ playbackUnavailable: true, title: { watchedByAnyone: false, lastPlayedAnyAt: null } }));
    expect(result.fired).toBe(true);
    expect(result.unavailable).toBe(true);
    expect(result.memberMessage).toBeDefined();
  });

  it('recentlyPlayedGuard fires (unavailable) when playbackUnavailable is true even if title data LOOKS like a recent play — playbackUnavailable is checked first, unconditionally', () => {
    const result = recentlyPlayedGuard(ctx({ playbackUnavailable: true, title: { watchedByAnyone: true, lastPlayedAnyAt: 1_800_000_000 - DAY } }));
    expect(result.fired).toBe(true);
    expect(result.unavailable).toBe(true);
  });

  it('inProgressGuard fires (unavailable) when playbackUnavailable is true, even with no in-progress signals at all', () => {
    const result = inProgressGuard(ctx({ playbackUnavailable: true, inProgressSignals: [] }));
    expect(result.fired).toBe(true);
    expect(result.unavailable).toBe(true);
    expect(result.memberMessage).toBeDefined();
  });

  it('when playbackUnavailable is false, both guards evaluate normally (the fix does not block everything forever)', () => {
    const results = runDeletionGuards(DELETION_GUARDS, ctx({ playbackUnavailable: false }));
    expect(results.every((r) => r.fired === false)).toBe(true);
  });

  it('isPlaybackSnapshotStale: null age (never synced) is stale', () => {
    expect(isPlaybackSnapshotStale(null, 3600)).toBe(true);
  });

  it('isPlaybackSnapshotStale: age exactly at the max is NOT stale (inclusive boundary)', () => {
    expect(isPlaybackSnapshotStale(3600, 3600)).toBe(false);
  });

  it('isPlaybackSnapshotStale: one second past the max IS stale', () => {
    expect(isPlaybackSnapshotStale(3601, 3600)).toBe(true);
  });
});

describe('inProgressGuard (FR-DEL-4 — in_progress)', () => {
  const unfinishedSignal = (overrides: Partial<InProgressSignal> = {}): InProgressSignal => ({
    jellyfinUserId: 'someuserjf',
    ssoUsername: null,
    lastPlayedAt: 1_800_000_000 - DAY,
    unfinished: true,
    ...overrides,
  });

  it('does not fire when there are no signals at all', () => {
    const result = inProgressGuard(ctx({ inProgressSignals: [] }));
    expect(result).toEqual({ guardId: 'in_progress', fired: false });
  });

  it('does not fire when every signal is finished (unfinished: false)', () => {
    const result = inProgressGuard(ctx({ inProgressSignals: [unfinishedSignal({ unfinished: false })] }));
    expect(result.fired).toBe(false);
  });

  it('fires when someone is unfinished within the window (default 90 days)', () => {
    const result = inProgressGuard(ctx({ deleteInProgressDays: 90, inProgressSignals: [unfinishedSignal({ lastPlayedAt: 1_800_000_000 - 30 * DAY })] }));
    expect(result.fired).toBe(true);
    expect(result.unavailable).toBeUndefined();
  });

  it('fires exactly at the boundary (age === window, inclusive) — mirrors recentlyPlayedGuard', () => {
    const now = 1_800_000_000;
    const result = inProgressGuard(ctx({ nowSeconds: now, deleteInProgressDays: 90, inProgressSignals: [unfinishedSignal({ lastPlayedAt: now - 90 * DAY })] }));
    expect(result.fired).toBe(true);
  });

  it('does not fire one second past the boundary — old unfinished progress is not blocked forever', () => {
    const now = 1_800_000_000;
    const result = inProgressGuard(ctx({ nowSeconds: now, deleteInProgressDays: 90, inProgressSignals: [unfinishedSignal({ lastPlayedAt: now - 90 * DAY - 1 })] }));
    expect(result.fired).toBe(false);
  });

  it('fails safe (unavailable) when unfinished but lastPlayedAt is unknown — mirrors FR-DEL-19', () => {
    const result = inProgressGuard(ctx({ inProgressSignals: [unfinishedSignal({ lastPlayedAt: null })] }));
    expect(result.fired).toBe(true);
    expect(result.unavailable).toBe(true);
  });

  it('member message never names who; operator message does, when resolvable (FR-DEL-4a)', () => {
    const result = inProgressGuard(ctx({ inProgressSignals: [unfinishedSignal({ ssoUsername: 'erin' })] }));
    expect(result.fired).toBe(true);
    expect(result.memberMessage).toBeDefined();
    expect(result.memberMessage).not.toContain('erin');
    expect(JSON.stringify(result.memberDetail)).not.toContain('erin');
    expect(result.operatorMessage).toContain('erin');
    expect(result.operatorDetail?.playedBy).toEqual(['erin']);
  });

  it('operator message degrades gracefully when nobody resolves to a linked member', () => {
    const result = inProgressGuard(ctx({ inProgressSignals: [unfinishedSignal({ ssoUsername: null })] }));
    expect(result.fired).toBe(true);
    expect(result.operatorDetail?.playedBy).toEqual([]);
  });

  it('a title with several unfinished viewers, only one within the window: fires, names only the one within window', () => {
    const now = 1_800_000_000;
    const result = inProgressGuard(
      ctx({
        nowSeconds: now,
        deleteInProgressDays: 14,
        inProgressSignals: [unfinishedSignal({ ssoUsername: 'erin', lastPlayedAt: now - 4 * DAY }), unfinishedSignal({ ssoUsername: 'frank', lastPlayedAt: now - 200 * DAY })],
      }),
    );
    expect(result.fired).toBe(true);
    expect(result.operatorDetail?.playedBy).toEqual(['erin']);
  });
});

describe('runDeletionGuards — fail-safe invariant (FR-DEL-4b)', () => {
  it('runs every guard in the array and returns one evaluation per guard', () => {
    const alwaysAllow: DeletionGuard = () => ({ guardId: 'in_progress', fired: false });
    const results = runDeletionGuards([recentlyPlayedGuard, alwaysAllow], ctx());
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.guardId)).toEqual(['recently_played', 'in_progress']);
  });

  it('a fake future guard that fires and is available passes through unchanged — proving the seam is a real drop-in, not just a comment', () => {
    const fakeInProgress: DeletionGuard = () => ({
      guardId: 'in_progress',
      fired: true,
      memberMessage: 'Someone has this partway through.',
      operatorMessage: 'dana has this partway through.',
    });
    const results = runDeletionGuards([recentlyPlayedGuard, fakeInProgress], ctx());
    expect(firedGuards(results)).toHaveLength(1);
    expect(firedGuards(results)[0].guardId).toBe('in_progress');
  });

  it('THROWS if a guard reports unavailable=true but fired=false — fail-safe must never silently allow', () => {
    const brokenGuard: DeletionGuard = () => ({ guardId: 'active_session', fired: false, unavailable: true });
    expect(() => runDeletionGuards([brokenGuard], ctx())).toThrow(/fail-safe/i);
  });

  it('unavailable=true with fired=true is accepted — that IS the fail-safe shape a future active_session guard would use', () => {
    const unavailableButBlocking: DeletionGuard = () => ({
      guardId: 'active_session',
      fired: true,
      unavailable: true,
      memberMessage: 'Could not confirm nobody is watching right now.',
    });
    expect(() => runDeletionGuards([unavailableButBlocking], ctx())).not.toThrow();
    const [result] = runDeletionGuards([unavailableButBlocking], ctx());
    expect(result.fired).toBe(true);
  });
});

describe('firedGuards', () => {
  it('filters to only fired evaluations', () => {
    const evaluations = [
      { guardId: 'recently_played' as const, fired: true },
      { guardId: 'in_progress' as const, fired: false },
    ];
    expect(firedGuards(evaluations)).toEqual([{ guardId: 'recently_played', fired: true }]);
  });
});

describe('FR-DEL-4 — the subject\'s own playback never blocks their own delete', () => {
  const now = 1_800_000_000;
  const recent = { nowSeconds: now, title: { watchedByAnyone: true, lastPlayedAnyAt: now - DAY } };
  const unfinished = (ssoUsername: string | null): InProgressSignal => ({ jellyfinUserId: `jf-${ssoUsername}`, ssoUsername, lastPlayedAt: now - DAY, unfinished: true });

  it('recently_played does not fire when the subject is the only recent viewer', () => {
    expect(recentlyPlayedGuard(ctx({ ...recent, subjectUsername: 'dana', recentPlayerUsernames: ['dana'] })).fired).toBe(false);
  });

  it('recently_played still fires when someone else also played it, naming only them', () => {
    const result = recentlyPlayedGuard(ctx({ ...recent, subjectUsername: 'dana', recentPlayerUsernames: ['dana', 'erin'] }));
    expect(result.fired).toBe(true);
    expect(result.operatorDetail?.playedBy).toEqual(['erin']);
  });

  it('recently_played still fires when an unlinked Jellyfin user also played it', () => {
    expect(recentlyPlayedGuard(ctx({ ...recent, subjectUsername: 'dana', recentPlayerUsernames: ['dana'], recentUnlinkedPlay: true })).fired).toBe(true);
  });

  it('recently_played still fails safe when no recent viewer resolves at all', () => {
    expect(recentlyPlayedGuard(ctx({ ...recent, subjectUsername: 'dana', recentPlayerUsernames: [] })).fired).toBe(true);
  });

  it('recently_played with no subject exempts nobody', () => {
    expect(recentlyPlayedGuard(ctx({ ...recent, recentPlayerUsernames: ['dana'] })).fired).toBe(true);
  });

  it('in_progress ignores the subject\'s own unfinished playback', () => {
    expect(inProgressGuard(ctx({ nowSeconds: now, subjectUsername: 'dana', inProgressSignals: [unfinished('dana')] })).fired).toBe(false);
  });

  it('in_progress still fires for another member or an unlinked viewer', () => {
    expect(inProgressGuard(ctx({ nowSeconds: now, subjectUsername: 'dana', inProgressSignals: [unfinished('dana'), unfinished('erin')] })).fired).toBe(true);
    expect(inProgressGuard(ctx({ nowSeconds: now, subjectUsername: 'dana', inProgressSignals: [unfinished(null)] })).fired).toBe(true);
  });
});
