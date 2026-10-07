/**
 * Typed configuration loader. `wiki/Configuration.md` is the single source
 * of truth for every key, its default, and its precedence:
 *
 *   environment variable  →  config.yaml value  →  built-in default
 *
 * Mirrors the shape of a sibling internal tool this project was built
 * alongside (AGENTS.md: "copy that project's shape rather than re-deriving
 * it").
 *
 * One extra precedence layer exists ABOVE all three of these for the six
 * "Runtime settings (DB-backed, operator-editable)" in `wiki/Configuration.md`:
 * once a value is written to the `app_setting` table, the DB wins over env,
 * config.yaml, and the built-in default. `Config.runtime` below resolves only
 * the env→yaml→default seed value — it is what a first boot writes into
 * `app_setting`, and what boot validation checks before that table can even
 * be assumed to exist. Reading `app_setting` back out and having it win on
 * every subsequent boot is a runtime-settings-editor concern that lands with
 * the admin UI (P1-9 / P2-2), not this scaffold.
 *
 * Seven secrets come from the environment ONLY — never from `config.yaml` —
 * per `wiki/Configuration.md` "Secrets — `.env` only" and AGENTS.md rule 7.
 * They split into three REQUIREDNESS tiers, all enforced in `validateConfig`
 * below:
 *   - `SEERR_API_KEY`, `RADARR_API_KEY`, `SONARR_API_KEY`,
 *     `SEERR_WEBHOOK_SECRET` — UNCONDITIONALLY required. This app has no
 *     per-upstream enable/disable flag, so it can't do its job without any
 *     of these three APIs + the webhook secret.
 *   - `JELLYFIN_API_KEY` — required ONLY when `upstreams.jellyfinPlaybackSource`
 *     is `rest` (the default). The legacy `db` fallback reads Jellyfin's own
 *     SQLite file instead and needs no key.
 *   - `SMTP_USER`, `SMTP_PASS` — required ONLY when `runtime.enforcementEnabled`
 *     is true. Accounting/observation (`enforcement_enabled = false`) needs
 *     no mail path at all; enforcement does, because `D-4a` (Seerr can't carry
 *     a decline reason) makes this app's own hold notification the ONLY way a
 *     held member finds out why.
 *
 * `APP_URL` (this app's own public URL, used in notification links and the
 * in-Seerr banner) is ALSO unconditionally required — it has no sane generic
 * default. `ADMIN_USERS` has no built-in default either, for the same
 * reason. `SMTP_HOST`/`SMTP_FROM` DO ship with generic `example.com`
 * placeholder defaults rather than being required, since a real deployment
 * will virtually always want to set them explicitly anyway and gating boot
 * on them would be one more thing to configure before the app's happy path
 * (pure accounting, enforcement off) can even be tried.
 * This module never logs a secret value; `resolveConfig` doesn't log at all,
 * and callers must not `JSON.stringify`/log the `secrets` branch of the
 * returned `Config`.
 *
 * **Since 0.2.0 this app has no built-in identity provider integration at
 * all** — it is IdP-agnostic, trusting whatever forward-auth proxy sits in
 * front of it (Authentik, Authelia, oauth2-proxy in front of any OIDC IdP,
 * Pomerium, ...) to authenticate and inject the configured headers
 * (`AUTH_USER_HEADER`/`AUTH_GROUPS_HEADER`/`AUTH_EMAIL_HEADER`, defaults
 * `Remote-User`/`Remote-Groups`/`Remote-Email`). `AUTHENTIK_URL`,
 * `AUTHENTIK_TOKEN`, `SEERR_APP_SLUG`, `SELF_APP_SLUG`,
 * `AUTHENTIK_JELLYSEERR_APP_UUID` no longer exist as settings — a value left
 * over for any of them in an existing deployment's `.env` is silently
 * ignored (never read), so an upgrade never fails to boot over it; see
 * `detectLegacyAuthentikEnv` below (called from `src/instrumentation.ts`)
 * for the one-line, no-values boot log emitted when it spots one.
 *
 * `resolveConfig` is a pure function (env + config.yaml text in, `Config`
 * out) so precedence is hand-testable without touching the filesystem or
 * `process.env`. `getConfig()` is the process-backed singleton the rest of
 * the app uses; it lazily reads `process.env` and the optional mounted
 * `/config/config.yaml` on first call — nothing is read at import time (the
 * same lazy discipline as `getDb()` in `src/lib/db/index.ts`), so a container
 * build/`next build`/`vitest run` never requires the config mount to exist.
 */
import fs from 'node:fs';
import path from 'node:path';

/** A minimal environment-like record; `process.env` satisfies this. */
export type EnvLike = Record<string, string | undefined>;

