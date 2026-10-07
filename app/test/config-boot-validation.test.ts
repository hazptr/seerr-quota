import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertBootValid, checkDbPathWritable, detectLegacyAuthentikEnv, resolveConfig, validateConfig } from '@/lib/config';

/** A config with every required secret set and no other violations — the happy path other tests mutate from. */
function validEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    SEERR_API_KEY: 'sk',
    RADARR_API_KEY: 'rk',
    SONARR_API_KEY: 'sok',
    JELLYFIN_API_KEY: 'jk',
    SEERR_WEBHOOK_SECRET: 'wk',
    ADMIN_USERS: 'admin',
    APP_URL: 'https://quota.example.com',
    ...overrides,
  };
}

describe('validateConfig — wiki/Configuration.md §"Validation at boot"', () => {
  it('a fully-configured env with no default_quota_bytes set produces zero errors (documented degraded-but-valid state)', () => {
    const cfg = resolveConfig(validEnv());
    expect(cfg.runtime.defaultQuotaBytes).toBeUndefined();
    expect(validateConfig(cfg)).toEqual([]);
  });

  it('rejects each missing upstream secret individually, naming the exact setting', () => {
    for (const key of [
      'SEERR_API_KEY',
      'RADARR_API_KEY',
      'SONARR_API_KEY',
      'SEERR_WEBHOOK_SECRET',
    ] as const) {
      const cfg = resolveConfig(validEnv({ [key]: undefined }));
      const errors = validateConfig(cfg);
      expect(errors.map((e) => e.setting)).toContain(key);
    }
  });

  // JELLYFIN_API_KEY is deliberately NOT in the list above. The legacy `db`
  // playback source reads Jellyfin's SQLite file directly instead of calling
  // the REST API, so demanding a credential that source never touches would
  // make the app unbootable for no reason.
  it('does NOT require JELLYFIN_API_KEY while the playback source is `db`', () => {
    const cfg = resolveConfig(validEnv({ JELLYFIN_API_KEY: undefined, JELLYFIN_PLAYBACK_SOURCE: 'db' }));
    expect(validateConfig(cfg).map((e) => e.setting)).not.toContain('JELLYFIN_API_KEY');
  });

  it('DOES require JELLYFIN_API_KEY while the playback source is `rest` (the default)', () => {
    const cfg = resolveConfig(validEnv({ JELLYFIN_API_KEY: undefined, JELLYFIN_PLAYBACK_SOURCE: 'rest' }));
    expect(validateConfig(cfg).map((e) => e.setting)).toContain('JELLYFIN_API_KEY');
  });

  it('DOES require JELLYFIN_API_KEY by default, since `rest` is the default playback source', () => {
    const cfg = resolveConfig(validEnv({ JELLYFIN_API_KEY: undefined }));
    expect(cfg.upstreams.jellyfinPlaybackSource).toBe('rest');
    expect(validateConfig(cfg).map((e) => e.setting)).toContain('JELLYFIN_API_KEY');
  });

  it('a whitespace-only secret is treated the same as missing', () => {
    const cfg = resolveConfig(validEnv({ SEERR_API_KEY: '   ' }));
    expect(validateConfig(cfg).map((e) => e.setting)).toContain('SEERR_API_KEY');
  });

  it('rejects ADMIN_USERS empty — nobody could administer the app', () => {
    // A literal empty string is treated as "unset" by the env->yaml->default
    // resolver (same convention as every other setting — see
    // `resolveRaw`/`str` in src/lib/config.ts and config.test.ts's "an
    // empty-string env var is treated as unset" case), so it falls back to
    // the (empty) built-in default either way. A comma-only value is the
    // other way to construct this state, surviving that "is it set" check
    // but filtering down to an empty array in `csv()`.
    const cfg = resolveConfig(validEnv({ ADMIN_USERS: ',' }));
    expect(cfg.identity.adminUsers).toEqual([]);
    const errors = validateConfig(cfg);
    expect(errors.some((e) => e.setting === 'ADMIN_USERS')).toBe(true);
  });

  it('rejects APP_URL missing — no sane generic default exists for this app\'s own public URL', () => {
    const cfg = resolveConfig(validEnv({ APP_URL: undefined }));
    expect(cfg.upstreams.appUrl).toBe('');
    expect(validateConfig(cfg).map((e) => e.setting)).toContain('APP_URL');
  });

  it('rejects a negative grace_bytes regardless of default_quota_bytes', () => {
    const cfg = resolveConfig(validEnv({ GRACE_BYTES: '-1' }));
    const errors = validateConfig(cfg);
    expect(errors.some((e) => e.setting === 'grace_bytes')).toBe(true);
  });

  it('rejects grace_bytes larger than default_quota_bytes', () => {
    const cfg = resolveConfig(validEnv({ DEFAULT_QUOTA_BYTES: '1000', GRACE_BYTES: '1001' }));
    const errors = validateConfig(cfg);
    expect(errors.some((e) => e.setting === 'grace_bytes')).toBe(true);
  });

  it('accepts grace_bytes exactly equal to default_quota_bytes (boundary — not "larger than")', () => {
    const cfg = resolveConfig(validEnv({ DEFAULT_QUOTA_BYTES: '1000', GRACE_BYTES: '1000' }));
    expect(validateConfig(cfg)).toEqual([]);
  });

  it('does NOT reject grace_bytes > 0 when default_quota_bytes is unset (nothing to compare against yet)', () => {
    const cfg = resolveConfig(validEnv({ GRACE_BYTES: '5000' }));
    expect(cfg.runtime.defaultQuotaBytes).toBeUndefined();
    expect(validateConfig(cfg)).toEqual([]);
  });

  it('reports every violation at once, not just the first', () => {
    const cfg = resolveConfig(validEnv({ SEERR_API_KEY: '', ADMIN_USERS: ',', GRACE_BYTES: '-1' }));
    const errors = validateConfig(cfg);
    const settings = errors.map((e) => e.setting);
    expect(settings).toContain('SEERR_API_KEY');
    expect(settings).toContain('ADMIN_USERS');
    expect(settings).toContain('grace_bytes');
  });

  it('never includes a secret VALUE in an error message (only the setting name)', () => {
    const cfg = resolveConfig(validEnv({ SEERR_API_KEY: undefined }));
    const errors = validateConfig(cfg);
    const seerrError = errors.find((e) => e.setting === 'SEERR_API_KEY');
    expect(seerrError).toBeDefined();
    // The other real secret values must never leak into an unrelated error message.
    expect(JSON.stringify(errors)).not.toContain('rk');
    expect(JSON.stringify(errors)).not.toContain('ak');
  });
});

