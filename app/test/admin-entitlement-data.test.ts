import { describe, expect, it } from 'vitest';
import { loadEntitlementMismatch } from '@/app/admin/_data/entitlement';

/**
 * `loadEntitlementMismatch` (`@/app/admin/_data/entitlement.ts`, `FR-ADM-9`).
 * Deps are injectable (same test seam as every other `*Sync` module in this
 * app) so this never makes a real Authentik call. Covers: the mismatch diff
 * itself, which slug each side is fetched for, and graceful degradation when
 * Authentik is unreachable (never a thrown exception reaching the caller).
 */

describe('loadEntitlementMismatch', () => {
  it('reports both entitlement sets and their diff, fetching jellyseerr and seerr-quota separately', async () => {
    const calls: string[] = [];
    const result = await loadEntitlementMismatch({
      authentik: {
        fetchUsernames: async (slug) => {
          calls.push(slug);
          if (slug === 'jellyseerr') return ['frank', 'erin', 'dana'];
          if (slug === 'seerr-quota') return ['frank', 'erin'];
          throw new Error(`unexpected slug ${slug}`);
        },
      },
    });
    expect(calls).toEqual(['jellyseerr', 'seerr-quota']);
    expect(result).toEqual({ available: true, diff: { entitledToSeerrOnly: ['dana'], entitledToQuotaOnly: [] } });
  });

  it('degrades to available:false with a non-secret error message when Authentik is unreachable, never throwing', async () => {
    const result = await loadEntitlementMismatch({
      authentik: {
        fetchUsernames: async () => {
          throw new Error('could not reach authentik (GET /core/applications/seerr-quota/)');
        },
      },
    });
    expect(result.available).toBe(false);
    if (result.available) throw new Error('unreachable');
    expect(result.error).toContain('could not reach authentik');
  });

  it('an identical entitlement set on both sides reports no mismatch', async () => {
    const result = await loadEntitlementMismatch({
      authentik: { fetchUsernames: async () => ['frank', 'erin'] },
    });
    expect(result).toEqual({ available: true, diff: { entitledToSeerrOnly: [], entitledToQuotaOnly: [] } });
  });
});