export interface Config {
  /** `wiki/Configuration.md` §Identity. */
  identity: {
    /**
     * `ADMIN_USERS` (no default — required, see boot validation) —
     * comma-separated login usernames treated as operator (request-time: by
     * resolved member key OR raw header username; background/enforcement
     * exemption: by `member.sso_username` only — see
     * `src/lib/auth/identity.ts` and `src/lib/members/classify.ts`).
     */
    adminUsers: string[];
    /** `ADMIN_GROUP` (default `admins`) — forward-auth group (any IdP) that also grants operator status AT REQUEST TIME ONLY; no groups header exists off-request, so this never affects `member.is_operator` (`FR-ENF-6`'s background half) — see `wiki/Configuration.md`. */
    adminGroup: string;
    /** `AUTH_USER_HEADER` (default `Remote-User`) — the forward-auth header the reverse proxy (any IdP) is configured to overwrite with the authenticated login username on every request. */
    userHeader: string;
    /** `AUTH_GROUPS_HEADER` (default `Remote-Groups`) — same idea, for group membership; split on `|`/`,` as before. */
    groupsHeader: string;
    /** `AUTH_EMAIL_HEADER` (default `Remote-Email`) — optional; used only for the one-time email-based member-resolution fallback (`src/lib/auth/memberGate.ts`). */
    emailHeader: string;
  };
  /** `wiki/Configuration.md` §"Upstream endpoints". Always in use — this app has no per-upstream enable/disable flag. */
  upstreams: {
    /** `SEERR_URL` (default `http://jellyseerr:5055`) — container name stays `jellyseerr` post-rebrand. */
    seerrUrl: string;
    /** `RADARR_URL` (default `http://radarr:7878`) — reachable only over the shared Docker network, not published to the host. */
    radarrUrl: string;
    /** `SONARR_URL` (default `http://sonarr:8989`). */
    sonarrUrl: string;
    /** `JELLYFIN_URL` (default `http://jellyfin:8096`). */
    jellyfinUrl: string;
    /**
     * `JELLYFIN_PLAYBACK_SOURCE` (`db` | `rest`, default `rest`). `rest` reads
     * playback state via Jellyfin's own REST API and requires
     * `JELLYFIN_API_KEY`. `db` — the legacy fallback, still supported — opens
     * a read-only connection to Jellyfin's live WAL-mode SQLite file instead;
     * that file can't be opened read-only from a `:ro` single-file bind mount
     * in WAL mode ("attempt to write a readonly database"), which makes
     * playback-state lookups fail, which (per the fail-open/fail-closed rule
     * for deletion guards) blocks every deletion — the reason `rest` is now
     * the default rather than `db`.
     */
    jellyfinPlaybackSource: 'db' | 'rest';
    /**
     * `APP_URL` (no default — required, see boot validation) — this app's own
     * public URL. Not a constant: it ends up in outbound member-notification
     * email (`FR-ENF-3`) and in another application's chrome (the in-Seerr
     * banner, `FR-BAN-6`), so it has to be configurable per
     * `wiki/Configuration.md`.
     */
    appUrl: string;
  };
  /**
   * `wiki/Configuration.md` §"Upstream endpoints" (the SMTP rows). Split out
   * of `upstreams` above because these three are non-secret CONNECTION
   * settings for the mail relay, not a REST API base URL — the SMTP
   * credentials live in `secrets` below, split by the same
   * unconditional-vs-conditional line documented on this file's header
   * comment.
   */
  smtp: {
    /** `SMTP_HOST` (default `mail.example.com` — placeholder; point this at any SMTP relay, e.g. Proton Bridge, a local Postfix/MSA, or your provider's SMTP). */
    host: string;
    /** `SMTP_PORT` (default `25`) — container port, STARTTLS. */
    port: number;
    /** `SMTP_FROM` (default `quota@example.com` — placeholder; this app's own identity, not Seerr's). */
    from: string;
  };
  /** `wiki/Configuration.md` §"Secrets — `.env` only". Env-only; never read from `config.yaml`, never logged, never rendered to a client, never in an audit row (`FR-AUD-11`). */
  secrets: {
    /** `SEERR_API_KEY` — Seerr: Settings -> General -> API Key. Unconditionally required. */
    seerrApiKey: string;
    /** `RADARR_API_KEY` — Radarr: Settings -> General -> Security -> API Key. Unconditionally required. */
    radarrApiKey: string;
    /** `SONARR_API_KEY` — Sonarr: Settings -> General -> Security -> API Key. Unconditionally required. */
    sonarrApiKey: string;
    /** `JELLYFIN_API_KEY` — a dedicated key created in the Jellyfin admin UI. Required ONLY when `upstreams.jellyfinPlaybackSource` is `rest` (the default). */
    jellyfinApiKey: string;
    /** `SEERR_WEBHOOK_SECRET` — generated; also pasted into Seerr's webhook custom header. Unconditionally required. */
    seerrWebhookSecret: string;
    /** `SMTP_USER` — SMTP relay credential. Required ONLY when `runtime.enforcementEnabled` is true (`D-4a`). */
    smtpUser: string;
    /** `SMTP_PASS` — SMTP relay credential. Required ONLY when `runtime.enforcementEnabled` is true (`D-4a`). */
    smtpPass: string;
  };
  /**
   * `wiki/Configuration.md` §"Runtime settings (DB-backed, operator-editable)".
   * These are the env→config.yaml→default SEED values only — see this file's
   * header comment. `defaultQuotaBytes` deliberately has no built-in default:
   * `undefined` means "operator has not decided yet", and per the wiki this
   * is NOT itself a boot-validation failure — accounting runs and enforcement
   * stays off regardless of `enforcementEnabled` until it's set.
   */
  runtime: {
    /** `DEFAULT_QUOTA_BYTES` — no default. `undefined` until the operator sets one. */
    defaultQuotaBytes: number | undefined;
    /** `ENFORCEMENT_ENABLED` (default `false`) — master switch (`FR-POL-7`). Ships off. */
    enforcementEnabled: boolean;
    /** `GRACE_BYTES` (default `0`) — allowance above quota before declining (`FR-POL-8`). */
    graceBytes: number;
    /** `DELETE_RECENT_PLAY_DAYS` (default `14`) — playback window that blocks deletion (`FR-DEL-4`). */
    deleteRecentPlayDays: number;
    /** `DELETE_IN_PROGRESS_DAYS` (default `90`) — window for the `in_progress` deletion guard (someone partway through, not yet finished). Deliberately much wider than `deleteRecentPlayDays`: a false block costs one undeletable title, a false allow costs someone their show (`wiki/Configuration.md`). */
    deleteInProgressDays: number;
    /** `STALE_SNAPSHOT_MAX_AGE_S` (default `3600`) — older than this, enforcement skips (`FR-ENF-4`). */
    staleSnapshotMaxAgeS: number;
    /** `DELETE_MAX_PER_HOUR` (default `25`) — per-member deletion rate limit (`FR-DEL-12`). */
    deleteMaxPerHour: number;
    /** `HOLD_MAX_DAYS` (default `30`) — auto-decline safety valve for a request held this long; `0` = never (`FR-ENF-12`). */
    holdMaxDays: number;
    /** `NOTIFY_COOLDOWN_S` (default `86400`) — min gap between hold notifications to one member (`FR-ENF-14`). */
    notifyCooldownS: number;
  };
  /** `wiki/Configuration.md` §Scheduling. */
  scheduling: {
    /** `RECONCILE_INTERVAL` (default `15m`) — full reconcile + pending sweep, parsed to milliseconds. */
    reconcileIntervalMs: number;
    /** The raw, unparsed `RECONCILE_INTERVAL` string, for display. */
    reconcileIntervalRaw: string;
    /** `RECONCILE_ON_BOOT` (default `true`) — run once at startup. */
    reconcileOnBoot: boolean;
    /** `WEBHOOK_ENABLED` (default `true`) — low-latency path; the poller still runs regardless (`D-4`). */
    webhookEnabled: boolean;
    /** `UPSTREAM_TIMEOUT` (default `20s`) — per-upstream HTTP call timeout, parsed to milliseconds. */
    upstreamTimeoutMs: number;
    /** `UPSTREAM_RETRIES` (default `2`) — with backoff; never retry a `DELETE` (a rule, not a tunable). */
    upstreamRetries: number;
    /**
     * `DELETE_GRACE_PERIOD` (default `24h`) — how long a member-scheduled file
     * deletion sits cancellable before the sweeper may execute it (`D-7`,
     * `FR-DEL-22`), parsed to milliseconds. `0` disables the grace period
     * entirely and restores the pre-`FR-DEL-22` behaviour where confirming
     * deletes immediately; boot validation rejects a negative value.
     */
    deleteGracePeriodMs: number;
    /** The raw, unparsed `DELETE_GRACE_PERIOD` string, for display on the confirm screen. */
    deleteGracePeriodRaw: string;
    /**
     * `DELETE_SWEEP_INTERVAL` (default `5m`) — how often the sweeper looks for
     * due deletions, parsed to milliseconds. Deliberately much shorter than the
     * grace period: it bounds only how far PAST `scheduled_for` an execution
     * can drift, never how early it can happen (the sweeper re-checks
     * `scheduled_for <= now` itself — `FR-DEL-25`).
     */
    deleteSweepIntervalMs: number;
    /** The raw, unparsed `DELETE_SWEEP_INTERVAL` string, for display. */
    deleteSweepIntervalRaw: string;
  };
  /** `wiki/Configuration.md` §Paths. */
  paths: {
    /** `DB_PATH` (default `/db/seerr-quota.db`) — bind-mounted from `configs/seerr-quota/db/`. */
    dbPath: string;
    /** `MEDIA_FREE_SPACE_PATH` (default `/mnt/media`) — read-only mount, for free-space reporting (`FR-ADM-2`). */
    mediaFreeSpacePath: string;
    /**
     * `JELLYFIN_DB_PATH` (default `/jellyfin-db/jellyfin.db`) — read-only bind
     * mount of Jellyfin's SQLite DB, the documented fallback for playback state
     * (P1-4). Jellyfin's REST API needs an API key this app does not have; once
     * one exists, playback moves to REST and this goes away. See
     * `src/lib/jellyfin/sqliteSource.ts`.
     */
    jellyfinDbPath: string;
    /** `LOG_LEVEL` (default `info`) — audit JSON lines are emitted regardless of level. */
    logLevel: string;
  };
  /** `wiki/Configuration.md` §Display. */
  display: {
    /** `TZ` (default `UTC`) — can be overridden to match your deployment's local time. */
    tz: string;
    /** `SIZE_UNITS` (default `decimal`) — GB = 10⁹ (`FR-ACCT-9`). Must be consistent app-wide. */
    sizeUnits: 'decimal' | 'binary';
  };
}