describe('validateConfig — SMTP is conditionally required (D-4a, wiki/Configuration.md "Validation at boot")', () => {
  it('SMTP missing is NOT an error when enforcement_enabled is false (the default)', () => {
    const cfg = resolveConfig(validEnv());
    expect(cfg.runtime.enforcementEnabled).toBe(false);
    expect(cfg.secrets.smtpUser).toBe('');
    expect(cfg.secrets.smtpPass).toBe('');
    expect(validateConfig(cfg)).toEqual([]);
  });

  it('rejects enforcement_enabled=true with SMTP_USER/SMTP_PASS both missing, naming both settings', () => {
    const cfg = resolveConfig(validEnv({ ENFORCEMENT_ENABLED: 'true' }));
    const errors = validateConfig(cfg);
    const settings = errors.map((e) => e.setting);
    expect(settings).toContain('SMTP_USER');
    expect(settings).toContain('SMTP_PASS');
  });

  it('rejects enforcement_enabled=true with only SMTP_PASS missing', () => {
    const cfg = resolveConfig(validEnv({ ENFORCEMENT_ENABLED: 'true', SMTP_USER: 'u' }));
    const errors = validateConfig(cfg);
    const settings = errors.map((e) => e.setting);
    expect(settings).toContain('SMTP_PASS');
    expect(settings).not.toContain('SMTP_USER');
  });

  it('accepts enforcement_enabled=true when both SMTP_USER and SMTP_PASS are set (and default_quota_bytes is set, per FR-POL-2)', () => {
    const cfg = resolveConfig(validEnv({ ENFORCEMENT_ENABLED: 'true', SMTP_USER: 'u', SMTP_PASS: 'p', DEFAULT_QUOTA_BYTES: '500000000000' }));
    expect(validateConfig(cfg)).toEqual([]);
  });

  it('does NOT require SMTP_HOST/SMTP_PORT/SMTP_FROM even when enforcement is on — they have valid built-in defaults', () => {
    const cfg = resolveConfig(validEnv({ ENFORCEMENT_ENABLED: 'true', SMTP_USER: 'u', SMTP_PASS: 'p', DEFAULT_QUOTA_BYTES: '500000000000' }));
    expect(cfg.smtp.host).toBe('mail.example.com');
    expect(cfg.smtp.port).toBe(25);
    expect(cfg.smtp.from).toBe('quota@example.com');
    expect(validateConfig(cfg)).toEqual([]);
  });
});

