/**
 * FR-SSO-7 building blocks for the Seerr webhook. `POST /api/seerr/webhook`
 * is exempt from FR-SSO-2 — "Seerr can't authenticate through the gate":
 * Seerr reaches this app directly over the shared Docker network
 * (`http://seerr-quota:3000/api/seerr/webhook`), never traversing the
 * reverse-proxy/forward-auth vhost at all (wiki/Feature-01-SSO-Identity.md
 * "Interactions").
 * In its place, the route MUST require a shared secret presented as a
 * header, compared in constant time; a missing/wrong secret MUST 401 and
 * MUST write a `webhook.rejected` audit row.
 *
 * This module holds only the helper functions and the middleware exemption
 * constant; the webhook route itself
 * (`src/app/api/seerr/webhook/route.ts`, P2-6) imports
 * `verifyWebhookSecret` + `recordWebhookRejected` from here.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { getDb } from '@/lib/db';
import { newCorrelationId, writeAuditRow, type Source } from '@/lib/audit';

/** `src/middleware.ts`'s matcher exempts exactly this path from FR-SSO-2 (FR-SSO-7). */
export const SEERR_WEBHOOK_PATH = '/api/seerr/webhook';

/**
 * Constant-time string comparison. Uses `node:crypto`'s `timingSafeEqual`,
 * but NEVER on the raw input buffers directly — `timingSafeEqual` itself
 * throws a `RangeError` on unequal-length buffers, so comparing raw inputs
 * would force a caller into an `a.length !== b.length` branch (or a
 * try/catch standing in for one) BEFORE the constant-time comparison ever
 * runs. Either shape leaks the length relationship through an early
 * return/branch, which is exactly the timing leak this function avoids.
 *
 * Instead, both inputs are first hashed to a FIXED-length SHA-256 digest —
 * always 32 bytes, regardless of input length — and only the two digests are
 * compared with `timingSafeEqual`. There is no length check anywhere in this
 * function and no way for `timingSafeEqual` to throw here, so the code path
 * taken (and its rough timing) does not depend on whether the two inputs
 * were the same length — the exact leak a naive implementation would
 * introduce.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Verifies a webhook request's shared-secret header against
 * `Config.secrets.seerrWebhookSecret`. A missing/empty header value always
 * fails, and a misconfigured (empty) expected secret always fails too — this
 * never treats "both sides are empty" as a match, which a bare
 * `constantTimeEqual('', '')` would.
 */
export function verifyWebhookSecret(providedHeaderValue: string | null | undefined, expectedSecret: string): boolean {
  if (!providedHeaderValue) return false;
  if (expectedSecret.trim() === '') return false;
  return constantTimeEqual(providedHeaderValue, expectedSecret);
}

/**
 * Writes the `webhook.rejected` audit row FR-SSO-7 requires for a bad/missing
 * secret. `webhook.rejected` is one of the two "Target: —" actions in
 * wiki/Feature-08-Audit-Log.md's vocabulary table (the other being
 * `sync.failed`), so no `targetType`/`targetId` is passed — `writeAuditRow`
 * does not require one for this action (see `src/lib/audit/actions.ts`'s
 * `requiresTarget`).
 */
export function recordWebhookRejected(reason: string, source: Source = 'webhook'): void {
  const db = getDb();
  writeAuditRow(db, {
    actor: 'system',
    actorRole: 'system',
    action: 'webhook.rejected',
    outcome: 'denied',
    source,
    correlationId: newCorrelationId(),
    detail: { reason },
  });
}
