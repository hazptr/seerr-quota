/**
 * Ambient test-environment defaults — applied once per test file, before
 * that file's own module-level code runs. This is NOT a config.ts default
 * (see `src/lib/config.ts`'s header comment: `ADMIN_USERS`, `AUTHENTIK_URL`,
 * and `APP_URL` are deliberately unconditionally required, with no built-in
 * fallback, because none of them has a sane generic value to ship). It's the
 * test-suite equivalent of the `.env` a real deployment would supply —
 * most test files never touch these settings at all and shouldn't have to
 * duplicate this boilerplate in every one of them.
 *
 * Only set `if` absent, so a test file that deliberately sets/unsets one of
 * these (e.g. to exercise `validateConfig`'s "missing" branch, or an
 * `APP_URL` override) is never clobbered — this only fills in a default.
 */
process.env.ADMIN_USERS ??= 'admin';
process.env.AUTHENTIK_URL ??= 'https://auth.example.com';
process.env.APP_URL ??= 'https://quota.example.com';
