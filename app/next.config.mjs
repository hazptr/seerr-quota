/** @type {import('next').NextConfig} */
const nextConfig = {
  // `better-sqlite3` is a native addon; keep it out of the server bundle so
  // Next resolves it via normal `require` against node_modules at runtime
  // instead of trying to bundle the compiled `.node` binary. The same idiom
  // Next's own docs recommend for any native-addon dependency.
  serverExternalPackages: ['better-sqlite3'],
  // P1-9 (admin dashboard, FR-ADM-1): "Every route and API in this feature
  // MUST be operator-only, authorized server-side per request" with a real
  // 403 on the direct-URL case — not just a 200 page whose body happens to
  // say "forbidden". `src/lib/auth/authorize.ts`'s `requireOperator` already
  // exists for Route Handlers (via `toAuthErrorResponse`), but a Server
  // Component page has no equivalent way to set an HTTP status UNLESS this
  // flag is on: `forbidden()`/`unauthorized()` (next/navigation) throw a
  // special digest Next's render pipeline recognises to set a genuine
  // 403/401 response, and are gated behind this experimental flag until
  // Next promotes them to stable. Enabling it is additive — every other
  // route's behaviour (notFound/redirect, which are already stable) is
  // unaffected; only `app/admin/**`'s pages call `forbidden()`, on the
  // non-operator branch of `requireOperator`.
  experimental: {
    authInterrupts: true,
  },
};

export default nextConfig;
