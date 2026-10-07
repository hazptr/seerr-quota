/**
 * `writeAuditRow` (`./write.ts`) must accept EITHER the plain `SeerrQuotaDb`
 * handle (`getDb()`'s return type — used by `remote.ts`'s `runRemoteEffect`
 * for the intent/outcome rows) OR the `tx` handle Drizzle passes into
 * `db.transaction(tx => ...)` (used by `local.ts`'s `withAudit`, so the
 * audit row commits/rolls back with the local change it describes —
 * FR-AUD-8).
 *
 * These are NOT the same TypeScript type for this drizzle-orm version: the
 * transaction handle (`SQLiteTransaction<...>`) is missing the `$client`
 * property `BetterSQLite3Database` carries. Rather than hand-writing (and
 * risking drifting from) drizzle's internal transaction type, `SeerrQuotaTx`
 * is derived directly from `SeerrQuotaDb['transaction']`'s own callback
 * parameter — guaranteed to match whatever type `db.transaction(tx => ...)`
 * actually hands the callback, for this exact schema/driver.
 */
import type { SeerrQuotaDb } from '@/lib/db';

export type SeerrQuotaTx = Parameters<Parameters<SeerrQuotaDb['transaction']>[0]>[0];
export type SeerrQuotaDbOrTx = SeerrQuotaDb | SeerrQuotaTx;
