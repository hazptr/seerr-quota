/**
 * Feature 1 (SSO & Identity) gate — wiki/Feature-01-SSO-Identity.md.
 *
 * Runs on every request except the ones excluded by `config.matcher` below
 * — `/healthz` (FR-SSO-6) and `POST /api/seerr/webhook` (FR-SSO-7). For
 * everything else it enforces FR-SSO-2: derive identity solely from the
 * `Remote-User` header (+ `Remote-Groups`), and reject with 401 if it's
 * missing or blank — INCLUDING a request that reaches the container's
 * loopback-bound port directly (`FR-SSO-2`: "including requests arriving on
 * the loopback port"). This file has no way to tell how a request arrived —
 * SWAG-proxied or straight to `127.0.0.1:8101` — and doesn't try to; it just
 * always demands `Remote-User`. The loopback bind (`docker-compose.yml`,
 * wiki/Deployment.md) is a network-level BACKSTOP that keeps the LAN from
 * reaching the app at all; this middleware is the actual CONTROL, and would
 * still reject an unauthenticated request even if that bind were ever
 * misconfigured.
 *
 * Identity parsing itself is pure (`src/lib/auth/identity.ts`); this file is
 * the thin impure shell that reads the request and turns the result into an
 * HTTP response. It never rewrites, strips, or adds a fallback for
 * `Remote-User`/`Remote-Groups` — see `src/lib/auth/identity.ts`'s header
 * comment for why FR-SSO-4 depends on there being exactly one trust path.
 * Pages/Route Handlers re-derive `Identity` themselves via
 * `src/lib/auth/session.ts`'s `getIdentity()` (same pure function, one
 * source of truth) rather than this middleware forwarding a computed value
 * downstream.
 *
 * FR-SSO-4's actual anti-spoofing protection lives OUTSIDE this app: a
 * reverse proxy (e.g. SWAG, Traefik) running a forward-auth location block
 * (for Authentik, Authelia, oauth2-proxy, Pomerium, or any other IdP)
 * overwrites any client-sent copy of the configured identity headers
 * before proxying (wiki/Feature-01-SSO-Identity.md "Interactions" —
 * `proxy_set_header` is unconditional), and
 * the container's loopback-only bind stops the LAN from reaching the app
 * around that gate. Neither of those two things can be expressed in this
 * app's code (they live in the reverse-proxy vhost config and
 * `docker-compose.yml`) — the discipline this file (and `src/lib/auth/**`)
 * is responsible for is simply never adding a second, weaker way to
 * establish identity that the proxy's unconditional overwrite wouldn't also
 * cover.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getConfig } from '@/lib/config';
import { resolveIdentity } from '@/lib/auth/identity';

// `getConfig()` reads an optional mounted config.yaml via `node:fs`, and
// `src/lib/auth/identity.ts` (indirectly, via getConfig()) has no Edge
// Middleware runtime constraints of its own — but declaring the Node.js
// Middleware runtime explicitly (stable as of Next.js 15.5) keeps this file
// running as plain Node, matching every other server module in this app,
// rather than leaving the runtime to infer silently and risk drifting onto
// the Edge runtime later.
export const runtime = 'nodejs';

function unauthorized(): NextResponse {
  return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
}

export function middleware(req: NextRequest): NextResponse {
  const { identity: identityConfig } = getConfig();

  const identity = resolveIdentity(
    req.headers.get(identityConfig.userHeader),
    req.headers.get(identityConfig.groupsHeader),
    identityConfig.adminUsers,
    identityConfig.adminGroup,
  );

  if (!identity) {
    return unauthorized();
  }

  return NextResponse.next();
}

export const config = {
  /*
   * Everything except:
   *   - /healthz (and /healthz/...)             — FR-SSO-6, unauthenticated
   *     liveness for Gatus; no identity resolution, no upstream call, no DB
   *     query beyond an open check (enforced by never importing
   *     `src/lib/auth/**` from `src/app/healthz/route.ts` — see
   *     test/healthz.test.ts).
   *   - /api/seerr/webhook (and /api/seerr/webhook/...) — FR-SSO-7. Seerr
   *     reaches this route directly over the shared Docker network, never
   *     traversing the reverse-proxy/forward-auth vhost, so it can never
   *     present a `Remote-User` header. The route itself (P2-6, not built
   *     here) authenticates via a constant-time shared-secret comparison
   *     instead — see src/lib/auth/webhookSecret.ts.
   *   - /_next/static, /_next/image             — Next.js build/runtime
   *     internals.
   *   - /favicon.ico, /favicon.svg                 — static assets.
   *
   * Next.js's documented negative-lookahead matcher idiom, anchoring each
   * exemption to a path segment boundary (`(?:$|/)`) rather than a bare
   * prefix — a bare `healthz` alternative would also excuse a hypothetical
   * `/healthz-status` route from the gate, which is exactly the class of bug
   * this anchoring avoids.
   */
  matcher: ['/((?!healthz(?:$|/)|api/seerr/webhook(?:$|/)|_next/static|_next/image|favicon.ico|favicon.svg).*)'],
};
