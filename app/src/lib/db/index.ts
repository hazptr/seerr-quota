/**
 * Lazily opens the sidecar SQLite database and applies the schema
 * idempotently at first open — the "additive schema, applied idempotently at
 * boot" rule (AGENTS.md rule 10, `wiki/Data-Model.md`). Mirrors
 * the same lazy-singleton shape as the config loader (`src/lib/config.ts`'s `getConfig()`).
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

export type SeerrQuotaDb = ReturnType<typeof drizzle<typeof schema>>;

let db: SeerrQuotaDb | undefined;

/**
 * Where `drizzle-kit generate` (see `drizzle.config.ts`) writes numbered SQL
 * migration files, resolved relative to the process cwd — matching both
 * `npm run db:generate` (run from `app/`) and the Docker runner stage
 * (`WORKDIR /app`, which the Dockerfile copies `drizzle/` into alongside
 * `.next`/`public`).
 */
const MIGRATIONS_FOLDER = path.join(process.cwd(), 'drizzle');

/**
 * Applies every not-yet-applied migration under `drizzle/` inside a
 * transaction, tracked in a `__drizzle_migrations` bookkeeping table so a
 * re-run is a no-op. New tables/columns/indexes only, generated as a fresh
 * migration file via `npm run db:generate` — never a hand-edited destructive
 * one (additive-only, AGENTS.md rule 10).
 */
export function ensureSchema(instance: SeerrQuotaDb): void {
  migrate(instance, { migrationsFolder: MIGRATIONS_FOLDER });
}

/**
 * Opens (or reuses) the process-wide DB handle at `DB_PATH` (default
 * `/db/seerr-quota.db`, matching the `/db` volume mount in
 * `docker-compose.yml` — see `wiki/Deployment.md` §1 and
 * `wiki/Configuration.md`), sets WAL mode, and applies the schema via
 * `ensureSchema`.
 *
 * Deliberately lazy: nothing calls this at import time, so no DB file is
 * created and no migration runs at `next build`/`vitest run` time — only
 * when a request path or boot hook actually needs the database. Reads
 * `DB_PATH` directly from `process.env` (not `getConfig()`) so a test can
 * point it at a throwaway file before first import without needing to touch
 * the config-resolution singleton.
 */
export function getDb(): SeerrQuotaDb {
  if (!db) {
    const dbPath = process.env.DB_PATH ?? '/db/seerr-quota.db';
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const sqlite = new Database(dbPath);
    sqlite.pragma('journal_mode = WAL');
    db = drizzle(sqlite, { schema });
    ensureSchema(db);
  }
  return db;
}

/** Test-only escape hatch: forces the next `getDb()` to open a fresh handle. */
export function _resetDbForTests(): void {
  db = undefined;
}