/** Scalar value shapes that can come out of the minimal YAML parser below. */
export type YamlScalar = string | number | boolean | null;
export type FileConfig = Record<string, YamlScalar>;

/**
 * A deliberately minimal parser for the flat, non-secret `config.yaml` shape
 * documented in `wiki/Configuration.md` (a top-level mapping of the same
 * SCREAMING_SNAKE_CASE keys as the environment variables, one per line, to
 * scalar values). An empty file/string is valid and yields `{}`. Not a
 * general YAML parser (no nesting, lists, anchors, multi-line scalars, or
 * flow collections); config.yaml doesn't need any of that.
 *
 * Supported per non-blank, non-comment line: `KEY: value`, where `value` is
 * `true`/`false`, `null`/`~`/empty, an integer/float, a single- or
 * double-quoted string, or a bare unquoted string (taken verbatim, trimmed).
 * `#` starts a full-line comment only (a `#` inside a quoted value is kept).
 */
export function parseSimpleYaml(text: string): FileConfig {
  const out: FileConfig = {};
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const sepIndex = line.indexOf(':');
    if (sepIndex === -1) continue; // not a `key: value` line — ignore rather than throw
    const key = line.slice(0, sepIndex).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    const rawValue = line.slice(sepIndex + 1).trim();
    out[key] = parseYamlScalar(rawValue);
  }
  return out;
}

