/**
 * Write-capable Radarr/Sonarr delete clients — `FR-DEL-9`/`10`/`11`.
 * `src/lib/library/radarr.ts`/`sonarr.ts` stay read-only
 * (`listMovies`/`listSeries`, no delete method) — this
 * mirrors the same "build a small dedicated write client off the shared
 * `UpstreamClient`" approach `src/lib/enforcement/seerrActions.ts` already
 * uses for Seerr approve/decline, rather than extending either read client.
 *
 * **`FR-DEL-10` — the two apps' exclusion parameters are named differently,
 * verified against each app's source at the running tags:**
 *
 *   - Radarr `DELETE /api/v3/movie/{id}` — `addImportExclusion=false`.
 *   - Sonarr `DELETE /api/v3/series/{id}` — `addImportListExclusion=false`
 *     (NOT `addImportExclusion` — that name is Radarr's; on Sonarr's
 *     endpoint it is not a recognised query param at all and would silently
 *     no-op rather than error).
 *
 * Both calls always send `deleteFiles=true` — that IS the point of this
 * module (`FR-DEL-11`: never touch the filesystem directly, always go
 * through Radarr/Sonarr) — and always `addImport(List)Exclusion=false`, so a
 * member deleting something doesn't permanently block it from being
 * re-requested (`FR-DEL-10`).
 *
 * **Never retried.** Both calls go through the shared `UpstreamClient`
 * (`src/lib/http/client.ts`), which hard-caps a `DELETE` to exactly one
 * attempt regardless of the `retries` this client was built with (AGENTS.md
 * rule 11) — nothing in this file needs to re-implement or even remember
 * that rule; it structurally cannot be bypassed from here.
 */
import { apiKeyAuth, UpstreamClient } from '@/lib/http/client';

const RADARR_UPSTREAM_NAME = 'radarr';
const SONARR_UPSTREAM_NAME = 'sonarr';

export class RadarrDeleteClient {
  constructor(private readonly http: UpstreamClient) {}

  /**
   * `DELETE /api/v3/movie/{id}?deleteFiles=true&addImportExclusion=false` —
   * verified `v6.1.1.10360`. Returns the OBSERVED HTTP status so the caller's
   * audit row records reality rather than an assumed `200` (`FR-DEL-7`).
   */
  async deleteMovie(radarrId: number): Promise<{ status: number }> {
    const { status } = await this.http.requestWithStatus<unknown>(`/api/v3/movie/${radarrId}`, {
      method: 'DELETE',
      query: { deleteFiles: true, addImportExclusion: false },
    });
    return { status };
  }
}

export class SonarrDeleteClient {
  constructor(private readonly http: UpstreamClient) {}

  /**
   * `DELETE /api/v3/series/{id}?deleteFiles=true&addImportListExclusion=false`
   * — verified `v4.0.19.2979`. **Not** `addImportExclusion` — see this
   * file's header comment. Returns the OBSERVED HTTP status, same reasoning
   * as `RadarrDeleteClient.deleteMovie` above.
   */
  async deleteSeries(sonarrId: number): Promise<{ status: number }> {
    const { status } = await this.http.requestWithStatus<unknown>(`/api/v3/series/${sonarrId}`, {
      method: 'DELETE',
      query: { deleteFiles: true, addImportListExclusion: false },
    });
    return { status };
  }
}

export function createRadarrDeleteClient(baseUrl: string, apiKey: string, timeoutMs: number, retries: number): RadarrDeleteClient {
  return new RadarrDeleteClient(
    new UpstreamClient({ name: RADARR_UPSTREAM_NAME, baseUrl, auth: apiKeyAuth('X-Api-Key', apiKey), timeoutMs, retries }),
  );
}

export function createSonarrDeleteClient(baseUrl: string, apiKey: string, timeoutMs: number, retries: number): SonarrDeleteClient {
  return new SonarrDeleteClient(
    new UpstreamClient({ name: SONARR_UPSTREAM_NAME, baseUrl, auth: apiKeyAuth('X-Api-Key', apiKey), timeoutMs, retries }),
  );
}

/**
 * Display-only reconstruction of the exact call URL, for the audit trail
 * (`FR-DEL-7`: "recording the exact Radarr/Sonarr call issued"). NEVER
 * includes the API key — Radarr/Sonarr auth is a header (`X-Api-Key`), not a
 * query param, so it is structurally absent from anything built here
 * (`FR-AUD-11`).
 */
export function radarrDeleteCallUrl(baseUrl: string, radarrId: number): string {
  return `${baseUrl.replace(/\/$/, '')}/api/v3/movie/${radarrId}?deleteFiles=true&addImportExclusion=false`;
}

export function sonarrDeleteCallUrl(baseUrl: string, sonarrId: number): string {
  return `${baseUrl.replace(/\/$/, '')}/api/v3/series/${sonarrId}?deleteFiles=true&addImportListExclusion=false`;
}
