/**
 * Shared upstream HTTP client for every REST call this app makes — Seerr,
 * Radarr, Sonarr today; Jellyfin/Authentik in later backlog items (P1-3/P1-4)
 * reuse this same client rather than a second hand-rolled fetch wrapper.
 * `wiki/Configuration.md` §Scheduling is the source of truth for the two
 * knobs this file enforces:
 *
 *   - `UPSTREAM_TIMEOUT` (default 20s) bounds every call end-to-end
 *     (connect through reading the response body) via `AbortController`.
 *   - `UPSTREAM_RETRIES` (default 2) retries a failed call with backoff —
 *     EXCEPT a `DELETE`, which is **never** retried. This is a hard rule
 *     (AGENTS.md rule 11 / `wiki/Configuration.md`: "a retried delete against
 *     a re-used id could destroy the wrong thing"), enforced HERE inside
 *     `request()` itself — the attempt budget for `DELETE` is hardcoded to 1
 *     regardless of the `retries` a caller configures, so no call site can
 *     opt back in.
 *
 * Only 5xx responses, network errors, and timeouts are retried; a 4xx is a
 * definitive answer from the upstream (bad request/auth/not-found) that a
 * retry won't change, so it is never retried even for a non-`DELETE` method.
 *
 * **Secrets never leak into an error.** `UpstreamError` carries the upstream
 * name, method, path, HTTP status, and a snippet of the *response* body —
 * never the outgoing request's headers, so an `X-Api-Key`/`Authorization`
 * value can never appear in a thrown error's `message`, in
 * `JSON.stringify(err)` (see `toJSON()` below), or in anything else
 * serialisable. Auth is applied via a per-upstream `AuthStrategy` (below)
 * that mutates only the outgoing request's headers — it never touches, and
 * is never passed into, any error-construction path.
 */

export type RequestHeaders = Record<string, string>;

/** Applies auth to an outgoing request's headers, in place. Each upstream supplies its own — see file header. */
export type AuthStrategy = (headers: RequestHeaders) => void;

/**
 * Static `<headerName>: <apiKey>` — Seerr, Radarr, and Sonarr all authenticate
 * this way today, each with header name `X-Api-Key` (`wiki/Configuration.md`
 * §Secrets), passed explicitly rather than hardcoded so a future upstream
 * using a differently-named API-key header can still use this helper.
 */
export function apiKeyAuth(headerName: string, apiKey: string): AuthStrategy {
  return (headers) => {
    headers[headerName] = apiKey;
  };
}

/** Static `Authorization: Bearer <token>` — for a token-bearing upstream (e.g. Authentik's service token). */
export function bearerAuth(token: string): AuthStrategy {
  return (headers) => {
    headers['Authorization'] = `Bearer ${token}`;
  };
}

/** No auth at all — for an upstream call that genuinely needs none. */
export function noAuth(): AuthStrategy {
  return () => {
    // deliberately empty
  };
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface UpstreamRequestOptions {
  method?: HttpMethod;
  /** Appended to `baseUrl + path` as a query string. `undefined` values are omitted. */
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON-serialised as the request body when present. */
  body?: unknown;
}

/** The parsed body AND the observed HTTP status of a successful call — see `UpstreamClient.requestWithStatus`. */
export interface UpstreamResponse<T> {
  data: T;
  status: number;
}

export type UpstreamErrorCode = 'timeout' | 'network_error' | 'http_error' | 'invalid_json' | 'invalid_response';

const BODY_SNIPPET_MAX_LENGTH = 500;

/**
 * Carries enough context to debug (upstream name, method, path, HTTP status,
 * a truncated *response*-body snippet) and deliberately nothing else —
 * see this file's header comment on why no header/auth value ever reaches
 * here. `toJSON()` is defined explicitly so `JSON.stringify(err)` can't
 * accidentally pick up anything beyond these named fields (e.g. via a
 * future subclass or an added property) — this is the loggable/auditable
 * shape.
 */
export class UpstreamError extends Error {
  readonly code: UpstreamErrorCode;
  readonly upstream: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly status?: number;
  readonly bodySnippet?: string;

  constructor(
    code: UpstreamErrorCode,
    upstream: string,
    method: HttpMethod,
    path: string,
    message: string,
    opts?: { status?: number; bodySnippet?: string; cause?: unknown },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'UpstreamError';
    this.code = code;
    this.upstream = upstream;
    this.method = method;
    this.path = path;
    this.status = opts?.status;
    this.bodySnippet = opts?.bodySnippet;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      upstream: this.upstream,
      method: this.method,
      path: this.path,
      status: this.status,
      bodySnippet: this.bodySnippet,
      message: this.message,
    };
  }
}

