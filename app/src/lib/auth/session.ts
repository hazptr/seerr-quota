/**
 * Server-only helper that re-derives the current request's `Identity` for
 * pages and Route Handlers (FR-SSO-3/5). `src/middleware.ts` already ran
 * first and 401'd the request if `Remote-User` was missing/blank
 * (FR-SSO-2) — this module reads the same, now-guaranteed-present headers
 * via `next/headers` and calls the identical pure `resolveIdentity` the
 * middleware uses, so identity parsing has exactly one implementation
 * (AGENTS.md rule 9). This file never rewrites, strips, or falls back to a
 * different header — see `./identity.ts`'s header comment for why that
 * matters for FR-SSO-4.
 *
 * This file is one of only two places in the app that touch request headers
 * for identity (the other being `src/middleware.ts` itself).
 */
import { headers } from 'next/headers';
import { getConfig } from '@/lib/config';
import { resolveIdentity, type Identity } from './identity';

/**
 * Resolves the current request's `Identity`, or `null` if `Remote-User` is
 * missing/blank. In normal operation this is unreachable for any route the
 * middleware matcher covers (see `src/middleware.ts`'s `config.matcher`) —
 * every such route already 401'd before rendering — but callers should still
 * handle `null` rather than assume, since this module is also usable from
 * contexts the matcher doesn't cover (e.g. a future exempt route that still
 * wants best-effort identity).
 */
export async function getIdentity(): Promise<Identity | null> {
  const requestHeaders = await headers();
  const { adminUsers, adminGroup } = getConfig().identity;
  return resolveIdentity(requestHeaders.get('Remote-User'), requestHeaders.get('Remote-Groups'), adminUsers, adminGroup);
}
