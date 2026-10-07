/**
 * `FR-ADM-9`: surfaces any mismatch between who's entitled to `jellyseerr`
 * and who's entitled to this app's own Authentik binding — the harmful
 * direction is "can request in Seerr, has no way to reach this dashboard to
 * self-serve." Data comes from `src/app/admin/_data/entitlement.ts`'s LIVE
 * Authentik comparison; `available: false` means that call itself failed
 * (Authentik unreachable, or the `seerr-quota` application slug doesn't
 * exist yet) — rendered as an honest "check unavailable" rather than a
 * silently-empty (and therefore falsely reassuring) mismatch list.
 */
import { Pane } from '@/components/ui/Pane';
import type { EntitlementMismatchResult } from '@/app/admin/_data/entitlement';

export function EntitlementMismatchPane({ result }: { result: EntitlementMismatchResult }) {
  if (!result.available) {
    return (
      <Pane title="entitlement check">
        <p className="sq-empty" style={{ margin: 0 }}>
          could not compare jellyseerr vs. seerr-quota entitlement right now ({result.error})
        </p>
      </Pane>
    );
  }

  const { entitledToSeerrOnly, entitledToQuotaOnly } = result.diff;
  const nothingToShow = entitledToSeerrOnly.length === 0 && entitledToQuotaOnly.length === 0;

  return (
    <Pane title="entitlement check">
      {nothingToShow ? (
        <p className="sq-empty" style={{ margin: 0 }}>
          jellyseerr and seerr-quota entitlement match
        </p>
      ) : (
        <>
          {entitledToSeerrOnly.length > 0 && (
            <p style={{ margin: '0.25rem 0' }}>
              ! entitled to jellyseerr but not seerr-quota (can request, can&apos;t self-serve): {entitledToSeerrOnly.join(', ')}
            </p>
          )}
          {entitledToQuotaOnly.length > 0 && (
            <p style={{ margin: '0.25rem 0' }}>! entitled to seerr-quota but not jellyseerr: {entitledToQuotaOnly.join(', ')}</p>
          )}
        </>
      )}
    </Pane>
  );
}
