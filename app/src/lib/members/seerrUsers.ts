/**
 * Members-local Seerr USER client — `GET /api/v1/user`, verified shape
 * against Seerr's API. Deliberately NOT part of
 * `src/lib/seerr/**` — that directory's request-listing client
 * (`src/lib/seerr/client.ts`, `GET /api/v1/request`) is a different
 * endpoint than the Seerr USER list (`/api/v1/user`) account-sync needs, and
 * keeping them in separate small clients avoids entangling two independent
 * concerns. This reuses the SAME shared `src/lib/http/client.ts`
 * (`UpstreamClient` + `apiKeyAuth`) exactly the way `src/lib/seerr/client.ts`
 * does — same auth scheme (`X-Api-Key`), same pagination shape
 * (`{pageInfo, results}`) — just for `/api/v1/user`. If `src/lib/seerr/**`
 * grows its own user-listing client later, this file should be retired in
 * favor of it.
 *
 * The bundled OpenAPI spec's `User` schema is stale (missing
 * `jellyfinUsername`, `jellyfinUserId`, `displayName`, every quota field) —
 * this parser is built off a real response capture, not the spec, same
 * discipline `src/lib/seerr/types.ts` documents for the request-status
 * enums.
 */
import { apiKeyAuth, UpstreamClient, UpstreamError } from '../http/client';

const UPSTREAM_NAME = 'seerr';
const USER_PATH = '/api/v1/user';

/** Safety cap on the pagination loop, matching `src/lib/seerr/client.ts`'s `MAX_PAGES` — defends against a pathological `pageInfo`, not a normal (currently 7-user) fleet. */
const MAX_PAGES = 100;
const DEFAULT_PAGE_SIZE = 100;

/**
 * The subset of Seerr's `User` fields `FR-SYNC-2` matching needs. Everything
 * else Seerr sends (`permissions`, `avatar`, `requestCount`, the quota
 * fields, ...) is deliberately not modeled here; account-sync doesn't need
 * it.
 */
export interface SeerrUserForMatch {
  id: number;
  /** `null` when Seerr has none on file. */
  email: string | null;
  /** Seerr's own local username — `null` for a Jellyfin-SSO-only account (e.g. a Jellyfin-SSO-only row has `username: null`). */
  username: string | null;
  displayName: string | null;
  /** The primary `FR-SYNC-2` match key. `null` for a non-Jellyfin account. */
  jellyfinUsername: string | null;
  /** Stabler than `jellyfinUsername` across a rename; persisted to `member.jellyfin_user_id` once matched. */
  jellyfinUserId: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function invalidResponse(reason: string): never {
  throw new UpstreamError('invalid_response', UPSTREAM_NAME, 'GET', USER_PATH, `GET ${USER_PATH} ${reason}`);
}

function parseSeerrUser(raw: unknown, index: number): SeerrUserForMatch {
  const u = asRecord(raw);
  if (!u) invalidResponse(`result[${index}] is not an object`);
  if (typeof u.id !== 'number') invalidResponse(`result[${index}] is missing a numeric id`);
  return {
    id: u.id,
    email: typeof u.email === 'string' ? u.email : null,
    username: typeof u.username === 'string' ? u.username : null,
    displayName: typeof u.displayName === 'string' ? u.displayName : null,
    jellyfinUsername: typeof u.jellyfinUsername === 'string' ? u.jellyfinUsername : null,
    jellyfinUserId: typeof u.jellyfinUserId === 'string' ? u.jellyfinUserId : null,
  };
}

interface SeerrUserPageInfo {
  pages: number;
  results: number;
}

function parsePageInfo(raw: unknown): SeerrUserPageInfo {
  const p = asRecord(raw);
  if (!p || typeof p.pages !== 'number' || typeof p.results !== 'number') {
    invalidResponse('response is missing a valid pageInfo');
  }
  return { pages: p.pages, results: p.results };
}

function parseUserPage(raw: unknown): { pageInfo: SeerrUserPageInfo; results: SeerrUserForMatch[] } {
  const data = asRecord(raw);
  if (!data || !Array.isArray(data.results)) {
    invalidResponse('expected {pageInfo, results[]}');
  }
  return {
    pageInfo: parsePageInfo(data.pageInfo),
    results: data.results.map((rawUser, index) => parseSeerrUser(rawUser, index)),
  };
}

export class SeerrUsersClient {
  constructor(private readonly http: UpstreamClient) {}

  /**
   * Pages through every Seerr user via `take`/`skip`, same shape as
   * `src/lib/seerr/client.ts`'s request pagination (`/api/v1/user` uses the
   * same `{pageInfo, results}` envelope).
   *
   * **Fail-safe, not fail-silent (security review, PR #17, item 5).** A
   * caller (`src/lib/members/sync.ts`'s `classifyMembers`) treats whatever
   * this returns as the COMPLETE current roster — a short/partial list
   * would read as "everyone else lost their Seerr account" and mass-flip
   * real members to `not_entitled`. So this throws, rather than returning
   * a partial list, in either failure shape:
   *   - the loop exhausts `MAX_PAGES` without ever satisfying
   *     `out.length >= pageInfo.results` (a pathological/looping
   *     `pageInfo`, or a genuinely huge fleet past this safety cap);
   *   - the final `out.length` doesn't match the last page's reported
   *     `pageInfo.results` at all (an inconsistent/misbehaving upstream).
   */
  async listAllUsers(pageSize: number = DEFAULT_PAGE_SIZE): Promise<SeerrUserForMatch[]> {
    const out: SeerrUserForMatch[] = [];
    let skip = 0;
    let expectedTotal: number | undefined;
    let completed = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await this.http.request<unknown>(USER_PATH, { query: { take: pageSize, skip } });
      const parsed = parseUserPage(data);
      expectedTotal = parsed.pageInfo.results;
      out.push(...parsed.results);
      if (parsed.results.length === 0 || out.length >= parsed.pageInfo.results) {
        completed = true;
        break;
      }
      skip += parsed.results.length;
    }

    if (!completed) {
      invalidResponse(`exceeded MAX_PAGES (${MAX_PAGES}) while paginating — refusing to return a possibly-incomplete user list`);
    }
    if (expectedTotal !== undefined && out.length !== expectedTotal) {
      invalidResponse(
        `paginated result count (${out.length}) does not match the last page's pageInfo.results (${expectedTotal}) — refusing to return a possibly-incomplete user list`,
      );
    }
    return out;
  }
}

/** Builds a `SeerrUsersClient` wired to `SEERR_URL`/`SEERR_API_KEY` (`wiki/Configuration.md`) — same secret, same base URL as `src/lib/seerr/client.ts`'s `createSeerrClient`, different endpoint. */
export function createSeerrUsersClient(baseUrl: string, apiKey: string, timeoutMs: number, retries: number): SeerrUsersClient {
  return new SeerrUsersClient(
    new UpstreamClient({ name: UPSTREAM_NAME, baseUrl, auth: apiKeyAuth('X-Api-Key', apiKey), timeoutMs, retries }),
  );
}
