import { describe, expect, it } from 'vitest';
import { parseDurationMs, parseSimpleYaml, resolveConfig } from '@/lib/config';

describe('parseSimpleYaml', () => {
  it('empty file/string parses to an empty mapping (an empty config.yaml is valid)', () => {
    expect(parseSimpleYaml('')).toEqual({});
  });

  it('parses scalars: bare string, quoted string, int, float, bool, null', () => {
    const parsed = parseSimpleYaml(
      [
        'SEERR_URL: http://jellyseerr:5055',
        'ADMIN_GROUP: "admins"',
        "SIZE_UNITS: 'decimal'",
        'DELETE_MAX_PER_HOUR: 25',
        'PLANNER_TEMPERATURE: 0.4',
        'RECONCILE_ON_BOOT: true',
        'ALLOWED_GROUP: false',
        'DEFAULT_QUOTA_BYTES: null',
      ].join('\n'),
    );
    expect(parsed).toEqual({
      SEERR_URL: 'http://jellyseerr:5055',
      ADMIN_GROUP: 'admins',
      SIZE_UNITS: 'decimal',
      DELETE_MAX_PER_HOUR: 25,
      PLANNER_TEMPERATURE: 0.4,
      RECONCILE_ON_BOOT: true,
      ALLOWED_GROUP: false,
      DEFAULT_QUOTA_BYTES: null,
    });
  });

  it('ignores blank lines, full-line comments, and non-SCREAMING_SNAKE_CASE keys', () => {
    const parsed = parseSimpleYaml(
      ['# a comment', '', 'DB_PATH: /db/x.sqlite', '  ', 'lower_case: nope', 'not a key value line'].join('\n'),
    );
    expect(parsed).toEqual({ DB_PATH: '/db/x.sqlite' });
  });
});

describe('parseDurationMs', () => {
  it('parses s/m/h suffixes', () => {
    expect(parseDurationMs('20s', -1)).toBe(20_000);
    expect(parseDurationMs('15m', -1)).toBe(15 * 60_000);
    expect(parseDurationMs('1h', -1)).toBe(3_600_000);
  });

  it('treats a bare number as whole seconds', () => {
    expect(parseDurationMs('30', -1)).toBe(30_000);
  });

  it('falls back to the provided default on garbage input rather than throwing', () => {
    expect(parseDurationMs('not-a-duration', 4242)).toBe(4242);
    expect(() => parseDurationMs('not-a-duration', 4242)).not.toThrow();
  });
});

