/**
 * Radarr REST client — `GET /api/v3/movie`, verified against a real
 * Radarr instance. Radarr's real response carries dozens of fields this app
 * never reads (images, ratings, `movieFile`, `collection`, ...) —
 * `parseRadarrMovie` below picks out only what `wiki/Data-Model.md`'s
 * `title` table needs and validates their types, tolerating everything else;
 * Radarr is free to add/remove fields we don't read without breaking this
 * client.
 */
import { apiKeyAuth, UpstreamClient, UpstreamError } from '../http/client';

const UPSTREAM_NAME = 'radarr';
const MOVIE_PATH = '/api/v3/movie';

export interface RadarrMovie {
  id: number;
  tmdbId: number;
  title: string;
  year: number | null;
  hasFile: boolean;
  /** Bytes. `0` when `hasFile` is `false` — a pending request contributes zero bytes (`FR-ACCT-1`); never assume this is populated just because a request exists. */
  sizeOnDisk: number;
  /** ISO 8601 timestamp, or `null` if Radarr omitted it. */
  added: string | null;
  path: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function invalidMovie(index: number, reason: string): never {
  throw new UpstreamError('invalid_response', UPSTREAM_NAME, 'GET', MOVIE_PATH, `movie[${index}] ${reason}`);
}

function parseRadarrMovie(raw: unknown, index: number): RadarrMovie {
  const m = asRecord(raw);
  if (!m) invalidMovie(index, 'is not an object');
  if (typeof m.id !== 'number') invalidMovie(index, 'is missing a numeric id');
  if (typeof m.tmdbId !== 'number') invalidMovie(index, `(id=${m.id}) is missing a numeric tmdbId`);
  if (typeof m.title !== 'string') invalidMovie(index, `(id=${m.id}) is missing a title`);
  if (typeof m.path !== 'string') invalidMovie(index, `(id=${m.id}) is missing a path`);

  return {
    id: m.id,
    tmdbId: m.tmdbId,
    title: m.title,
    year: typeof m.year === 'number' ? m.year : null,
    hasFile: m.hasFile === true,
    sizeOnDisk: typeof m.sizeOnDisk === 'number' ? m.sizeOnDisk : 0,
    added: typeof m.added === 'string' ? m.added : null,
    path: m.path,
  };
}

export class RadarrClient {
  constructor(private readonly http: UpstreamClient) {}

  /** `GET /api/v3/movie` — every movie in Radarr's library, downloaded or not. */
  async listMovies(): Promise<RadarrMovie[]> {
    const data = await this.http.request<unknown>(MOVIE_PATH);
    if (!Array.isArray(data)) {
      throw new UpstreamError('invalid_response', UPSTREAM_NAME, 'GET', MOVIE_PATH, 'expected an array from GET /api/v3/movie');
    }
    return data.map((raw, index) => parseRadarrMovie(raw, index));
  }
}

/** Builds a `RadarrClient` wired to `RADARR_URL`/`RADARR_API_KEY` (`wiki/Configuration.md`). */
export function createRadarrClient(baseUrl: string, apiKey: string, timeoutMs: number, retries: number): RadarrClient {
  return new RadarrClient(
    new UpstreamClient({ name: UPSTREAM_NAME, baseUrl, auth: apiKeyAuth('X-Api-Key', apiKey), timeoutMs, retries }),
  );
}