export interface UpstreamClientConfig {
  /** Short, non-secret name used in error messages/logging, e.g. `"radarr"`. */
  name: string;
  baseUrl: string;
  auth: AuthStrategy;
  /** `UPSTREAM_TIMEOUT`, in ms. */
  timeoutMs: number;
  /** `UPSTREAM_RETRIES` — total attempts = `1 + retries`, except `DELETE` (always 1, see file header). */
  retries: number;
  /** Test seam; defaults to the real global `fetch` (Node 22 built-in — no dependency needed). */
  fetchImpl?: typeof fetch;
  /** Test seam for the backoff delay between retries; defaults to a real `setTimeout`-based sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
}

const BACKOFF_BASE_MS = 250;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function buildUrl(baseUrl: string, path: string, query?: UpstreamRequestOptions['query']): string {
  const url = new URL(baseUrl + path);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function isRetryableStatus(status: number): boolean {
  return status >= 500;
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof UpstreamError)) return false;
  if (err.code === 'timeout' || err.code === 'network_error') return true;
  if (err.code === 'http_error' && err.status !== undefined) return isRetryableStatus(err.status);
  // invalid_json/invalid_response: the upstream answered with garbage —
  // retrying the same request won't fix that, so don't.
  return false;
}

/** One client per upstream (one `baseUrl` + one `AuthStrategy`). Construct via the per-upstream factories in `src/lib/library`/`src/lib/seerr`, or directly for a new upstream. */
export class UpstreamClient {
  private readonly name: string;
  private readonly baseUrl: string;
  private readonly auth: AuthStrategy;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(config: UpstreamClientConfig) {
    this.name = config.name;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.auth = config.auth;
    this.timeoutMs = config.timeoutMs;
    this.retries = Math.max(0, config.retries);
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.sleepImpl = config.sleepImpl ?? defaultSleep;
  }

  /**
   * Issues one logical request, retrying per this file's header-comment
   * policy. Returns the parsed JSON body (or `undefined` for an empty body).
   * A thin wrapper over `requestWithStatus` for the (large majority of)
   * callers that only need the body — see that method if the observed HTTP
   * status matters too.
   */
  async request<T = unknown>(path: string, opts: UpstreamRequestOptions = {}): Promise<T> {
    const { data } = await this.requestWithStatus<T>(path, opts);
    return data;
  }

  /**
   * Same request/retry behaviour as `request`, but returns the OBSERVED HTTP
   * status alongside the parsed body, rather than discarding it. Exists for
   * callers that write the status into an audit row (`FR-DEL-7`: "recording
   * ... the response status") — recording a hardcoded assumed value there
   * instead of what the upstream actually returned would be exactly the kind
   * of small untruth the audit log exists to avoid.
   */
  async requestWithStatus<T = unknown>(path: string, opts: UpstreamRequestOptions = {}): Promise<UpstreamResponse<T>> {
    const method = opts.method ?? 'GET';
    const url = buildUrl(this.baseUrl, path, opts.query);

    // Hard rule, enforced unconditionally (AGENTS.md rule 11): a DELETE gets
    // exactly one attempt, no matter what `retries` this client was built
    // with. Not a parameter — a caller cannot opt back in.
    const maxAttempts = method === 'DELETE' ? 1 : this.retries + 1;

    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await this.attempt<T>(method, path, url, opts);
      } catch (err) {
        lastError = err;
        const isLastAttempt = attempt === maxAttempts - 1;
        if (isLastAttempt || !isRetryable(err)) throw err;
        await this.sleepImpl(BACKOFF_BASE_MS * 2 ** attempt);
      }
    }
    // Unreachable — the loop above always either returns or throws — but
    // keeps the compiler happy about every path returning/throwing.
    throw lastError;
  }

  private async attempt<T>(method: HttpMethod, path: string, url: string, opts: UpstreamRequestOptions): Promise<UpstreamResponse<T>> {
    const headers: RequestHeaders = {};
    this.auth(headers);
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new UpstreamError(
          'timeout',
          this.name,
          method,
          path,
          `${this.name} ${method} ${path} timed out after ${this.timeoutMs}ms`,
          { cause: err },
        );
      }
      throw new UpstreamError(
        'network_error',
        this.name,
        method,
        path,
        `could not reach ${this.name} (${method} ${path})`,
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
    }

    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      if (controller.signal.aborted) {
        throw new UpstreamError(
          'timeout',
          this.name,
          method,
          path,
          `${this.name} ${method} ${path} timed out after ${this.timeoutMs}ms while reading the response`,
          { cause: err },
        );
      }
      throw new UpstreamError(
        'network_error',
        this.name,
        method,
        path,
        `${this.name} ${method} ${path} response body could not be read`,
        { cause: err },
      );
    }

    if (!res.ok) {
      throw new UpstreamError('http_error', this.name, method, path, `${this.name} ${method} ${path} -> HTTP ${res.status}`, {
        status: res.status,
        bodySnippet: text.slice(0, BODY_SNIPPET_MAX_LENGTH),
      });
    }

    if (!text) return { data: undefined as T, status: res.status };
    try {
      return { data: JSON.parse(text) as T, status: res.status };
    } catch (err) {
      throw new UpstreamError('invalid_json', this.name, method, path, `${this.name} ${method} ${path} returned non-JSON`, {
        status: res.status,
        bodySnippet: text.slice(0, BODY_SNIPPET_MAX_LENGTH),
        cause: err,
      });
    }
  }
}