function parseYamlScalar(raw: string): YamlScalar {
  if (raw === '' || raw === '~' || raw.toLowerCase() === 'null') return null;
  if (raw.toLowerCase() === 'true') return true;
  if (raw.toLowerCase() === 'false') return false;
  const quoted = matchQuoted(raw);
  if (quoted !== undefined) return quoted;
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
  return raw;
}

function matchQuoted(raw: string): string | undefined {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1);
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1);
  }
  return undefined;
}

/**
 * `env` wins if it is set to a non-empty string; otherwise `file` wins if the
 * key is present (including an explicit `null`, which is treated as "not
 * set" so the default still applies); otherwise the built-in default.
 */
function resolveRaw(env: EnvLike, file: FileConfig, key: string): string | number | boolean | undefined {
  const envValue = env[key];
  if (envValue !== undefined && envValue !== '') return envValue;
  const fileValue = file[key];
  if (fileValue !== undefined && fileValue !== null) return fileValue;
  return undefined;
}

function str(env: EnvLike, file: FileConfig, key: string, def: string): string {
  const v = resolveRaw(env, file, key);
  return v === undefined ? def : String(v);
}

function num(env: EnvLike, file: FileConfig, key: string, def: number): number {
  const v = resolveRaw(env, file, key);
  if (v === undefined) return def;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : def;
}

