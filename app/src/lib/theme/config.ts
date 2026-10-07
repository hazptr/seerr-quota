/**
 * Theming overrides config (wiki/Theming.md "Env vars"). Deliberately its
 * own module rather than living in `src/lib/config.ts` — see that file's
 * header comment and AGENTS.md: config.ts is owned by a parallel change in
 * this same working copy, so new parsing lands here instead of touching it.
 *
 * Three env vars, all optional, all read lazily (same discipline as
 * `src/lib/config.ts`'s `getConfig()` — nothing is read at import time):
 *
 *   - `THEME_CSS`    — absolute path, INSIDE THE CONTAINER, to a CSS file
 *     served verbatim at `GET /theme.css` (see
 *     `src/app/theme.css/route.ts`) and linked AFTER the built-in
 *     `globals.css` tokens in `src/app/layout.tsx`, so it can override any
 *     `--sq-*` token or add plain CSS rules — no rebuild required, since the
 *     image is prebuilt and this is mounted/read at request time. Unset ->
 *     the route 404s and no extra stylesheet is linked.
 *   - `APP_NAME`     — page title / brand text shown in the app shell and
 *     `<title>`. Default `"Seerr Quota"`.
 *   - `FAVICON_URL`  — URL (absolute path or full URL) used for the favicon
 *     `<link>`. Default `/favicon.svg`, the neutral icon shipped in
 *     `public/favicon.svg`. A deployment that wants its own mark points this
 *     at whatever its own reverse proxy serves (e.g. a `/favicon.svg` location
 *     aliased outside this app entirely).
 *
 * `THEME_CSS` is intentionally the ONLY source for the override path — it is
 * never read from a request (query param, header, cookie). `resolveThemePath`
 * below does not accept untrusted input; there is no code path anywhere in
 * this app that lets a client pick which file `/theme.css` serves.
 */
export interface EnvLike {
  [key: string]: string | undefined;
}

export interface ThemeConfig {
  /** Absolute path to the override CSS file, or `undefined` if `THEME_CSS` is unset/blank. */
  themeCssPath: string | undefined;
  /** `APP_NAME`, trimmed; falls back to the default when unset/blank. */
  appName: string;
  /** `FAVICON_URL`, trimmed; falls back to the default when unset/blank. */
  faviconUrl: string;
}

export const DEFAULT_APP_NAME = 'Seerr Quota';
export const DEFAULT_FAVICON_URL = '/favicon.svg';

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Pure function: env in, `ThemeConfig` out. No filesystem access here — the
 * route handler is responsible for actually reading `themeCssPath` (and for
 * treating a missing/unreadable file as "no override", not an error).
 */
export function resolveThemeConfig(env: EnvLike): ThemeConfig {
  return {
    themeCssPath: nonBlank(env.THEME_CSS),
    appName: nonBlank(env.APP_NAME) ?? DEFAULT_APP_NAME,
    faviconUrl: nonBlank(env.FAVICON_URL) ?? DEFAULT_FAVICON_URL,
  };
}

let cached: ThemeConfig | undefined;

/** Process-backed singleton, same lazy-read idiom as `src/lib/config.ts`'s `getConfig()`. */
export function getThemeConfig(): ThemeConfig {
  if (!cached) {
    cached = resolveThemeConfig(process.env);
  }
  return cached;
}

/** Test-only: drop the cached singleton so a test can call `getThemeConfig()` against a mutated `process.env`. */
export function __resetThemeConfigForTests(): void {
  cached = undefined;
}
