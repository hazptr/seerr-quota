/**
 * Write-capable Seerr client for JUST the deletion module's own cleanup call
 * (`FR-DEL-9`). `src/lib/seerr/client.ts` is out of this file's scope
 * and read-only anyway (no request-delete method) — mirrors the same "build
 * a small dedicated write client off the shared `UpstreamClient`" approach
 * `src/lib/enforcement/seerrActions.ts` already uses for approve/decline.
 *
 * **Deliberately implements ONLY `DELETE /api/v1/request/{id}`** — the
 * literal `FR-DEL-9` requirement ("MUST also remove the corresponding Seerr
 * request, so Seerr does not continue to show the title as available").
 * `DELETE /api/v1/media/{mediaId}` ("clear Seerr's media record if
 * orphaned") is named in `wiki/Feature-06-Self-Service-Deletion.md`'s
 * Interactions section as `~ documented` and explicitly conditional ("if
 * orphaned") — determining orphan-ness correctly needs Seerr's internal
 * `media.id` (not persisted anywhere in this app's schema — `title` only
 * carries `tmdbId`/`tvdbId`, Seerr's OWN join keys, never Seerr's internal
 * row id) and a live check for any OTHER request still pointing at the same
 * media, which is extra failure surface for a call the spec does not phrase
 * as a hard MUST. **Deliberately out of scope here** — flagged in this
 * task's final report as a scope decision, not silently implemented as a
 * guess at behaviour nobody has verified against source.
 */
import { apiKeyAuth, UpstreamClient } from '@/lib/http/client';

const UPSTREAM_NAME = 'seerr';

export class SeerrCleanupClient {
  constructor(private readonly http: UpstreamClient) {}

  /**
   * `DELETE /api/v1/request/{id}` — no query params, no body. Never retried
   * (AGENTS.md rule 11, enforced by the shared `UpstreamClient`). Returns the
   * OBSERVED HTTP status so the caller's audit row records reality rather
   * than an assumed `200` (`FR-DEL-7`/`FR-DEL-16`).
   */
  async deleteRequest(requestId: number): Promise<{ status: number }> {
    const { status } = await this.http.requestWithStatus<unknown>(`/api/v1/request/${requestId}`, { method: 'DELETE' });
    return { status };
  }
}

export function createSeerrCleanupClient(baseUrl: string, apiKey: string, timeoutMs: number, retries: number): SeerrCleanupClient {
  return new SeerrCleanupClient(
    new UpstreamClient({ name: UPSTREAM_NAME, baseUrl, auth: apiKeyAuth('X-Api-Key', apiKey), timeoutMs, retries }),
  );
}

/** Display-only, for the audit trail. Never includes the API key (header-based auth — see `arrActions.ts`'s equivalent comment). */
export function seerrDeleteRequestCallUrl(baseUrl: string, requestId: number): string {
  return `${baseUrl.replace(/\/$/, '')}/api/v1/request/${requestId}`;
}
