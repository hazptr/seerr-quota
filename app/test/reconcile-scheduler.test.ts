import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '@/lib/config';

/**
 * `@/lib/reconcile/scheduler.ts` — the `RECONCILE_INTERVAL` loop that was
 * missing entirely: every reconciler step existed and was individually
 * tested, `triggerReconcile()` already ran them in order for the dashboard's
 * manual button, but nothing ever called it on a schedule. This suite covers
 * the loop itself: boot-run gating, interval repeats, the overlap guard
 * (skip, not queue), and that a thrown error never escapes a tick.
 *
 * `@/lib/reconcile/orchestrator.ts`'s `triggerReconcile` is mocked throughout
 * — this is the scheduler's own contract, not a re-test of the pipeline it
 * calls (that's `test/admin-reconcile-route.test.ts` and each step's own
 * suite). No test here may reach a real upstream.
 */
const triggerReconcileMock = vi.fn<() => Promise<unknown[]>>();
vi.mock('@/lib/reconcile/orchestrator', () => ({
  triggerReconcile: () => triggerReconcileMock(),
}));

const { runReconcileTick, startReconcileScheduler, _resetReconcileSchedulerForTests } = await import(
  '@/lib/reconcile/scheduler'
);

/** A `deferred` promise so a test can control exactly when `triggerReconcile` resolves — needed to prove the overlap guard is set BEFORE the awaited call settles. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeConfig(overrides: Record<string, string> = {}) {
  return resolveConfig({ ...overrides });
}

beforeEach(() => {
  triggerReconcileMock.mockReset();
  _resetReconcileSchedulerForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('runReconcileTick', () => {
  it('runs triggerReconcile and reports a completed (non-skipped, non-errored) tick', async () => {
    triggerReconcileMock.mockResolvedValueOnce([]);
    const result = await runReconcileTick('interval');
    expect(triggerReconcileMock).toHaveBeenCalledTimes(1);
    expect(result.skipped).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.trigger).toBe('interval');
  });

  it('overlap prevention: a tick started while one is already in flight is SKIPPED, not queued — triggerReconcile is never called a second time', async () => {
    const gate = deferred<unknown[]>();
    triggerReconcileMock.mockReturnValueOnce(gate.promise);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const firstTick = runReconcileTick('boot'); // starts, sets the in-flight guard synchronously up to its first await
    const secondResult = await runReconcileTick('interval'); // must see the guard and skip immediately, without waiting on the first

    expect(secondResult.skipped).toBe(true);
    expect(triggerReconcileMock).toHaveBeenCalledTimes(1); // still just the first call — the second never called triggerReconcile at all
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('reconcile.skipped_overlap'));

    gate.resolve([]);
    const firstResult = await firstTick;
    expect(firstResult.skipped).toBe(false);

    // Guard is released once the in-flight run finishes — a subsequent tick runs for real.
    triggerReconcileMock.mockResolvedValueOnce([]);
    const thirdResult = await runReconcileTick('interval');
    expect(thirdResult.skipped).toBe(false);
    expect(triggerReconcileMock).toHaveBeenCalledTimes(2);
  });

  it('a thrown error inside triggerReconcile is caught at the loop boundary, never rethrown, and releases the guard for the next tick', async () => {
    triggerReconcileMock.mockRejectedValueOnce(new Error('boom'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runReconcileTick('interval')).resolves.toMatchObject({ skipped: false, error: 'boom' });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('reconcile.tick_failed'));

    // The next tick is NOT blocked by the previous one's failure.
    triggerReconcileMock.mockResolvedValueOnce([]);
    const nextResult = await runReconcileTick('interval');
    expect(nextResult.skipped).toBe(false);
    expect(nextResult.error).toBeUndefined();
    expect(triggerReconcileMock).toHaveBeenCalledTimes(2);
  });

  it('a non-Error throw (e.g. a rejected string) is still caught and stringified, never rethrown', async () => {
    triggerReconcileMock.mockRejectedValueOnce('not an Error instance');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await runReconcileTick('interval');
    expect(result.error).toBe('not an Error instance');
  });
});

describe('startReconcileScheduler — RECONCILE_ON_BOOT', () => {
  it('fires an immediate tick when RECONCILE_ON_BOOT is true (the default)', async () => {
    triggerReconcileMock.mockResolvedValueOnce([]);
    const config = fakeConfig({ RECONCILE_ON_BOOT: 'true', RECONCILE_INTERVAL: '1h' });
    const handle = startReconcileScheduler(config);
    // The boot tick is fired synchronously (fire-and-forget) inside startReconcileScheduler; let its microtasks flush.
    await Promise.resolve();
    await Promise.resolve();
    expect(triggerReconcileMock).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it('does NOT fire a boot tick when RECONCILE_ON_BOOT is false', async () => {
    const config = fakeConfig({ RECONCILE_ON_BOOT: 'false', RECONCILE_INTERVAL: '1h' });
    const handle = startReconcileScheduler(config);
    await Promise.resolve();
    await Promise.resolve();
    expect(triggerReconcileMock).not.toHaveBeenCalled();
    handle.stop();
  });
});

describe('startReconcileScheduler — RECONCILE_INTERVAL repeats', () => {
  it('schedules a tick every RECONCILE_INTERVAL and keeps repeating', async () => {
    vi.useFakeTimers();
    triggerReconcileMock.mockResolvedValue([]);
    const config = fakeConfig({ RECONCILE_ON_BOOT: 'false', RECONCILE_INTERVAL: '15m' });
    const handle = startReconcileScheduler(config);

    expect(triggerReconcileMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(triggerReconcileMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(triggerReconcileMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(15 * 60_000 * 3);
    expect(triggerReconcileMock).toHaveBeenCalledTimes(5);

    handle.stop();
  });

  it('stop() clears the interval — no further ticks after stopping', async () => {
    vi.useFakeTimers();
    triggerReconcileMock.mockResolvedValue([]);
    const config = fakeConfig({ RECONCILE_ON_BOOT: 'false', RECONCILE_INTERVAL: '10m' });
    const handle = startReconcileScheduler(config);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(triggerReconcileMock).toHaveBeenCalledTimes(1);

    handle.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000 * 5);
    expect(triggerReconcileMock).toHaveBeenCalledTimes(1); // unchanged — the timer is gone
  });

  it('a slow run overlapping the next scheduled tick is skipped, not queued — the loop does not stampede once the slow run finishes', async () => {
    vi.useFakeTimers();
    const gate = deferred<unknown[]>();
    triggerReconcileMock.mockReturnValueOnce(gate.promise); // first tick hangs until we resolve it
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const config = fakeConfig({ RECONCILE_ON_BOOT: 'false', RECONCILE_INTERVAL: '5m' });
    const handle = startReconcileScheduler(config);

    await vi.advanceTimersByTimeAsync(5 * 60_000); // first tick starts, still pending
    expect(triggerReconcileMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60_000); // second tick's turn — must skip, first still in flight
    expect(triggerReconcileMock).toHaveBeenCalledTimes(1); // NOT called again — proves skip-not-queue

    gate.resolve([]);
    // Let the first tick's `finally` (which releases the overlap guard) run.
    await Promise.resolve();
    await Promise.resolve();

    triggerReconcileMock.mockResolvedValueOnce([]);
    await vi.advanceTimersByTimeAsync(5 * 60_000); // third scheduled tick, guard now free
    expect(triggerReconcileMock).toHaveBeenCalledTimes(2);

    handle.stop();
  });
});
