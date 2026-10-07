/**
 * A minimal, WRITE-capable Seerr client for the enforcement engine only.
 *
 * `src/lib/seerr/client.ts` only exposes
 * the read-only `GET /api/v1/request` listing — it has no
 * approve/decline methods and no single-request `GET /request/{id}`. Rather
 * than extend that file, this module builds its own tiny client from the
 * shared `UpstreamClient` (`src/lib/http/client.ts`, which every upstream
 * client in this app is already built from — read, not modified, here) for
 * exactly the three calls enforcement needs, all verified against Seerr's
 * API:
 *
 *   - `GET  /api/v1/request/{id}`            — re-read a single request by id.
 *     Needed by the webhook path (`FR-ENF-8`): the payload is untrusted and
 *     carries only `request_id`; everything else — requester, current
 *     status — MUST be re-fetched from Seerr, never trusted from the
 *     payload. Confirmed to return the same object plus `seasonCount`, minus
 *     the nested pagination wrapper.
 *   - `POST /api/v1/request/{id}/approve`    — no request body (confirmed:
 *     `grep -i reason` over the full spec, zero hits). Returns 200 + the
 *     updated `MediaRequest`.
 *   - `POST /api/v1/request/{id}/decline`    — same shape, only ever called
 *     from `FR-ENF-11` (operator, not built here) or `FR-ENF-12`'s
 *     `HOLD_MAX_DAYS` age-out (`./process.ts`).
 *
 * Deliberately minimal: only the fields `./process.ts`'s decision pipeline
 * actually needs (`id`, `status`, `requestedBy.id`) are parsed and typed —
 * this is not a general-purpose Seerr request parser (that's
 * `src/lib/seerr/client.ts`'s job for the read-side sync).
 */
import { apiKeyAuth, UpstreamClient, UpstreamError } from '@/lib/http/client';
import { isMediaRequestStatus, type MediaRequestStatusValue } from '@/lib/seerr/types';

const UPSTREAM_NAME = 'seerr';

/** The minimal projection of a Seerr request this module (and `./process.ts`) needs — see this file's header comment. */
export interface SeerrRequestSummary {
  id: number;
  status: MediaRequestStatusValue;
  requestedBySeerrUserId: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function parseSeerrRequestSummary(raw: unknown, path: string): SeerrRequestSummary {
  const r = asRecord(raw);
  if (!r || typeof r.id !== 'number') {
    throw new UpstreamError('invalid_response', UPSTREAM_NAME, 'GET', path, 'response is missing a numeric id');
  }
  if (!isMediaRequestStatus(r.status)) {
    throw new UpstreamError(
      'invalid_response',
      UPSTREAM_NAME,
      'GET',
      path,
      `response has an unrecognised status (${JSON.stringify(r.status)}) — not one of Seerr's documented status values`,
    );
  }
  const requestedBy = asRecord(r.requestedBy);
  if (!requestedBy || typeof requestedBy.id !== 'number') {
    throw new UpstreamError('invalid_response', UPSTREAM_NAME, 'GET', path, 'response is missing requestedBy.id');
  }
  return { id: r.id, status: r.status, requestedBySeerrUserId: requestedBy.id };
}

export class EnforcementSeerrActions {
  constructor(private readonly http: UpstreamClient) {}

  /** `GET /api/v1/request/{id}` — re-reads one request. Throws `UpstreamError` on any failure/malformed body; callers never treat a throw here as "not pending." */
  async getRequestById(requestId: number): Promise<SeerrRequestSummary> {
    const path = `/api/v1/request/${requestId}`;
    const data = await this.http.request<unknown>(path);
    return parseSeerrRequestSummary(data, path);
  }

  /** `POST /api/v1/request/{id}/approve` — no body (verified: no reason/message field exists anywhere in the API). */
  async approveRequest(requestId: number): Promise<void> {
    await this.http.request<unknown>(`/api/v1/request/${requestId}/approve`, { method: 'POST' });
  }

  /** `POST /api/v1/request/{id}/decline` — only ever called for `FR-ENF-11` (manual, not built here) or `FR-ENF-12` (hold age-out). */
  async declineRequest(requestId: number): Promise<void> {
    await this.http.request<unknown>(`/api/v1/request/${requestId}/decline`, { method: 'POST' });
  }
}

/** Builds an `EnforcementSeerrActions` wired to `SEERR_URL`/`SEERR_API_KEY`, same auth shape as `src/lib/seerr/client.ts`'s `createSeerrClient`. */
export function createEnforcementSeerrActions(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
  retries: number,
): EnforcementSeerrActions {
  return new EnforcementSeerrActions(
    new UpstreamClient({ name: UPSTREAM_NAME, baseUrl, auth: apiKeyAuth('X-Api-Key', apiKey), timeoutMs, retries }),
  );
}
