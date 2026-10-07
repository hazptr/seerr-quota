/**
 * Server-only helper that re-derives the current request's `Identity` for
 * pages and Route Handlers (FR-SSO-3/5). `src/middleware.ts` already ran
 * first and 401'd the request if the configured username header was
 * missing/blank (FR-SSO-2) — this module reads the same, now-guaranteed-
 * present headers via `next/headers` and calls the identical pure
 * `resolveIdentity` the middleware uses, so header parsing has exactly one
 * implementation (AGENTS.md rule 9). This file never rewrites, strips, or
 * falls back to a different header than the ones configured — see
 * `./identity.ts`'s header comment for why that matters for FR-SSO-4.
 *
 * This file is one of only two places in the app that touch request headers
 * for identity (the other being `src/middleware.ts` itself) — it additionally
 * performs the login -> member resolution (`./memberGate.ts`'s
 * `resolveMemberKey`, 0.2.0) so every downstream consumer of `Identity.
 * username` (authorization checks, audit `actor`, every DB lookup keyed on
 * `member.sso_username`) already sees the RESOLVED key rather than the raw
 * header value — see `resolveMemberKey`'s header comment for the exact/
 * alias/email order. `Identity.displayUsername` is untouched by this
 * resolution; it still shows exactly what the proxy sent.
 */
import { headers } from 'next/headers';
import { getConfig } from '@/lib/config';
import { resolveIdentity, isOperatorUser, type Identity } from './identity';
import { resolveMemberKey } from './memberGate';

/**
 * Resolves the current request's `Identity`, or `null` if the configured
 * username header is missing/blank. In normal operation this is
 * unreachable for any route the middleware matcher covers (see
 * `src/middleware.ts`'s `config.matcher`) — every such route already 401'd
 * before rendering — but callers should still handle `null` rather than
 * assume, since this module is also usable from contexts the matcher
 * doesn't cover (e.g. a future exempt route that still wants best-effort
 * identity).
 */
export async function getIdentity(): Promise<Identity | null> {
  const requestHeaders = await headers();
  const { adminUsers, adminGroup, userHeader, groupsHeader, emailHeader } = getConfig().identity;

  const raw = resolveIdentity(requestHeaders.get(userHeader), requestHeaders.get(groupsHeader), adminUsers, adminGroup);
  if (!raw) return null;

  // Item 3/5 of the IdP-agnostic-auth task: resolve the ACTING member key
  // (exact / alias / email fallback), then recompute `isOperator` against
  // BOTH the raw header username (`raw.isOperator` already covers this, via
  // `resolveIdentity`) and the resolved key — an operator listed in
  // `ADMIN_USERS` under their member key must stay recognised even if the
  // IdP ever sends a differently-cased or aliased header username.
  // `resolveMemberKey` re-checks `AUTH_EMAIL_HEADER` configuration itself
  // (defense in depth), but this caller also only reads the header at all
  // when it's configured — belt-and-suspenders against ever forwarding an
  // unconfigured/empty header name into the Headers API.
  const emailHeaderValue = emailHeader.trim() !== '' ? requestHeaders.get(emailHeader) : undefined;
  const resolution = resolveMemberKey(raw.username, emailHeaderValue);
  const isOperator = raw.isOperator || isOperatorUser(resolution.ssoUsername, adminUsers);

  return { ...raw, username: resolution.ssoUsername, isOperator };
}
