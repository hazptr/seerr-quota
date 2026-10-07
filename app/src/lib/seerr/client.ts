/**
 * Seerr REST client — `GET /api/v1/request`, paginated, verified against
 * a real Seerr instance. Seerr's real response
 * carries many more fields than documented (`downloadStatus`, `serverId`,
 * `ratingKey`, ...) — `parseSeerrRequest` below picks out only what
 * `wiki/Feature-03-Usage-Accounting.md` needs and validates their types,
 * tolerating everything else.
 *
 * Parsing is deliberately lenient on `media.tmdbId`/`media.tvdbId`: they are
 * carried through as `null` rather than rejected, because "this request's
 * media can't be resolved to a library item" is an **attribution-time**
 * concern (`FR-ACCT-4`, the not-yet-built P1-6 attribution engine), not a
 * parse-time one — a `null` join key here must not make an otherwise
 * well-formed request disappear from the sync.
 */
import { apiKeyAuth, UpstreamClient, UpstreamError } from '../http/client';
import {
  isMediaRequestStatus,
  isMediaStatus,
  type MediaRequestStatusValue,
  type MediaStatusValue,
  type SeerrPageInfo,
  type SeerrRequest,
  type SeerrRequestPage,
  type SeerrRequestSeason,
  type SeerrRequestedBy,
} from './types';

const UPSTREAM_NAME = 'seerr';
const REQUEST_PATH = '/api/v1/request';

/** Safety cap on the pagination loop — defends against a pathological `pageInfo.pages`/an infinite-loop bug, not a normal (currently 92-request) fleet. */
const MAX_PAGES = 100;
const DEFAULT_PAGE_SIZE = 100;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function invalidRequest(index: number, reason: string): never {
  throw new UpstreamError('invalid_response', UPSTREAM_NAME, 'GET', REQUEST_PATH, `request[${index}] ${reason}`);
}

function parseRequestedBy(raw: unknown, index: number): SeerrRequestedBy {
  const r = asRecord(raw);
  if (!r) invalidRequest(index, 'is missing requestedBy');
  if (typeof r.id !== 'number') {
    invalidRequest(index, 'requestedBy is missing a numeric id');
  }
  return {
    id: r.id,
    email: typeof r.email === 'string' ? r.email : null,
    jellyfinUsername: typeof r.jellyfinUsername === 'string' ? r.jellyfinUsername : null,
    jellyfinUserId: typeof r.jellyfinUserId === 'string' ? r.jellyfinUserId : null,
    displayName: typeof r.displayName === 'string' ? r.displayName : null,
  };
}

function parseMediaRequestStatus(raw: unknown, index: number, field: string): MediaRequestStatusValue {
  if (!isMediaRequestStatus(raw)) {
    invalidRequest(index, `has an unrecognised ${field} (${JSON.stringify(raw)}) — not one of Seerr's documented enum values`);
  }
  return raw;
}

function parseMediaStatus(raw: unknown, index: number, field: string): MediaStatusValue {
  if (!isMediaStatus(raw)) {
    invalidRequest(index, `has an unrecognised ${field} (${JSON.stringify(raw)}) — not one of Seerr's documented enum values`);
  }
  return raw;
}

function parseSeasons(raw: unknown, index: number): SeerrRequestSeason[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((rawSeason, seasonIndex) => {
    const s = asRecord(rawSeason);
    if (!s) invalidRequest(index, `season[${seasonIndex}] is not an object`);
    if (typeof s.id !== 'number') invalidRequest(index, `season[${seasonIndex}] is missing a numeric id`);
    if (typeof s.seasonNumber !== 'number') invalidRequest(index, `season[${seasonIndex}] is missing a numeric seasonNumber`);
    return {
      id: s.id,
      seasonNumber: s.seasonNumber,
      status: parseMediaRequestStatus(s.status, index, `season[${seasonIndex}].status`),
    };
  });
}