function optNum(env: EnvLike, file: FileConfig, key: string): number | undefined {
  const v = resolveRaw(env, file, key);
  if (v === undefined) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Like `str`, but with no default — `undefined` when the setting genuinely isn't configured, rather than coercing "unset" into an empty string. */
function optStr(env: EnvLike, file: FileConfig, key: string): string | undefined {
  const v = resolveRaw(env, file, key);
  if (v === undefined) return undefined;
  const s = String(v).trim();
  return s.length > 0 ? s : undefined;
}

function bool(env: EnvLike, file: FileConfig, key: string, def: boolean): boolean {
  const v = resolveRaw(env, file, key);
  if (v === undefined) return def;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

function csv(env: EnvLike, file: FileConfig, key: string, def: string[]): string[] {
  const raw = str(env, file, key, def.join(','));
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Env-only: never consults `config.yaml`, per the secrets rule above. */
function secretFromEnv(env: EnvLike, key: string): string {
  return env[key] ?? '';
}

/**
 * Parses a duration string of the shape `<number><unit>` where unit is one of
 * `ms`/`s`/`m`/`h` (a bare number is treated as whole seconds, matching
 * `wiki/Configuration.md`'s `20s`/`15m` style). Falls back to `defMs` on
 * anything unparseable rather than throwing — a bad duration string is a
 * misconfiguration a human should notice via behaviour, not a boot crash
 * this scaffold's validator doesn't (yet) cover.
 */
const DURATION_UNIT_MULTIPLIERS_MS: Record<'ms' | 's' | 'm' | 'h', number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

export function parseDurationMs(raw: string, defMs: number): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(raw.trim());
  if (!match) return defMs;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return defMs;
  const unitRaw = match[2] ?? 's';
  const unit = (unitRaw === 'ms' || unitRaw === 's' || unitRaw === 'm' || unitRaw === 'h' ? unitRaw : 's') as
    | 'ms'
    | 's'
    | 'm'
    | 'h';
  return Math.round(value * DURATION_UNIT_MULTIPLIERS_MS[unit]);
}

/**
 * Settings removed in 0.2.0 (the Authentik-specific integration — see
 * `CHANGELOG.md` "Breaking/Upgrade notes"). Listed here ONLY so
 * `detectLegacyAuthentikEnv` can name them in a single deprecation line at
 * boot; `resolveConfig` never reads any of them.
 */
const REMOVED_AUTHENTIK_ENV_KEYS = [
  'AUTHENTIK_URL',
  'AUTHENTIK_TOKEN',
  'SEERR_APP_SLUG',
  'SELF_APP_SLUG',
  'AUTHENTIK_JELLYSEERR_APP_UUID',
] as const;

/**
 * Returns the names (never the values — these may be secrets) of any 0.2.0-
 * removed Authentik env vars still present and non-empty in `env`. An
 * existing deployment's `.env` left over from before this cutover MUST NOT
 * fail to boot over this (config contract: unknown leftover vars are
 * ignored) — this is purely an informational one-line boot log, wired up by
 * `src/instrumentation.ts`.
 */
export function detectLegacyAuthentikEnv(env: EnvLike): string[] {
  return REMOVED_AUTHENTIK_ENV_KEYS.filter((key) => optStr(env, {}, key) !== undefined);
}

/**
 * Pure resolver: `env` + the raw text of an (optional) `config.yaml` in, a
 * fully-typed `Config` out. No filesystem or network access — inject
 * whatever you want to hand-test precedence. `yamlText` may be `undefined`
 * (no mounted file) or `''` (an empty-but-present file); both behave as "no
 * override from config.yaml".
 */
export function resolveConfig(env: EnvLike, yamlText?: string): Config {
  const file = parseSimpleYaml(yamlText ?? '');

  const reconcileIntervalRaw = str(env, file, 'RECONCILE_INTERVAL', '15m');
  const upstreamTimeoutRaw = str(env, file, 'UPSTREAM_TIMEOUT', '20s');
  const deleteGracePeriodRaw = str(env, file, 'DELETE_GRACE_PERIOD', '24h');
  const deleteSweepIntervalRaw = str(env, file, 'DELETE_SWEEP_INTERVAL', '5m');
  const sizeUnitsRaw = str(env, file, 'SIZE_UNITS', 'decimal');

  return {
    identity: {
      adminUsers: csv(env, file, 'ADMIN_USERS', []),
      adminGroup: str(env, file, 'ADMIN_GROUP', 'admins'),
      userHeader: str(env, file, 'AUTH_USER_HEADER', 'Remote-User'),
      groupsHeader: str(env, file, 'AUTH_GROUPS_HEADER', 'Remote-Groups'),
      emailHeader: str(env, file, 'AUTH_EMAIL_HEADER', 'Remote-Email'),
    },
    upstreams: {
      seerrUrl: str(env, file, 'SEERR_URL', 'http://jellyseerr:5055'),
      radarrUrl: str(env, file, 'RADARR_URL', 'http://radarr:7878'),
      sonarrUrl: str(env, file, 'SONARR_URL', 'http://sonarr:8989'),
      jellyfinUrl: str(env, file, 'JELLYFIN_URL', 'http://jellyfin:8096'),
      jellyfinPlaybackSource:
        str(env, file, 'JELLYFIN_PLAYBACK_SOURCE', 'rest') === 'db' ? 'db' : 'rest',
      appUrl: str(env, file, 'APP_URL', ''),
    },
    smtp: {
      host: str(env, file, 'SMTP_HOST', 'mail.example.com'),
      port: num(env, file, 'SMTP_PORT', 25),
      from: str(env, file, 'SMTP_FROM', 'quota@example.com'),
    },
    secrets: {
      seerrApiKey: secretFromEnv(env, 'SEERR_API_KEY'),
      radarrApiKey: secretFromEnv(env, 'RADARR_API_KEY'),
      sonarrApiKey: secretFromEnv(env, 'SONARR_API_KEY'),
      jellyfinApiKey: secretFromEnv(env, 'JELLYFIN_API_KEY'),
      seerrWebhookSecret: secretFromEnv(env, 'SEERR_WEBHOOK_SECRET'),
      smtpUser: secretFromEnv(env, 'SMTP_USER'),
      smtpPass: secretFromEnv(env, 'SMTP_PASS'),
    },
    runtime: {
      defaultQuotaBytes: optNum(env, file, 'DEFAULT_QUOTA_BYTES'),
      enforcementEnabled: bool(env, file, 'ENFORCEMENT_ENABLED', false),
      graceBytes: num(env, file, 'GRACE_BYTES', 0),
      deleteRecentPlayDays: num(env, file, 'DELETE_RECENT_PLAY_DAYS', 14),
      deleteInProgressDays: num(env, file, 'DELETE_IN_PROGRESS_DAYS', 90),
      staleSnapshotMaxAgeS: num(env, file, 'STALE_SNAPSHOT_MAX_AGE_S', 3600),
      deleteMaxPerHour: num(env, file, 'DELETE_MAX_PER_HOUR', 25),
      holdMaxDays: num(env, file, 'HOLD_MAX_DAYS', 30),
      notifyCooldownS: num(env, file, 'NOTIFY_COOLDOWN_S', 86400),
    },
    scheduling: {
      reconcileIntervalMs: parseDurationMs(reconcileIntervalRaw, 15 * 60_000),
      reconcileIntervalRaw,
      reconcileOnBoot: bool(env, file, 'RECONCILE_ON_BOOT', true),
      webhookEnabled: bool(env, file, 'WEBHOOK_ENABLED', true),
      upstreamTimeoutMs: parseDurationMs(upstreamTimeoutRaw, 20_000),
      upstreamRetries: num(env, file, 'UPSTREAM_RETRIES', 2),
      deleteGracePeriodMs: parseDurationMs(deleteGracePeriodRaw, 24 * 60 * 60_000),
      deleteGracePeriodRaw,
      deleteSweepIntervalMs: parseDurationMs(deleteSweepIntervalRaw, 5 * 60_000),
      deleteSweepIntervalRaw,
    },
    paths: {
      dbPath: str(env, file, 'DB_PATH', '/db/seerr-quota.db'),
      mediaFreeSpacePath: str(env, file, 'MEDIA_FREE_SPACE_PATH', '/mnt/media'),
      jellyfinDbPath: str(env, file, 'JELLYFIN_DB_PATH', '/jellyfin-db/jellyfin.db'),
      logLevel: str(env, file, 'LOG_LEVEL', 'info'),
    },
    display: {
      tz: str(env, file, 'TZ', 'UTC'),
      sizeUnits: sizeUnitsRaw === 'binary' ? 'binary' : 'decimal',
    },
  };
}

// ---------------------------------------------------------------------------
// Boot validation — wiki/Configuration.md §"Validation at boot".
//
// The app MUST refuse to start on a misconfiguration it cannot safely
// proceed under, and MUST say exactly which setting is wrong. It MUST start,
// degraded and loudly, when an upstream is merely *unreachable* — that's a
// runtime condition (checked by the reconciler, not built yet — P1-3..P1-5),
// not a misconfiguration, so no network call is made here at all.
// ---------------------------------------------------------------------------

export interface BootValidationError {
  /** The setting name as documented in wiki/Configuration.md (env var or runtime key). */
  setting: string;
  /** Human-readable reason, safe to print to stderr/stdout (never includes secret values). */
  message: string;
}

/** Raised by `assertBootValid` when one or more boot-validation checks fail. */
export class BootValidationFailure extends Error {
  constructor(public readonly errors: BootValidationError[]) {
    super(
      ['seerr-quota refused to start due to configuration errors:', ...errors.map((e) => `  - ${e.setting}: ${e.message}`)].join(
        '\n',
      ),
    );
    this.name = 'BootValidationFailure';
  }
}

/**
 * Pure validation over an already-resolved `Config` — no filesystem or
 * network access, so precedence-adjacent misconfigurations are hand-testable
 * without touching disk. `checkDbPathWritable` below is the one boot check
 * that necessarily touches the filesystem and is kept separate for that
 * reason.
 *
 * Checks, per wiki/Configuration.md:
 *   - Any missing secret for an upstream it's configured to use. This app
 *     has no per-upstream enable/disable flag (Seerr/Radarr/Sonarr/Jellyfin
 *     are all always in use per wiki/Architecture.md's data-source table),
 *     so the Seerr/Radarr/Sonarr secrets + the webhook secret are required
 *     unconditionally; `JELLYFIN_API_KEY` is required only when
 *     `JELLYFIN_PLAYBACK_SOURCE` is `rest` (the default). Identity has no
 *     secret of its own since 0.2.0 — it's just the configured header names
 *     a trusted forward-auth proxy (any IdP) is assumed to set.
 *   - `ADMIN_USERS` empty (nobody could administer it).
 *   - `APP_URL` empty — deployment-specific with no sane generic default;
 *     this app always needs its own public URL for notification links and
 *     the in-Seerr banner.
 *   - `enforcement_enabled = true` with SMTP unconfigured (`SMTP_USER`/
 *     `SMTP_PASS` missing). Per `D-4a`
 *     (wiki/Feature-05-Enforcement.md): Seerr can't carry a decline/hold
 *     reason, so this app's own email IS the only way a held member finds
 *     out why — enforcement without a working mail path is exactly the
 *     silent-lockout failure mode `D-4a` exists to prevent, so it must not
 *     be startable. `SMTP_HOST`/`SMTP_PORT`/`SMTP_FROM` are never checked
 *     here — all three have valid built-in defaults, so "SMTP unconfigured"
 *     can only mean the credentials are missing.
 *   - `enforcement_enabled = true` with `default_quota_bytes` UNSET (`FR-POL-2`).
 *     `default_quota_bytes` is deliberately allowed to be unset for pure
 *     accounting/observation — but once enforcement is on, every member
 *     without an override needs a resolvable effective quota
 *     (`src/lib/members/quota.ts`'s `resolveEffectiveQuota`), and "nobody has
 *     decided yet" is NOT a value enforcement may treat as a limit. Note this
 *     is orthogonal to `default_quota_bytes = 0`: `0` IS a decision
 *     ("explicitly unlimited") and does NOT trigger this error — only the
 *     unset state does.
 *   - `grace_bytes` negative, or larger than `default_quota_bytes`. Skipped
 *     when `default_quota_bytes` is unset — an unset default quota is a
 *     documented degraded-but-valid state (accounting runs, enforcement
 *     stays off), not itself a boot failure.
 */
export function validateConfig(config: Config): BootValidationError[] {
  const errors: BootValidationError[] = [];

  const requiredSecrets: Array<[string, string]> = [
    ['SEERR_API_KEY', config.secrets.seerrApiKey],
    ['RADARR_API_KEY', config.secrets.radarrApiKey],
    ['SONARR_API_KEY', config.secrets.sonarrApiKey],
    ['SEERR_WEBHOOK_SECRET', config.secrets.seerrWebhookSecret],
  ];
  for (const [name, value] of requiredSecrets) {
    if (value.trim() === '') {
      errors.push({
        setting: name,
        message: `missing — required for the upstream this app is configured to use (see wiki/Configuration.md §Secrets)`,
      });
    }
  }

  if (config.identity.adminUsers.length === 0) {
    errors.push({
      setting: 'ADMIN_USERS',
      message: 'must not be empty — nobody could administer the app',
    });
  }

  if (config.upstreams.appUrl.trim() === '') {
    errors.push({
      setting: 'APP_URL',
      message:
        'missing — required; this app has no default public URL and needs one for outbound notification links and the in-Seerr banner (see wiki/Configuration.md)',
    });
  }

  // `JELLYFIN_API_KEY` is required only when the playback source is `rest`
  // (the default). The legacy `db` fallback reads Jellyfin's SQLite file
  // directly instead, so the REST API key is dead weight in that mode —
  // demanding it would make the app unbootable for a credential it never
  // uses.
  if (config.upstreams.jellyfinPlaybackSource === 'rest' && config.secrets.jellyfinApiKey.trim() === '') {
    errors.push({
      setting: 'JELLYFIN_API_KEY',
      message: 'missing — required because JELLYFIN_PLAYBACK_SOURCE is `rest` (see wiki/Configuration.md)',
    });
  }

  // Pure accounting (enforcement_enabled = false) sends no mail and needs no
  // SMTP credentials at all — see this function's doc comment and D-4a.
  if (config.runtime.enforcementEnabled) {
    if (config.secrets.smtpUser.trim() === '') {
      errors.push({
        setting: 'SMTP_USER',
        message: 'missing — required because enforcement_enabled is true and this app must be able to notify held members (D-4a)',
      });
    }
    if (config.secrets.smtpPass.trim() === '') {
      errors.push({
        setting: 'SMTP_PASS',
        message: 'missing — required because enforcement_enabled is true and this app must be able to notify held members (D-4a)',
      });
    }
    // FR-POL-2: an unset default quota is a valid degraded state for pure
    // accounting, but enforcing an UNDECIDED limit is worse than not booting
    // — 0 ("explicitly unlimited") is a real decision and does NOT trip this;
    // only `undefined` ("nobody has decided yet") does.
    if (config.runtime.defaultQuotaBytes === undefined) {
      errors.push({
        setting: 'DEFAULT_QUOTA_BYTES',
        message:
          'missing — required because enforcement_enabled is true; enforcing an undecided default quota is worse than not booting (FR-POL-2). Set DEFAULT_QUOTA_BYTES=0 if the intent is genuinely "no limit yet".',
      });
    }
  }

  // FR-DEL-22: the grace period is what makes a member-scheduled deletion
  // undoable. A negative parse would make `scheduled_for` land in the PAST,
  // so the very first sweep would execute every "scheduled" delete instantly
  // — silently turning the undo window off while the UI still promises it.
  // Refuse to boot rather than lie to members about it.
  if (config.scheduling.deleteGracePeriodMs < 0) {
    errors.push({
      setting: 'DELETE_GRACE_PERIOD',
      message: `must not be negative (parsed ${config.scheduling.deleteGracePeriodMs}ms from "${config.scheduling.deleteGracePeriodRaw}") — a negative grace period would execute every scheduled deletion on the next sweep, with no undo window at all (FR-DEL-22)`,
    });
  }

  // A sweep interval of 0/negative would spin the sweeper as fast as the event
  // loop allows. Unlike the grace period, there is no meaningful "off" value
  // here — not sweeping at all would strand every scheduled deletion forever.
  if (config.scheduling.deleteSweepIntervalMs <= 0) {
    errors.push({
      setting: 'DELETE_SWEEP_INTERVAL',
      message: `must be positive (parsed ${config.scheduling.deleteSweepIntervalMs}ms from "${config.scheduling.deleteSweepIntervalRaw}") — scheduled deletions would either never execute or spin the sweeper continuously`,
    });
  }

  if (config.runtime.graceBytes < 0) {
    errors.push({ setting: 'grace_bytes', message: 'must not be negative' });
  } else if (
    config.runtime.defaultQuotaBytes !== undefined &&
    config.runtime.graceBytes > config.runtime.defaultQuotaBytes
  ) {
    errors.push({
      setting: 'grace_bytes',
      message: `must not exceed default_quota_bytes (grace_bytes=${config.runtime.graceBytes}, default_quota_bytes=${config.runtime.defaultQuotaBytes})`,
    });
  }

  return errors;
}

/**
 * The one boot check that touches the filesystem: `DB_PATH`'s parent
 * directory must exist (creating it if needed) and be writable by the
 * running process. Returns `undefined` on success, a `BootValidationError`
 * otherwise. Kept separate from `validateConfig` so the pure checks stay
 * hand-testable with no disk access.
 */
export function checkDbPathWritable(dbPath: string): BootValidationError | undefined {
  const dir = path.dirname(dbPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return undefined;
  } catch (err) {
    return {
      setting: 'DB_PATH',
      message: `directory ${dir} is not writable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Runs every boot-validation check (pure + the DB_PATH filesystem check) and
 * throws `BootValidationFailure` — naming every failing setting — if any
 * fail. Callers (`src/instrumentation.ts`) turn a thrown failure into a
 * logged error + non-zero process exit, refusing to start.
 */
export function assertBootValid(config: Config): void {
  const errors = [...validateConfig(config), checkDbPathWritable(config.paths.dbPath)].filter(
    (e): e is BootValidationError => e !== undefined,
  );
  if (errors.length > 0) {
    throw new BootValidationFailure(errors);
  }
}

const CONFIG_YAML_PATH = '/config/config.yaml';

let cached: Config | undefined;

/**
 * Process-backed singleton. Lazily reads `process.env` and the optional
 * mounted `/config/config.yaml` (an absent file is treated exactly like an
 * empty one — the mount is optional per `wiki/Configuration.md`). Cached for
 * the life of the process; config changes require a restart (same as
 * a typical process-backed config singleton).
 */
export function getConfig(): Config {
  if (!cached) {
    let yamlText = '';
    try {
      yamlText = fs.readFileSync(CONFIG_YAML_PATH, 'utf-8');
    } catch {
      // Not mounted — every key has a default, so this is a normal install.
      yamlText = '';
    }
    cached = resolveConfig(process.env, yamlText);
  }
  return cached;
}

/** Test-only escape hatch: forces the next `getConfig()` to re-resolve. */
export function _resetConfigCacheForTests(): void {
  cached = undefined;
}
