/**
 * Sonarr REST client — `GET /api/v3/series`, verified against a real
 * Sonarr instance. Mirrors `./radarr.ts`'s shape; see that
 * file's header comment for the general approach (pick out only the fields
 * `title` needs, tolerate everything else Sonarr returns).
 *
 * One documented edge case (`wiki/Feature-03-Usage-Accounting.md`
 * "Multi-season TV grabbed as one pack"): Sonarr reports exactly ONE
 * `statistics.sizeOnDisk` for the whole series, never per-season — this
 * client surfaces that single number as-is. Per-season byte attribution
 * (`P4-1`) is a separate, dedicated client: `./sonarrEpisodeFiles.ts`,
 * fetching `GET /api/v3/episodefile?seriesId={id}` instead of extending
 * this one.
 */
import { apiKeyAuth, UpstreamClient, UpstreamError } from '../http/client';

const UPSTREAM_NAME = 'sonarr';
const SERIES_PATH = '/api/v3/series';

export interface SonarrSeries {
  id: number;
  tvdbId: number;
  title: string;
  year: number | null;
  path: string;
  /** ISO 8601 timestamp, or `null` if Sonarr omitted it. */
  added: string | null;
  /** `statistics.sizeOnDisk`, bytes. `0` for a series with nothing downloaded yet. */
  sizeOnDisk: number;
  episodeFileCount: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function invalidSeries(index: number, reason: string): never {
  throw new UpstreamError('invalid_response', UPSTREAM_NAME, 'GET', SERIES_PATH, `series[${index}] ${reason}`);
}

function parseSonarrSeries(raw: unknown, index: number): SonarrSeries {
  const s = asRecord(raw);
  if (!s) invalidSeries(index, 'is not an object');
  if (typeof s.id !== 'number') invalidSeries(index, 'is missing a numeric id');
  if (typeof s.tvdbId !== 'number') invalidSeries(index, `(id=${s.id}) is missing a numeric tvdbId`);
  if (typeof s.title !== 'string') invalidSeries(index, `(id=${s.id}) is missing a title`);
  if (typeof s.path !== 'string') invalidSeries(index, `(id=${s.id}) is missing a path`);

  const statistics = asRecord(s.statistics);

  return {
    id: s.id,
    tvdbId: s.tvdbId,
    title: s.title,
    year: typeof s.year === 'number' ? s.year : null,
    path: s.path,
    added: typeof s.added === 'string' ? s.added : null,
    sizeOnDisk: typeof statistics?.sizeOnDisk === 'number' ? statistics.sizeOnDisk : 0,
    episodeFileCount: typeof statistics?.episodeFileCount === 'number' ? statistics.episodeFileCount : 0,
  };
}

export class SonarrClient {
  constructor(private readonly http: UpstreamClient) {}

  /** `GET /api/v3/series` — every series in Sonarr's library. */
  async listSeries(): Promise<SonarrSeries[]> {
    const data = await this.http.request<unknown>(SERIES_PATH);
    if (!Array.isArray(data)) {
      throw new UpstreamError('invalid_response', UPSTREAM_NAME, 'GET', SERIES_PATH, 'expected an array from GET /api/v3/series');
    }
    return data.map((raw, index) => parseSonarrSeries(raw, index));
  }
}

/** Builds a `SonarrClient` wired to `SONARR_URL`/`SONARR_API_KEY` (`wiki/Configuration.md`). */
export function createSonarrClient(baseUrl: string, apiKey: string, timeoutMs: number, retries: number): SonarrClient {
  return new SonarrClient(
    new UpstreamClient({ name: UPSTREAM_NAME, baseUrl, auth: apiKeyAuth('X-Api-Key', apiKey), timeoutMs, retries }),
  );
}