describe('validateConfig — default_quota_bytes required once enforcement is on (FR-POL-2)', () => {
  it('rejects enforcement_enabled=true with default_quota_bytes unset, naming DEFAULT_QUOTA_BYTES', () => {
    const cfg = resolveConfig(validEnv({ ENFORCEMENT_ENABLED: 'true', SMTP_USER: 'u', SMTP_PASS: 'p' }));
    expect(cfg.runtime.defaultQuotaBytes).toBeUndefined();
    const errors = validateConfig(cfg);
    expect(errors.map((e) => e.setting)).toContain('DEFAULT_QUOTA_BYTES');
  });

  it('does NOT reject default_quota_bytes=0 — explicit "unlimited" is a real decision, not an absence of one', () => {
    const cfg = resolveConfig(validEnv({ ENFORCEMENT_ENABLED: 'true', SMTP_USER: 'u', SMTP_PASS: 'p', DEFAULT_QUOTA_BYTES: '0' }));
    expect(cfg.runtime.defaultQuotaBytes).toBe(0);
    expect(validateConfig(cfg).map((e) => e.setting)).not.toContain('DEFAULT_QUOTA_BYTES');
  });

  it('does NOT require default_quota_bytes when enforcement_enabled is false (pure accounting)', () => {
    const cfg = resolveConfig(validEnv());
    expect(cfg.runtime.enforcementEnabled).toBe(false);
    expect(cfg.runtime.defaultQuotaBytes).toBeUndefined();
    expect(validateConfig(cfg).map((e) => e.setting)).not.toContain('DEFAULT_QUOTA_BYTES');
  });
});

describe('checkDbPathWritable', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-dbpath-test-'));

  afterEach(() => {
    // Restore write perms so cleanup (done by the OS tmp reaper / next mkdtemp) never gets stuck.
    try {
      fs.chmodSync(tmpDir, 0o755);
    } catch {
      // best-effort
    }
  });

  it('succeeds and creates the parent directory when it does not yet exist', () => {
    const dbPath = path.join(tmpDir, 'nested', 'db', 'seerr-quota.db');
    expect(checkDbPathWritable(dbPath)).toBeUndefined();
    expect(fs.existsSync(path.dirname(dbPath))).toBe(true);
  });

  it('reports an error naming DB_PATH when the parent directory is not writable', () => {
    // Skip under a root-equivalent test runner (uid 0 ignores permission
    // bits) — this check is meaningless there and would false-fail.
    if (process.getuid && process.getuid() === 0) return;
    const readonlyDir = path.join(tmpDir, 'readonly');
    fs.mkdirSync(readonlyDir, { recursive: true });
    fs.chmodSync(readonlyDir, 0o444);
    const dbPath = path.join(readonlyDir, 'seerr-quota.db');
    const error = checkDbPathWritable(dbPath);
    expect(error).toBeDefined();
    expect(error?.setting).toBe('DB_PATH');
    fs.chmodSync(readonlyDir, 0o755); // so the outer tmpDir can still be cleaned up
  });
});

describe('assertBootValid', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-boot-test-'));

  it('does not throw for a fully-valid config with a writable DB_PATH', () => {
    const cfg = resolveConfig(validEnv({ DB_PATH: path.join(tmpDir, 'seerr-quota.db') }));
    expect(() => assertBootValid(cfg)).not.toThrow();
  });

  it('throws BootValidationFailure naming every failing setting, and refuses to start', () => {
    const cfg = resolveConfig(validEnv({ SEERR_API_KEY: '', ADMIN_USERS: ',', DB_PATH: path.join(tmpDir, 'seerr-quota.db') }));
    try {
      assertBootValid(cfg);
      expect.unreachable('assertBootValid should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      expect(message).toContain('SEERR_API_KEY');
      expect(message).toContain('ADMIN_USERS');
    }
  });
});

describe('detectLegacyAuthentikEnv (0.2.0 config contract: a leftover .env MUST NOT fail to boot)', () => {
  it('returns [] when no removed Authentik var is present', () => {
    expect(detectLegacyAuthentikEnv(validEnv())).toEqual([]);
  });

  it('names every removed Authentik var still present and non-empty, never its value', () => {
    const names = detectLegacyAuthentikEnv({
      AUTHENTIK_URL: 'https://auth.example.com',
      AUTHENTIK_TOKEN: 'super-secret-token',
      SEERR_APP_SLUG: 'jellyseerr',
    });
    expect(names.sort()).toEqual(['AUTHENTIK_TOKEN', 'AUTHENTIK_URL', 'SEERR_APP_SLUG']);
    expect(names.join(',')).not.toContain('super-secret-token');
  });

  it('an empty-string value is treated as unset, same as everywhere else', () => {
    expect(detectLegacyAuthentikEnv({ AUTHENTIK_URL: '' })).toEqual([]);
  });

  it('a fully-valid 0.2.0 env with legacy Authentik vars left over still boots clean (resolveConfig/validateConfig never read them)', () => {
    const cfg = resolveConfig(validEnv({ AUTHENTIK_URL: 'https://auth.example.com', AUTHENTIK_TOKEN: 'leftover-secret' }));
    expect(validateConfig(cfg)).toEqual([]);
    expect(JSON.stringify(cfg)).not.toContain('leftover-secret');
  });
});