describe('resolveConfig precedence: env > config.yaml > default', () => {
  it('uses the built-in defaults documented in wiki/Configuration.md when neither env nor config.yaml set a key', () => {
    const cfg = resolveConfig({}, '');
    expect(cfg.upstreams.seerrUrl).toBe('http://jellyseerr:5055');
    expect(cfg.upstreams.radarrUrl).toBe('http://radarr:7878');
    expect(cfg.upstreams.sonarrUrl).toBe('http://sonarr:8989');
    expect(cfg.upstreams.jellyfinUrl).toBe('http://jellyfin:8096');
    expect(cfg.upstreams.jellyfinPlaybackSource).toBe('rest');
    expect(cfg.upstreams.appUrl).toBe(''); // no default — required, see validateConfig
    expect(cfg.identity.adminUsers).toEqual([]); // no default — required, see validateConfig
    // Security review (PR #17): both ADMIN_GROUP and AUTH_EMAIL_HEADER
    // default to EMPTY (disabled) — neither is safe to assume "on" without
    // an operator's deliberate opt-in. See wiki/Configuration.md.
    expect(cfg.identity.adminGroup).toBe('');
    expect(cfg.identity.userHeader).toBe('Remote-User');
    expect(cfg.identity.groupsHeader).toBe('Remote-Groups');
    expect(cfg.identity.emailHeader).toBe('');
    expect(cfg.runtime.enforcementEnabled).toBe(false);
    expect(cfg.runtime.graceBytes).toBe(0);
    expect(cfg.runtime.deleteRecentPlayDays).toBe(14);
    expect(cfg.runtime.deleteInProgressDays).toBe(90);
    expect(cfg.runtime.staleSnapshotMaxAgeS).toBe(3600);
    expect(cfg.runtime.deleteMaxPerHour).toBe(25);
    expect(cfg.runtime.holdMaxDays).toBe(30);
    expect(cfg.runtime.notifyCooldownS).toBe(86400);
    expect(cfg.smtp.host).toBe('mail.example.com');
    expect(cfg.smtp.port).toBe(25);
    expect(cfg.smtp.from).toBe('quota@example.com');
    expect(cfg.scheduling.reconcileOnBoot).toBe(true);
    expect(cfg.scheduling.webhookEnabled).toBe(true);
    expect(cfg.scheduling.upstreamRetries).toBe(2);
    expect(cfg.paths.dbPath).toBe('/db/seerr-quota.db');
    expect(cfg.paths.mediaFreeSpacePath).toBe('/mnt/media');
    expect(cfg.paths.logLevel).toBe('info');
    expect(cfg.display.tz).toBe('UTC');
    expect(cfg.display.sizeUnits).toBe('decimal');
  });

  it('DEFAULT_QUOTA_BYTES has deliberately no default — undefined until the operator sets one', () => {
    expect(resolveConfig({}, '').runtime.defaultQuotaBytes).toBeUndefined();
    expect(resolveConfig({ DEFAULT_QUOTA_BYTES: '500000000000' }, '').runtime.defaultQuotaBytes).toBe(
      500_000_000_000,
    );
  });

  it('RECONCILE_INTERVAL/UPSTREAM_TIMEOUT default to 15m/20s, parsed to milliseconds', () => {
    const cfg = resolveConfig({}, '');
    expect(cfg.scheduling.reconcileIntervalMs).toBe(15 * 60_000);
    expect(cfg.scheduling.reconcileIntervalRaw).toBe('15m');
    expect(cfg.scheduling.upstreamTimeoutMs).toBe(20_000);
  });

  it('APP_URL is configurable — not a hardcoded constant (FR-BAN-6)', () => {
    const cfg = resolveConfig({ APP_URL: 'https://quota-staging.example.com' }, '');
    expect(cfg.upstreams.appUrl).toBe('https://quota-staging.example.com');
  });

  it('AUTH_USER_HEADER/AUTH_GROUPS_HEADER/AUTH_EMAIL_HEADER are configurable (0.2.0, IdP-agnostic forward-auth)', () => {
    const cfg = resolveConfig(
      { AUTH_USER_HEADER: 'X-Auth-Request-User', AUTH_GROUPS_HEADER: 'X-Auth-Request-Groups', AUTH_EMAIL_HEADER: 'X-Auth-Request-Email' },
      '',
    );
    expect(cfg.identity.userHeader).toBe('X-Auth-Request-User');
    expect(cfg.identity.groupsHeader).toBe('X-Auth-Request-Groups');
    expect(cfg.identity.emailHeader).toBe('X-Auth-Request-Email');
  });

  it('config.yaml overrides the default when env does not set the key', () => {
    const cfg = resolveConfig({}, 'SEERR_URL: http://jellyseerr-from-yaml:5055\n');
    expect(cfg.upstreams.seerrUrl).toBe('http://jellyseerr-from-yaml:5055');
  });

  it('env overrides both config.yaml and the default (env wins precedence)', () => {
    const cfg = resolveConfig(
      { SEERR_URL: 'http://jellyseerr-from-env:5055' },
      'SEERR_URL: http://jellyseerr-from-yaml:5055\n',
    );
    expect(cfg.upstreams.seerrUrl).toBe('http://jellyseerr-from-env:5055');
  });

  it('an empty-string env var is treated as unset, so config.yaml/default still apply', () => {
    const cfg = resolveConfig({ SEERR_URL: '' }, 'SEERR_URL: http://jellyseerr-from-yaml:5055\n');
    expect(cfg.upstreams.seerrUrl).toBe('http://jellyseerr-from-yaml:5055');
    const cfgDefault = resolveConfig({ SEERR_URL: '' }, '');
    expect(cfgDefault.upstreams.seerrUrl).toBe('http://jellyseerr:5055');
  });

  it('an explicit `null` in config.yaml is treated as unset, so the default still applies', () => {
    const cfg = resolveConfig({}, 'DEFAULT_QUOTA_BYTES: null\n');
    expect(cfg.runtime.defaultQuotaBytes).toBeUndefined();
  });

  it('parses ADMIN_USERS as a comma-separated list, trimmed', () => {
    const cfg = resolveConfig({ ADMIN_USERS: 'admin, carol ,gus' }, '');
    expect(cfg.identity.adminUsers).toEqual(['admin', 'carol', 'gus']);
  });

  it('parses booleans case-insensitively and numbers from either source', () => {
    const cfg = resolveConfig(
      { ENFORCEMENT_ENABLED: 'TRUE', DELETE_MAX_PER_HOUR: '10' },
      'WEBHOOK_ENABLED: false\nGRACE_BYTES: 1000\n',
    );
    expect(cfg.runtime.enforcementEnabled).toBe(true);
    expect(cfg.runtime.deleteMaxPerHour).toBe(10);
    expect(cfg.scheduling.webhookEnabled).toBe(false);
    expect(cfg.runtime.graceBytes).toBe(1000);
  });

  it('SIZE_UNITS only accepts the two documented enum values, else falls back to the default (decimal)', () => {
    expect(resolveConfig({ SIZE_UNITS: 'binary' }, '').display.sizeUnits).toBe('binary');
    expect(resolveConfig({ SIZE_UNITS: 'bogus' }, '').display.sizeUnits).toBe('decimal');
  });

  it('JELLYFIN_PLAYBACK_SOURCE defaults to `rest`, and `db` remains explicitly supported', () => {
    expect(resolveConfig({}, '').upstreams.jellyfinPlaybackSource).toBe('rest');
    expect(resolveConfig({ JELLYFIN_PLAYBACK_SOURCE: 'db' }, '').upstreams.jellyfinPlaybackSource).toBe('db');
    expect(resolveConfig({ JELLYFIN_PLAYBACK_SOURCE: 'rest' }, '').upstreams.jellyfinPlaybackSource).toBe('rest');
    // Anything else falls back to the default, same convention as SIZE_UNITS above.
    expect(resolveConfig({ JELLYFIN_PLAYBACK_SOURCE: 'bogus' }, '').upstreams.jellyfinPlaybackSource).toBe('rest');
  });

  it('HOLD_MAX_DAYS/NOTIFY_COOLDOWN_S (D-4a) are configurable from either source, env winning', () => {
    const fromYaml = resolveConfig({}, 'HOLD_MAX_DAYS: 7\nNOTIFY_COOLDOWN_S: 3600\n');
    expect(fromYaml.runtime.holdMaxDays).toBe(7);
    expect(fromYaml.runtime.notifyCooldownS).toBe(3600);
    const fromEnv = resolveConfig({ HOLD_MAX_DAYS: '0' }, 'HOLD_MAX_DAYS: 7\n');
    expect(fromEnv.runtime.holdMaxDays).toBe(0); // 0 = never auto-decline
  });

  it('SMTP_HOST/SMTP_PORT/SMTP_FROM are configurable non-secret connection settings', () => {
    const cfg = resolveConfig(
      { SMTP_PORT: '587' },
      'SMTP_HOST: mail-from-yaml.example.com\nSMTP_FROM: quota-from-yaml@example.com\n',
    );
    expect(cfg.smtp.host).toBe('mail-from-yaml.example.com');
    expect(cfg.smtp.port).toBe(587);
    expect(cfg.smtp.from).toBe('quota-from-yaml@example.com');
  });
});

