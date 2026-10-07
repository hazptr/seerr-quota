/**
 * `POST /api/seerr/webhook` — the P2-6 webhook receiver (`FR-ENF-8`,
 * `FR-SSO-7`). Exempt from `src/middleware.ts`'s `Remote-User` gate (Seerr
 * reaches this route directly over the shared Docker network, never through
 * the reverse proxy/forward-auth gate — `wiki/Feature-01-SSO-Identity.md`
 * "Interactions"); authenticated instead by a shared secret, presented in
 * the `X-Seerr-Webhook-Secret` header (`wiki/Deployment.md` §4: "Custom
 * Headers entry named `X-Seerr-Webhook-Secret`"), compared in constant time
 * via the existing `src/lib/auth/webhookSecret.ts` helpers.
 *
 * **The payload is untrusted (`FR-ENF-8`).** Seerr's default JSON template
 * carries requester email/username/avatar and media details, all trimmed
 * away per `wiki/Deployment.md`'s operator instructions — but even if the
 * operator ever un-trims it, this route reads ONLY `request_id` from the
 * body. Everything the decision actually needs (the request's current
 * status, its real requester) is re-fetched from Seerr and the local
 * snapshot by `processPendingRequest` (`@/lib/enforcement`) — a forged
 * payload naming another member's `request_id` still only ever produces a
 * decision computed from THAT request's real, live requester; it cannot
 * redirect the verdict to a different member than the one Seerr itself says
 * owns the request.
 *
 * The webhook is a LATENCY optimisation, not the contract — `./process.ts`'s
 * header comment and `wiki/Feature-05-Enforcement.md`'s "How it works": the
 * poller (`@/lib/enforcement`'s `runPendingSweep`) re-evaluates every still-
 * pending request on its own schedule regardless of whether a webhook ever
 * arrives, so a dropped/failed delivery here never leaves a request stuck.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getConfig } from '@/lib/config';
import { recordWebhookRejected, verifyWebhookSecret } from '@/lib/auth/webhookSecret';
import { createEnforcementNotifier, processPendingRequest } from '@/lib/enforcement';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** `wiki/Deployment.md` §4 — the exact Custom Headers entry name the operator configures in Seerr's webhook notification settings. */
const WEBHOOK_SECRET_HEADER = 'X-Seerr-Webhook-Secret';

/**
 * Seerr's webhook templates are string-interpolated (`{{request_id}}` lands
 * in the JSON body as a STRING, even though the underlying field is
 * numeric per Seerr's webhook `KeyMap`), so this
 * accepts either a JSON number or a numeric string. Anything else — missing,
 * non-numeric, negative, fractional — is rejected; this is the ONLY field
 * ever read from the body (`FR-ENF-8`).
 */
function extractRequestId(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = (body as Record<string, unknown>).request_id;
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const parsed = Number.parseInt(trimmed, 10);
    return parsed > 0 ? parsed : null;
  }
  return null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const config = getConfig();
  const provided = req.headers.get(WEBHOOK_SECRET_HEADER);

  // FR-SSO-7: constant-time comparison; a missing/wrong secret 401s and
  // writes a `webhook.rejected` audit row via `recordWebhookRejected`.
  if (!verifyWebhookSecret(provided, config.secrets.seerrWebhookSecret)) {
    recordWebhookRejected(provided ? 'bad webhook secret' : 'missing webhook secret header', 'webhook');
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json body' }, { status: 400 });
  }

  const requestId = extractRequestId(body);
  if (requestId === null) {
    return NextResponse.json({ error: 'missing or invalid request_id' }, { status: 400 });
  }

  // FR-ENF-1/FR-ENF-7/FR-ENF-8: the SAME decision-and-apply pipeline the
  // poller uses. `processPendingRequest` never throws — a Seerr-side failure
  // comes back as `{ kind: 'error', ... }`, not an exception, so this route
  // can always answer Seerr with a plain 200 once the secret has checked out.
  //
  // P2-9: a real notifier, built fresh per request (cheap — no I/O at
  // construction, same as `processPendingRequest`'s own default `seerrActions`
  // build). `source: 'webhook'` is baked into every audit row it writes,
  // since the payload carries no such field for it to read (`FR-ENF-8`).
  const outcome = await processPendingRequest(requestId, 'webhook', { notifier: createEnforcementNotifier({ source: 'webhook' }) });

  return NextResponse.json({ outcome }, { status: 200 });
}