function parseSeerrRequest(raw: unknown, index: number): SeerrRequest {
  const r = asRecord(raw);
  if (!r) invalidRequest(index, 'is not an object');
  if (typeof r.id !== 'number') invalidRequest(index, 'is missing a numeric id');
  if (r.type !== 'movie' && r.type !== 'tv') invalidRequest(index, `(id=${r.id}) has an unrecognised type`);
  if (typeof r.createdAt !== 'string') invalidRequest(index, `(id=${r.id}) is missing createdAt`);

  const media = asRecord(r.media);
  if (!media) invalidRequest(index, `(id=${r.id}) is missing media`);
  if (typeof media.id !== 'number') invalidRequest(index, `(id=${r.id}) media is missing a numeric id`);
  if (media.mediaType !== 'movie' && media.mediaType !== 'tv') {
    invalidRequest(index, `(id=${r.id}) media has an unrecognised mediaType`);
  }

  return {
    id: r.id,
    status: parseMediaRequestStatus(r.status, index, 'status'),
    createdAt: r.createdAt,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : r.createdAt,
    type: r.type,
    is4k: r.is4k === true,
    isAutoRequest: r.isAutoRequest === true,
    media: {
      id: media.id,
      mediaType: media.mediaType,
      tmdbId: typeof media.tmdbId === 'number' ? media.tmdbId : null,
      tvdbId: typeof media.tvdbId === 'number' ? media.tvdbId : null,
      status: parseMediaStatus(media.status, index, 'media.status'),
      status4k: media.status4k === null || media.status4k === undefined ? null : parseMediaStatus(media.status4k, index, 'media.status4k'),
      jellyfinMediaId:
        typeof media.jellyfinMediaId === 'string' || typeof media.jellyfinMediaId === 'number' ? media.jellyfinMediaId : null,
    },
    seasons: parseSeasons(r.seasons, index),
    requestedBy: parseRequestedBy(r.requestedBy, index),
  };
}

function parsePageInfo(raw: unknown): SeerrPageInfo {
  const p = asRecord(raw);
  if (!p || typeof p.pages !== 'number' || typeof p.results !== 'number' || typeof p.page !== 'number') {
    throw new UpstreamError('invalid_response', UPSTREAM_NAME, 'GET', REQUEST_PATH, 'response is missing a valid pageInfo');
  }
  return {
    pages: p.pages,
    pageSize: typeof p.pageSize === 'number' ? p.pageSize : 0,
    results: p.results,
    page: p.page,
  };
}

function parseSeerrRequestPage(raw: unknown): SeerrRequestPage {
  const data = asRecord(raw);
  if (!data || !Array.isArray(data.results)) {
    throw new UpstreamError('invalid_response', UPSTREAM_NAME, 'GET', REQUEST_PATH, 'expected {pageInfo, results[]} from GET /api/v1/request');
  }
  return {
    pageInfo: parsePageInfo(data.pageInfo),
    results: data.results.map((rawRequest, index) => parseSeerrRequest(rawRequest, index)),
  };
}

export interface ListRequestsPageOptions {
  take: number;
  skip: number;
  filter?: 'all' | 'approved' | 'available' | 'pending' | 'processing' | 'unavailable' | 'failed' | 'deleted' | 'completed';
  sort?: 'added' | 'modified';
  sortDirection?: 'asc' | 'desc';
}

export class SeerrClient {
  constructor(private readonly http: UpstreamClient) {}

  /** `GET /api/v1/request?take=&skip=&filter=&sort=&sortDirection=` — one page. */
  async listRequestsPage(opts: ListRequestsPageOptions): Promise<SeerrRequestPage> {
    const data = await this.http.request<unknown>(REQUEST_PATH, {
      query: {
        take: opts.take,
        skip: opts.skip,
        filter: opts.filter,
        sort: opts.sort,
        sortDirection: opts.sortDirection,
      },
    });
    return parseSeerrRequestPage(data);
  }

  /**
   * Pages through every request (`filter=all`, so pending/declined/failed
   * requests are included — attribution and the operator's "unresolved"
   * view both need them, not just `COMPLETED` ones). Bounded by `MAX_PAGES`
   * as a safety cap against a pathological `pageInfo`, not a real fleet size.
   */
  async listAllRequests(pageSize: number = DEFAULT_PAGE_SIZE): Promise<SeerrRequest[]> {
    const out: SeerrRequest[] = [];
    let skip = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await this.listRequestsPage({ take: pageSize, skip, filter: 'all', sort: 'added' });
      out.push(...data.results);
      if (data.results.length === 0 || out.length >= data.pageInfo.results) break;
      skip += data.results.length;
    }
    return out;
  }
}

/** Builds a `SeerrClient` wired to `SEERR_URL`/`SEERR_API_KEY` (`wiki/Configuration.md`). */
export function createSeerrClient(baseUrl: string, apiKey: string, timeoutMs: number, retries: number): SeerrClient {
  return new SeerrClient(
    new UpstreamClient({ name: UPSTREAM_NAME, baseUrl, auth: apiKeyAuth('X-Api-Key', apiKey), timeoutMs, retries }),
  );
}