describe('secrets come from env only — never config.yaml (wiki/Configuration.md §Secrets, FR-AUD-11)', () => {
  it('a config.yaml value for a secret key is ignored entirely', () => {
    const cfg = resolveConfig(
      {},
      [
        'SEERR_API_KEY: from-yaml',
        'RADARR_API_KEY: from-yaml',
        'SONARR_API_KEY: from-yaml',
        'JELLYFIN_API_KEY: from-yaml',
        'SEERR_WEBHOOK_SECRET: from-yaml',
        'SMTP_USER: from-yaml',
        'SMTP_PASS: from-yaml',
      ].join('\n'),
    );
    expect(cfg.secrets.seerrApiKey).toBe('');
    expect(cfg.secrets.radarrApiKey).toBe('');
    expect(cfg.secrets.sonarrApiKey).toBe('');
    expect(cfg.secrets.jellyfinApiKey).toBe('');
    expect(cfg.secrets.seerrWebhookSecret).toBe('');
    expect(cfg.secrets.smtpUser).toBe('');
    expect(cfg.secrets.smtpPass).toBe('');
  });

  it('env sets every secret independently, including the SMTP pair', () => {
    const cfg = resolveConfig({
      SEERR_API_KEY: 's1',
      RADARR_API_KEY: 'r1',
      SONARR_API_KEY: 'so1',
      JELLYFIN_API_KEY: 'j1',
      SEERR_WEBHOOK_SECRET: 'w1',
      SMTP_USER: 'u1',
      SMTP_PASS: 'p1',
    });
    expect(cfg.secrets).toEqual({
      seerrApiKey: 's1',
      radarrApiKey: 'r1',
      sonarrApiKey: 'so1',
      jellyfinApiKey: 'j1',
      seerrWebhookSecret: 'w1',
      smtpUser: 'u1',
      smtpPass: 'p1',
    });
  });

  it('missing secrets resolve to empty string, not a throw (validated separately at boot)', () => {
    expect(() => resolveConfig({}, '')).not.toThrow();
    expect(resolveConfig({}, '').secrets.seerrApiKey).toBe('');
  });
});
