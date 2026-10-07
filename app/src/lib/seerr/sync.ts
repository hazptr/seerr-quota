/**
 * Seerr request sync — fetches every request (paginated `GET /api/v1/request`)
 * and returns it as a normalised, typed "request projection"
 * (`wiki/Backlog.md` P1-5: "Radarr movies, Sonarr series, Seerr requests,
 * into `title` and the request projection").
 *
 * There is deliberately **no DB table** for raw Seerr requests in
 * `wiki/Data-Model.md`'s ten tables — `claim.seerr_request_id` references the
 * Seerr id directly rather than a local copy, so a cache would just be a
 * second source of truth to keep in sync with the first. This function's job
 * stops at "fetch, validate, normalise" — joining requests against `title`
 * and writing `claim` rows is the attribution engine (`P1-6`, not built by
 * this task); see `src/lib/library/sync.ts`'s header comment for where that
 * hand-off point is meant to live.
 */
import type { SeerrClient } from './client';
import type { SeerrRequest } from './types';
import { runStep, type StepResult } from '../http/syncStep';

export interface RequestSyncResult {
  step: StepResult;
  requests: SeerrRequest[];
}

/** Wraps `SeerrClient.listAllRequests` with the same timing/failure-isolation shape every reconciler step uses (`FR-ACCT-10`, `src/lib/http/syncStep.ts`). Never throws. */
export async function syncRequests(seerr: SeerrClient): Promise<RequestSyncResult> {
  const { result, items } = await runStep(() => seerr.listAllRequests());
  return { step: result, requests: items };
}
