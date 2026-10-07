import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetConfigCacheForTests } from '@/lib/config';
import { _resetDbForTests } from '@/lib/db';

/**
 * `register()` (`src/instrumentation.ts`) is where boot validation actually
 * runs. This test exists because a live `docker run` check (against the
 * built runner image, `ENFORCEMENT_ENABLED=true` with no SMTP creds) proved
 * that simply letting `assertBootValid` throw does NOT stop `next start` —
 * Next logs the error but keeps the HTTP server listening. `register()` now
 * catches the failure and calls `process.exit(1)` itself; this test locks
 * that behaviour in so a future refactor can't silently drop it back to "log
 * and keep serving".
 *
 * `@/lib/reconcile/scheduler` is mocked throughout this file: `register()`
 * now also starts the `RECONCILE_INTERVAL` loop on a valid boot, and this
 * suite is about boot validation + wiring, not the loop's own behaviour
 * (that's `test/reconcile-scheduler.test.ts`) — without the mock, the
 * "valid config" tests below would fire a real (fire-and-forget) reconcile
 * against unreachable upstream hostnames every time this file runs.
 */
const ORIGINAL_ENV = { ...process.env };
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-instrumentation-test-'));

const startReconcileSchedulerMock = vi.fn(() => ({ stop: () => {} }));
vi.mock('@/lib/reconcile/scheduler', () => ({
  startReconcileScheduler: () => startReconcileSchedulerMock(),
}));

function validEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    NEXT_RUNTIME: 'nodejs',
    SEERR_API_KEY: 'sk',
    RADARR_API_KEY: 'rk',
    SONARR_API_KEY: 'sok',
    JELLYFIN_API_KEY: 'jk',
    AUTHENTIK_TOKEN: 'ak',
    SEERR_WEBHOOK_SECRET: 'wk',
    ADMIN_USERS: 'admin',
    AUTHENTIK_URL: 'https://auth.example.com',
    APP_URL: 'https://quota.example.com',
    DB_PATH: path.join(tmpDir, 'seerr-quota.db'),
    ...overrides,
  };
}

beforeEach(() => {
  // Forces the next getDb() to open a fresh handle for THIS test's DB_PATH —
  // otherwise the module-level singleton from an earlier test in this file
  // (once opened) would silently keep serving the OLD path regardless of
  // what DB_PATH is set to here, and the DB-migration assertions below would
  // check the wrong file.
  _resetDbForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetConfigCacheForTests();
  startReconcileSchedulerMock.mockClear();
  vi.restoreAllMocks();
});

describe('instrumentation.register() — boot validation actually halts the process', () => {
  it('does NOT call process.exit for a valid config', async () => {
    process.env = { ...process.env, ...validEnv() };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { register } = await import('@/instrumentation');
    await register();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('calls process.exit(1) and logs every failing setting on a boot-validation failure', async () => {
    process.env = {
      ...process.env,
      ...validEnv({ SEERR_API_KEY: undefined, ENFORCEMENT_ENABLED: 'true' }), // missing secret + missing SMTP under enforcement
    };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { register } = await import('@/instrumentation');
    await register();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls[0]?.[0] as string;
    expect(logged).toContain('SEERR_API_KEY');
    expect(logged).toContain('SMTP_USER');
    expect(logged).toContain('SMTP_PASS');
  });

  it('is a no-op (no exit, no error) when NEXT_RUNTIME is not "nodejs", regardless of config validity', async () => {
    process.env = { ...process.env, ...validEnv({ NEXT_RUNTIME: 'edge', SEERR_API_KEY: undefined }) };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { register } = await import('@/instrumentation');
    await register();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('instrumentation.register() — DB migration + reconcile scheduler wiring (this task)', () => {
  it('on a valid config, opens/migrates the DB (the file exists after register()) and starts the reconcile scheduler exactly once', async () => {
    const dbPath = path.join(tmpDir, `boot-${Date.now()}.db`);
    process.env = { ...process.env, ...validEnv({ DB_PATH: dbPath }) };
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(fs.existsSync(dbPath)).toBe(false);

    const { register } = await import('@/instrumentation');
    await register();

    expect(fs.existsSync(dbPath)).toBe(true); // migrations ran at boot — DB now exists before anything else could have queried it
    expect(startReconcileSchedulerMock).toHaveBeenCalledTimes(1);
  });

  it('on a boot-validation failure, does NOT open the DB and does NOT start the reconcile scheduler', async () => {
    const dbPath = path.join(tmpDir, `boot-fail-${Date.now()}.db`);
    process.env = {
      ...process.env,
      ...validEnv({ DB_PATH: dbPath, SEERR_API_KEY: undefined }), // missing required secret -> refuses to start
    };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { register } = await import('@/instrumentation');
    await register();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(fs.existsSync(dbPath)).toBe(false); // never reached the DB-open step
    expect(startReconcileSchedulerMock).not.toHaveBeenCalled();
  });

  it('when NEXT_RUNTIME is not "nodejs" (e.g. a `next build`), does NOT open the DB and does NOT start the scheduler', async () => {
    const dbPath = path.join(tmpDir, `build-${Date.now()}.db`);
    process.env = { ...process.env, ...validEnv({ DB_PATH: dbPath, NEXT_RUNTIME: 'edge' }) };

    const { register } = await import('@/instrumentation');
    await register();

    expect(fs.existsSync(dbPath)).toBe(false);
    expect(startReconcileSchedulerMock).not.toHaveBeenCalled();
  });

  it('migrations are idempotent across two boots against the same DB_PATH (a container restart)', async () => {
    const dbPath = path.join(tmpDir, `restart-${Date.now()}.db`);
    process.env = { ...process.env, ...validEnv({ DB_PATH: dbPath }) };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { register } = await import('@/instrumentation');

    await register(); // "first boot"
    expect(fs.existsSync(dbPath)).toBe(true);

    _resetDbForTests(); // forces the next getDb() to re-open + re-run ensureSchema against the now-already-migrated file, simulating a restart
    _resetConfigCacheForTests();
    startReconcileSchedulerMock.mockClear();

    await expect(register()).resolves.toBeUndefined(); // "second boot" — must not throw on an already-migrated DB

    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(startReconcileSchedulerMock).toHaveBeenCalledTimes(1);
  });
});
