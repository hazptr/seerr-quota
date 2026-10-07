/**
 * Generic step timing/error-capture wrapper, shared by every reconciler step
 * that fetches a list from one upstream — this task's library (Radarr/
 * Sonarr) and request (Seerr) sync, and (later, not built here) the
 * identity/playback/attribution/pending-sweep steps from
 * `wiki/Architecture.md` §Reconciler. Produces exactly the shape
 * `wiki/Data-Model.md` §sync_run documents: "Per-step `{ok, count, ms,
 * error}` for the six reconciler steps."
 *
 * **This is where `FR-ACCT-10` failure isolation lives structurally.**
 * `runStep` never throws — a failing upstream call becomes
 * `{ok:false, count:0, ms, error}` for *that* step only, so a caller running
 * several independent steps (e.g. movies + series) can let one fail without
 * an exception unwinding past the steps that haven't run yet. `error` is
 * built from `err.message` — for an `UpstreamError` (`src/lib/http/
 * client.ts`) that message is guaranteed to never contain a secret, so
 * nothing here needs to re-scrub it.
 */

export interface StepResult {
  ok: boolean;
  count: number;
  ms: number;
  error?: string;
}

export interface StepOutcome<T> {
  result: StepResult;
  items: T[];
}

export async function runStep<T>(fn: () => Promise<T[]>): Promise<StepOutcome<T>> {
  const start = Date.now();
  try {
    const items = await fn();
    return { result: { ok: true, count: items.length, ms: Date.now() - start }, items };
  } catch (err) {
    return {
      result: { ok: false, count: 0, ms: Date.now() - start, error: errorMessage(err) },
      items: [],
    };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
