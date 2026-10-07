/**
 * `FR-POL-10`: "This feature MUST NOT modify Seerr's native count quotas
 * (`movieQuotaLimit`/`tvQuotaLimit`). Those remain configured in Seerr and
 * are displayed here read-only for context." Verified against a real Seerr
 * deployment (both endpoints confirmed):
 *
 *   GET /api/v1/user/{id}         -> the user object, including
 *                                    movieQuotaLimit/Days, tvQuotaLimit/Days
 *   GET /api/v1/user/{id}/quota   -> current count-quota consumption
 *                                    (movie/tv -> days/limit/used/remaining/
 *                                    restricted)
 *
 * `SeerrNativeQuotaReader` is deliberately built directly on
 * `src/lib/http/client.ts`'s shared `UpstreamClient` — the SAME upstream
 * `src/lib/seerr/client.ts`'s `SeerrClient` uses — rather than extending or
 * modifying that class, since `SeerrClient` today has no user-quota methods
 * at all and keeping this its own small class avoids entangling two
 * independent concerns. Making this its own small class also gives the
 * structural guarantee `FR-POL-10` asks for
 * ("no write method should exist"): every method on this class starts with
 * `get`/`list` and issues a `GET`; there is no `set`/`update`/`post`/`put`/
 * `patch`/`delete` method for a caller to reach for, and
 * `test/quota-seerr-native.test.ts` asserts that mechanically (enumerates
 * the prototype's own methods and checks each name), not just by
 * convention.
 */
import { apiKeyAuth, UpstreamClient, UpstreamError } from '@/lib/http/client';

const UPSTREAM_NAME = 'seerr';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `movieQuotaLimit`/`movieQuotaDays`/`tvQuotaLimit`/`tvQuotaDays` — Seerr's own convention: `null` = no limit configured, matching this app's own `FR-POL-2a` "unconfigured vs. 0" distinction (Seerr's `0` would also mean "no requests allowed", but in practice Seerr only ever uses `null` for "unset" — this reader passes the raw value through without reinterpreting it). */
export interface SeerrNativeQuotaSettings {
  seerrUserId: number;
  movieQuotaLimit: number | null;
  movieQuotaDays: number | null;
  tvQuotaLimit: number | null;
  tvQuotaDays: number | null;
}

export interface SeerrNativeQuotaWindowUsage {
  days: number;
  limit: number;
  used: number;
  remaining: number;
  restricted: boolean;
}

/** `GET /api/v1/user/{id}/quota` response shape, verified against Seerr's API. */
export interface SeerrNativeQuotaUsage {
  movie: SeerrNativeQuotaWindowUsage;
  tv: SeerrNativeQuotaWindowUsage;
}

function invalidUser(seerrUserId: number, path: string, reason: string): never {
  throw new UpstreamError('invalid_response', UPSTREAM_NAME, 'GET', path, `GET ${path} (user ${seerrUserId}) ${reason}`);
}

function parseQuotaSettings(raw: unknown, seerrUserId: number, path: string): SeerrNativeQuotaSettings {
  const r = asRecord(raw);
  if (!r) invalidUser(seerrUserId, path, 'did not return an object');
  return {
    seerrUserId,
    movieQuotaLimit: numOrNull(r.movieQuotaLimit),
    movieQuotaDays: numOrNull(r.movieQuotaDays),
    tvQuotaLimit: numOrNull(r.tvQuotaLimit),
    tvQuotaDays: numOrNull(r.tvQuotaDays),
  };
}

function parseWindowUsage(raw: unknown, seerrUserId: number, path: string, field: 'movie' | 'tv'): SeerrNativeQuotaWindowUsage {
  const w = asRecord(raw);
  if (!w) invalidUser(seerrUserId, path, `is missing its "${field}" window`);
  if (typeof w.days !== 'number' || typeof w.limit !== 'number' || typeof w.used !== 'number' || typeof w.remaining !== 'number') {
    invalidUser(seerrUserId, path, `"${field}" window is missing a required numeric field`);
  }
  return { days: w.days, limit: w.limit, used: w.used, remaining: w.remaining, restricted: w.restricted === true };
}

function parseQuotaUsage(raw: unknown, seerrUserId: number, path: string): SeerrNativeQuotaUsage {
  const r = asRecord(raw);
  if (!r) invalidUser(seerrUserId, path, 'did not return an object');
  return {
    movie: parseWindowUsage(r.movie, seerrUserId, path, 'movie'),
    tv: parseWindowUsage(r.tv, seerrUserId, path, 'tv'),
  };
}

/**
 * Read-only, on purpose. See this file's header comment — `FR-POL-10`
 * ("no write method should exist") is enforced structurally: add a `get*`
 * method here freely, but never a `set*`/`update*`/mutating one.
 */
export class SeerrNativeQuotaReader {
  constructor(private readonly http: UpstreamClient) {}

  /** `GET /api/v1/user/{id}` — the user's configured limits (not their current usage; see `getQuotaUsage` for that). */
  async getQuotaSettings(seerrUserId: number): Promise<SeerrNativeQuotaSettings> {
    const path = `/api/v1/user/${seerrUserId}`;
    const data = await this.http.request<unknown>(path);
    return parseQuotaSettings(data, seerrUserId, path);
  }

  /** `GET /api/v1/user/{id}/quota` — current count-quota consumption this rolling window. */
  async getQuotaUsage(seerrUserId: number): Promise<SeerrNativeQuotaUsage> {
    const path = `/api/v1/user/${seerrUserId}/quota`;
    const data = await this.http.request<unknown>(path);
    return parseQuotaUsage(data, seerrUserId, path);
  }
}

/** Builds a `SeerrNativeQuotaReader` wired to `SEERR_URL`/`SEERR_API_KEY` — same construction shape as `src/lib/seerr/client.ts`'s `createSeerrClient`. */
export function createSeerrNativeQuotaReader(baseUrl: string, apiKey: string, timeoutMs: number, retries: number): SeerrNativeQuotaReader {
  return new SeerrNativeQuotaReader(
    new UpstreamClient({ name: UPSTREAM_NAME, baseUrl, auth: apiKeyAuth('X-Api-Key', apiKey), timeoutMs, retries }),
  );
}
