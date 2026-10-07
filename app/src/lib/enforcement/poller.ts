/**
 * The poller — reconciler step 6, "Pending sweep" (`wiki/Architecture.md`
 * §Reconciler: "decide every pending request (`D-4`)"). This is THE
 * contract (`wiki/Feature-05-Enforcement.md` "How it works": "The webhook is
 * an optimisation for latency. The poller is the contract. A dropped webhook
 * must never leave a request stuck"). Sweeps `GET /api/v1/request?filter=pending`
 * (verified against Seerr's API) and runs every result
 * through `./process.ts`'s `processPendingRequest` — the SAME function the
 * webhook route calls, so the two paths cannot disagree (`FR-ENF-1`).
 *
 * Reuses the existing, already-verified `src/lib/seerr/client.ts`'s
 * `SeerrClient` for the read-only listing —
 * `listRequestsPage` already supports `filter: 'pending'`, so no new read
 * client is needed here; only the WRITE surface — approve/decline — needed
 * its own minimal client, `./seerrActions.ts`, per that file's header
 * comment. `SeerrClient.listAllRequests()` itself is hardcoded to
 * `filter=all`, so this file has its own small pagination loop
 * (`listAllPending`), mirroring that function's shape exactly.
 *
 * **Failure isolation.** The `GET ...filter=pending` fetch is wrapped in
 * `runStep` (`FR-ACCT-10`'s discipline, applied here) — if Seerr is down,
 * `sweepStep.ok === false` and NOTHING is decided this cycle (matches the
 * spec's "Seerr down" edge case: "poller fails in isolation, requests stay
 * pending ... no notifications sent"). Once the list is in hand, each
 * request is processed independently via `processPendingRequest`, which
 * itself never throws (`./process.ts`'s header comment) — one bad Seerr
 * approve/decline call cannot abort the sweep for every other pending
 * request.
 */
import { getConfig } from '@/lib/config';
import { getDb } from '@/lib/db';
import { syncRun } from '@/lib/db/schema';
import { runStep, type StepResult } from '@/lib/http/syncStep';
import { createSeerrClient, type SeerrClient } from '@/lib/seerr/client';
import type { SeerrRequest } from '@/lib/seerr/types';
import { createEnforcementNotifier } from './notify';
import { processPendingRequest, type ProcessDeps, type ProcessOutcome } from './process';

const PENDING_PAGE_SIZE = 100;
/** Safety cap on the pagination loop, matching `src/lib/seerr/client.ts`'s `listAllRequests` — defends against a pathological `pageInfo`, not a real fleet. */
const MAX_PENDING_PAGES = 100;

/** `GET /api/v1/request?filter=pending`, paginated — the read half of the sweep. Mirrors `SeerrClient.listAllRequests`'s loop exactly, just with `filter: 'pending'` instead of `'all'`. */
async function listAllPending(seerr: SeerrClient): Promise<SeerrRequest[]> {
  const out: SeerrRequest[] = [];
  let skip = 0;
  for (let page = 0; page < MAX_PENDING_PAGES; page++) {
    const data = await seerr.listRequestsPage({ take: PENDING_PAGE_SIZE, skip, filter: 'pending', sort: 'added' });
    out.push(...data.results);
    if (data.results.length === 0 || out.length >= data.pageInfo.results) break;
    skip += data.results.length;
  }
  return out;
}

export interface PendingSweepDeps {
  seerr?: SeerrClient;
  /** Forwarded to `processPendingRequest` for every pending request this cycle — the test seam for injecting a fake `EnforcementSeerrActions`/notifier/db. */
  processDeps?: ProcessDeps;
}

export interface PendingSweepResult {
  /** The `GET ...filter=pending` fetch itself — `count` is how many pending requests were found, NOT how many were successfully decided (each decision's own outcome is in `outcomes`, same split `src/lib/seerr/sync.ts`'s `syncRequests` draws between "fetched" and "processed"). */
  sweep: StepResult;
  outcomes: ProcessOutcome[];
  syncRunId: number;
}

function resolveSeerrClient(deps: PendingSweepDeps): SeerrClient {
  if (deps.seerr) return deps.seerr;
  const config = getConfig();
  return createSeerrClient(config.upstreams.seerrUrl, config.secrets.seerrApiKey, config.scheduling.upstreamTimeoutMs, config.scheduling.upstreamRetries);
}

/**
 * P2-9 wiring: every request this sweep decides goes through the SAME
 * `ProcessDeps`, built once per sweep (not per request) — cheap either way
 * (`createEnforcementNotifier` does no I/O at construction), but one build
 * keeps every request in a sweep sharing one notifier instance, same as they
 * already share one `seerrActions`. Only fills in `notifier` when the caller
 * didn't already inject one (tests, and any future caller that wants a fake) —
 * `deps.processDeps`'s other fields (`db`, `seerrActions`) pass through
 * untouched.
 */
function resolveProcessDeps(deps: PendingSweepDeps): ProcessDeps {
  return {
    ...deps.processDeps,
    notifier: deps.processDeps?.notifier ?? createEnforcementNotifier({ source: 'poller' }),
  };
}

function recordSyncRun(steps: Record<string, StepResult>, startedAtSeconds: number, finishedAtSeconds: number): number {
  const db = getDb();
  const ok = Object.values(steps).every((s) => s.ok);
  const row = db
    .insert(syncRun)
    .values({ startedAt: startedAtSeconds, finishedAt: finishedAtSeconds, steps: JSON.stringify(steps), ok })
    .returning({ id: syncRun.id })
    .get();
  return row.id;
}

/**
 * The P2-6 reconcile step. Deps are injectable (test seam, same shape as
 * every other `run*Sync` in this app); when omitted, a real `SeerrClient` is
 * built from `getConfig()`. Never throws.
 */
export async function runPendingSweep(deps: PendingSweepDeps = {}, nowSeconds: number = Math.floor(Date.now() / 1000)): Promise<PendingSweepResult> {
  const seerr = resolveSeerrClient(deps);
  const startedAt = Math.floor(Date.now() / 1000);

  const { result: sweepStep, items: pending } = await runStep(() => listAllPending(seerr));

  const outcomes: ProcessOutcome[] = [];
  if (sweepStep.ok) {
    const processDeps = resolveProcessDeps(deps);
    for (const req of pending) {
      // eslint-disable-next-line no-await-in-loop -- each request must be
      // decided against the DB state left by the previous one (e.g. two
      // pending requests from the same over-quota member: the first turning
      // into a `hold` must be visible before the second is evaluated).
      const outcome = await processPendingRequest(req.id, 'poller', processDeps, nowSeconds);
      outcomes.push(outcome);
    }
  }

  const finishedAt = Math.floor(Date.now() / 1000);
  const syncRunId = recordSyncRun({ pending_sweep: sweepStep }, startedAt, finishedAt);

  return { sweep: sweepStep, outcomes, syncRunId };
}
