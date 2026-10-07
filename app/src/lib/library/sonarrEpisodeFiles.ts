/**
 * Sonarr episode-file client — `GET /api/v3/episodefile?seriesId={id}`,
 * verified against a live Sonarr instance's API: one object per file,
 * `{ seriesId, seasonNumber, relativePath, path, size, id, quality, ... }` —
 * `seasonNumber` and `size` (bytes) are both always present, no separate
 * call needed per season.
 *
 * A dedicated sibling file for this one concern, mirroring the "small
 * dedicated client per concern" shape `src/lib/deletion/arrActions.ts`
 * already uses, rather than folding a second, unrelated Sonarr endpoint
 * into `./sonarr.ts`'s existing `SonarrClient` (which owns `GET
 * /api/v3/series` only).
 *
 * `aggregateBytesBySeason` is a **pure function** (AGENTS.md rule 9),
 * deliberately kept separate from the fetch above it: raw episode-file rows
 * in, per-season byte totals out — no network, no DB — so it's
 * hand-testable from a synthetic fixture with no live call
 * (`test/library-sonarr.test.ts`).
 *
 * P4-1 Wave 1 scope note: this client and its aggregation are the read-side
 * capability only. Nothing in this repo calls `listEpisodeFiles` unless a
 * `title` row's `split_into_seasons` is already `true` (`src/lib/library/
 * sync.ts`), and nothing sets that flag yet — that's a later wave's
 * operator-triggered action.
 */
import { apiKeyAuth, UpstreamClient, UpstreamError } from '../http/client';

const UPSTREAM_NAME = 'sonarr';
const EPISODE_FILE_PATH = '/api/v3/episodefile';

export interface SonarrEpisodeFile {
  id: number;
  seriesId: number;
  seasonNumber: number;
  /** Bytes. */
  size: number;
  /**
   * Unix seconds, from Sonarr's `dateAdded` — when THIS file landed on disk,
   * which is not the same as when the series was added (`FR-ACCT-8`). `null`
   * if Sonarr omitted or malformed it; a null date is treated as "unknown, so
   * assume it predates nothing" by callers, i.e. it never silently converts
   * pre-existing bytes into caused-by-you ones.
   */
  dateAdded: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function invalidEpisodeFile(index: number, reason: string): never {
  throw new UpstreamError('invalid_response', UPSTREAM_NAME, 'GET', EPISODE_FILE_PATH, `episodefile[${index}] ${reason}`);
}

function parseSonarrEpisodeFile(raw: unknown, index: number): SonarrEpisodeFile {
  const f = asRecord(raw);
  if (!f) invalidEpisodeFile(index, 'is not an object');
  if (typeof f.id !== 'number') invalidEpisodeFile(index, 'is missing a numeric id');
  if (typeof f.seriesId !== 'number') invalidEpisodeFile(index, `(id=${f.id}) is missing a numeric seriesId`);
  if (typeof f.seasonNumber !== 'number') invalidEpisodeFile(index, `(id=${f.id}) is missing a numeric seasonNumber`);
  if (typeof f.size !== 'number') invalidEpisodeFile(index, `(id=${f.id}) is missing a numeric size`);

  // Deliberately NOT a hard validation failure: `dateAdded` is additive
  // (FR-ACCT-8) and a series full of files predating this field must not make
  // the whole episodefile response unparseable.
  const parsedDate = typeof f.dateAdded === 'string' ? Date.parse(f.dateAdded) : NaN;

  return {
    id: f.id,
    seriesId: f.seriesId,
    seasonNumber: f.seasonNumber,
    size: f.size,
    dateAdded: Number.isFinite(parsedDate) ? Math.floor(parsedDate / 1000) : null,
  };
}

export class SonarrEpisodeFileClient {
  constructor(private readonly http: UpstreamClient) {}

  /** `GET /api/v3/episodefile?seriesId={id}` — every episode-file row for one series. */
  async listEpisodeFiles(seriesId: number): Promise<SonarrEpisodeFile[]> {
    const data = await this.http.request<unknown>(EPISODE_FILE_PATH, { query: { seriesId } });
    if (!Array.isArray(data)) {
      throw new UpstreamError(
        'invalid_response',
        UPSTREAM_NAME,
        'GET',
        EPISODE_FILE_PATH,
        'expected an array from GET /api/v3/episodefile',
      );
    }
    return data.map((raw, index) => parseSonarrEpisodeFile(raw, index));
  }
}

/**
 * Pure aggregation (AGENTS.md rule 9): sums `size` per `seasonNumber` across
 * a series' raw episode-file rows. A season with no files in `files` simply
 * doesn't appear as a key — there's nothing to represent yet (mirrors why a
 * season row is only ever upserted for a season that actually has bytes on
 * disk, `src/lib/library/sync.ts`).
 */
export function aggregateBytesBySeason(files: SonarrEpisodeFile[]): Map<number, number> {
  const totals = new Map<number, number>();
  for (const f of files) {
    totals.set(f.seasonNumber, (totals.get(f.seasonNumber) ?? 0) + f.size);
  }
  return totals;
}

/** Builds a `SonarrEpisodeFileClient` wired to `SONARR_URL`/`SONARR_API_KEY` (`wiki/Configuration.md`). */
export function createSonarrEpisodeFileClient(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
  retries: number,
): SonarrEpisodeFileClient {
  return new SonarrEpisodeFileClient(
    new UpstreamClient({ name: UPSTREAM_NAME, baseUrl, auth: apiKeyAuth('X-Api-Key', apiKey), timeoutMs, retries }),
  );
}
