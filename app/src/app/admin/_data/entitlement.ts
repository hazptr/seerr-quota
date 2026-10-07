/**
 * `FR-ADM-9`: "surface any mismatch between the set of Authentik users
 * entitled to `jellyseerr` and those entitled to `seerr-quota`, since a
 * member who can request but can't reach this app has no way to
 * self-serve." (`wiki/Feature-01-SSO-Identity.md`'s open question, resolved
 * there: "gate the app on its own `seerr-quota` slug ... derive membership
 * from the `jellyseerr` binding ... in practice the two lists should be kept
 * identical, and FR-ADM-9 surfaces it when they aren't.")
 *
 * This app's own Authentik application slug is `Config.upstreams.
 * selfAppSlug` (`SELF_APP_SLUG`, default `seerr-quota`) — a config concern
 * per `wiki/Configuration.md`, not a hardcoded constant: it's how this
 * module knows which Authentik application to compare `SEERR_APP_SLUG`
 * against.
 *
 * Both entitlement sets are fetched LIVE from Authentik on every dashboard
 * load — there is no local table of "who is entitled to seerr-quota"
 * (`member.entitled` specifically means the `jellyseerr` binding, per its
 * own column comment in `src/lib/db/schema.ts`) — mirroring exactly what
 * `src/lib/members/sync.ts` already does every reconcile cycle for
 * `jellyseerr` alone. Each fetch is independently wrapped so an Authentik
 * hiccup degrades this ONE panel to "unavailable" rather than crashing the
 * whole dashboard (the same `runStep`-style failure isolation used
 * throughout this codebase, applied here without importing `runStep` itself
 * since the shape needed is simpler than `StepResult`).
 */
import { getConfig } from '@/lib/config';
import { createAuthentikClient } from '@/lib/authentik/client';
import { fetchEntitledIdentities } from '@/lib/authentik/identity';
import { diffEntitlement, type EntitlementDiff } from '@/components/admin/logic';

export type EntitlementMismatchResult =
  | { available: true; diff: EntitlementDiff }
  | { available: false; error: string };

/** Deps are injectable (test seam, same shape as every other `*Sync` module in this app). */
export interface EntitlementMismatchDeps {
  authentik?: { fetchUsernames: (slug: string, appUuid: string | undefined) => Promise<string[]> };
}

function resolveFetcher(deps: EntitlementMismatchDeps): (slug: string, appUuid: string | undefined) => Promise<string[]> {
  if (deps.authentik) return deps.authentik.fetchUsernames;
  const config = getConfig();
  const client = createAuthentikClient(config.upstreams.authentikUrl, config.secrets.authentikToken, config.scheduling.upstreamTimeoutMs, config.scheduling.upstreamRetries);
  return async (slug, appUuid) => (await fetchEntitledIdentities(client, slug, appUuid)).map((i) => i.ssoUsername);
}

export async function loadEntitlementMismatch(deps: EntitlementMismatchDeps = {}): Promise<EntitlementMismatchResult> {
  const config = getConfig();
  const fetchUsernames = resolveFetcher(deps);

  try {
    const [seerrUsernames, quotaUsernames] = await Promise.all([
      fetchUsernames(config.upstreams.seerrAppSlug, config.upstreams.authentikJellyseerrAppUuid),
      fetchUsernames(config.upstreams.selfAppSlug, undefined),
    ]);
    return { available: true, diff: diffEntitlement(seerrUsernames, quotaUsernames) };
  } catch (err) {
    // `UpstreamError.message` is documented never to carry a secret
    // (`src/lib/http/client.ts`'s header comment) — safe to surface verbatim
    // (`FR-ADM-15`).
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}
