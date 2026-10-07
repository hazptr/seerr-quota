/**
 * The P2-9 integration point AND its real implementation. This file defines
 * the injectable `EnforcementNotifier` interface, called from `./process.ts`
 * at exactly the three moments `wiki/Feature-05-Enforcement.md` requires a
 * member be told something (`FR-ENF-3`/`FR-ENF-15`/`FR-ENF-12`); the shipped
 * P2-6 default that sends nothing (`noopNotifier`, kept below — still the
 * default `./process.ts` falls back to when no notifier is injected at all,
 * and still what `enforcement_enabled = false` effectively behaves as, since
 * `./process.ts` gates every notifier call on that flag); and now (P2-9) the
 * real one, `createEnforcementNotifier`, which sends over the configured SMTP
 * relay (`@/lib/mail`).
 *
 * ## What `createEnforcementNotifier` owns, that `./process.ts` cannot
 *
 * `./process.ts` is read-only from this module's perspective and already does
 * two things correctly for a SUCCESSFUL send: it calls `notifyHeld` at most
 * once per hold EPISODE (never on a re-decide of an already-held request),
 * and it writes the `request.notified` / `request_decision.notified_at`
 * bookkeeping itself, but ONLY when `NotifyResult.sent === true`. Everything
 * else `FR-ENF-13`/`14`/`15` require has to live HERE, because `./process.ts`
 * cannot be changed to add it:
 *
 *   - **`FR-ENF-14` cooldown** — "at most one hold notification per member
 *     per `NOTIFY_COOLDOWN`, regardless of how many requests they hold."
 *     `./process.ts`'s own per-request "new hold" gate is necessary but not
 *     sufficient: TWO different requests for the SAME member can each be a
 *     genuinely NEW hold (e.g. two webhooks arriving close together), and
 *     each would call `notifyHeld` — so the per-MEMBER throttle against
 *     `member.last_hold_notified_at` has to be enforced inside `notifyHeld`
 *     itself. `HOLD_NOTIFY_IN_FLIGHT` below also closes the concurrency
 *     window between "read the cooldown" and "the send actually lands":
 *     without it, two near-simultaneous `notifyHeld` calls for the same
 *     member (two different `createEnforcementNotifier` instances — one per
 *     webhook request, per `../../app/api/seerr/webhook/route.ts`) could both
 *     see "not yet cooled down" and both send. It's module-level (not a
 *     per-instance closure) for exactly that reason — mirrors `./process.ts`'s
 *     own top-level `IN_FLIGHT` map, one level up (that one keys on
 *     `seerrRequestId`; this one keys on `ssoUsername`, the dimension
 *     `FR-ENF-14`'s cooldown actually applies to).
 *   - **`FR-ENF-13`'s "how many requests are waiting"** — `HoldNotification`
 *     (below) carries no held-count field; `./process.ts` never computes one
 *     to pass through this seam. `countActiveHolds` answers it directly from
 *     `request_decision` instead of requiring `./process.ts` to change.
 *   - **`FR-ENF-13`'s "no email -> surface to the operator, not silently
 *     skipped"** — `surfaceNoEmail` below writes the audit row `./process.ts`
 *     has no way to know it needs to write (it never sees WHY `sent` came
 *     back `false`).
 *   - **SMTP failures** — "A mail failure MUST NOT break enforcement" is
 *     already true structurally: every `notify*` call below
 *     catches its own transport error, NEVER rethrows (`./process.ts`'s
 *     `try`/`catch` around each call is defence in depth, not the only
 *     guard), and reports `{ sent: false }` — which is exactly what makes
 *     "do not mark a notification as sent when it wasn't" true whether or
 *     not `./process.ts`'s own `catch` ever runs. `surfaceSendFailure` below
 *     is what turns that failure into something the operator can actually
 *     see (an audit row), since `./process.ts` only `console.warn`s on a
 *     THROWN error and does nothing at all for a returned `sent: false`.
 *
 * A cooldown-suppressed send (the member WAS notified recently — throttling
 * working as designed) is deliberately NOT audited as a failure: nothing was
 * attempted, nothing failed, and the `request.held` row `./process.ts` writes
 * already documents the hold itself. Only a genuine attempt that could not
 * complete (no email on file, or the SMTP call threw) gets its own audit row
 * here.
 */
import { and, eq } from 'drizzle-orm';
import { newCorrelationId, summarizeError, writeAuditRow, type Source } from '@/lib/audit';
import { getConfig } from '@/lib/config';
import { getDb, type SeerrQuotaDb } from '@/lib/db';
import { appSetting, member, requestDecision } from '@/lib/db/schema';
import { resolveNumericRuntimeSetting } from '@/components/member/logic';
import { buildApprovedEmail, buildDeclinedEmail, buildHeldEmail, createSmtpTransport, type MailTransport } from '@/lib/mail';

export interface HoldNotification {
  ssoUsername: string;
  seerrRequestId: number;
  usageBytes: number;
  quotaBytes: number;
  /** `usageBytes - quotaBytes` (never negative — only called when over quota). */
  shortfallBytes: number;
}

export interface ApprovedNotification {
  ssoUsername: string;
  seerrRequestId: number;
}

export interface DeclinedNotification {
  ssoUsername: string;
  seerrRequestId: number;
  /** Always `'hold_expired'` today (`FR-ENF-12`) — typed for forward compatibility with `FR-ENF-11`'s manual decline, which is not built here. */
  reason: 'hold_expired';
}

export interface NotifyResult {
  /** `true` only if mail was actually sent — `./process.ts` writes `request_decision.notified_at` / the `request.notified` audit row ONLY when this is `true`. */
  sent: boolean;
}

/** Injectable seam — see this file's header comment. */
export interface EnforcementNotifier {
  notifyHeld(n: HoldNotification): Promise<NotifyResult>;
  notifyApproved(n: ApprovedNotification): Promise<NotifyResult>;
  notifyDeclined(n: DeclinedNotification): Promise<NotifyResult>;
}

/**
 * This app's SHIPPING default (P2-6). Sends nothing — no SMTP client exists
 * to call — and always reports `sent: false`, so nothing downstream ever
 * records a notification that didn't happen. Matches `FR-ENF-5`'s
 * `enforcement_enabled = false` requirement trivially (nothing is ever
 * called Seerr-side either way), and remains correct even once enforcement
 * is switched on, until P2-9 supplies a real notifier.
 */
export const noopNotifier: EnforcementNotifier = {
  async notifyHeld() {
    return { sent: false };
  },
  async notifyApproved() {
    return { sent: false };
  },
  async notifyDeclined() {
    return { sent: false };
  },
};

// ---------------------------------------------------------------------------
// P2-9 — the real implementation. See this file's header comment for what
// this owns that ./process.ts (read-only from here) cannot.
// ---------------------------------------------------------------------------

export interface EnforcementNotifierDeps {
  /**
   * Baked into every audit row this notifier writes — `HoldNotification`/
   * `ApprovedNotification`/`DeclinedNotification` carry no `source` field
   * (adding one would be a REQUIRED-field change to a type `./process.ts`
   * constructs literals against, which this module does not own), so the
   * caller supplies it once at construction instead. `./poller.ts` passes
   * `'poller'`; the webhook route passes `'webhook'`.
   */
  source: Source;
  db?: SeerrQuotaDb;
  transport?: MailTransport;
  /** Unix seconds; defaults to `Date.now()`. Test seam. */
  now?: () => number;
}

interface MemberContactRow {
  email: string | null;
  lastHoldNotifiedAt: number | null;
}

function loadMemberContact(db: SeerrQuotaDb, ssoUsername: string): MemberContactRow | undefined {
  return db
    .select({ email: member.email, lastHoldNotifiedAt: member.lastHoldNotifiedAt })
    .from(member)
    .where(eq(member.ssoUsername, ssoUsername))
    .get();
}

/**
 * How many of this member's requests are currently `hold` in `request_decision`
 * — summed in JS over a `.all()`, not a SQL `COUNT`, matching `./usage.ts`'s
 * `getMemberUsageBytes` and its documented reasoning: "cheap at this app's
 * scale (single-digit members ...)."
 */
function countActiveHolds(db: SeerrQuotaDb, ssoUsername: string): number {
  const rows = db
    .select({ seerrRequestId: requestDecision.seerrRequestId })
    .from(requestDecision)
    .where(and(eq(requestDecision.ssoUsername, ssoUsername), eq(requestDecision.decision, 'hold')))
    .all();
  return rows.length;
}

/** `app_setting.notify_cooldown_s`, falling back to the `NOTIFY_COOLDOWN_S` config seed — same DB-wins-over-config shape `src/lib/quota/policy.ts` uses for `grace_bytes`, reusing the same helper. */
function loadCooldownSeconds(db: SeerrQuotaDb): number {
  const row = db.select().from(appSetting).where(eq(appSetting.key, 'notify_cooldown_s')).get();
  return resolveNumericRuntimeSetting(row, getConfig().runtime.notifyCooldownS);
}

type NotificationKind = 'held' | 'approved' | 'declined';

/** `FR-ENF-13`: "A member with no email on record MUST be surfaced to the operator rather than silently un-notified." */
function surfaceNoEmail(db: SeerrQuotaDb, source: Source, seerrRequestId: number, ssoUsername: string, notification: NotificationKind): void {
  writeAuditRow(db, {
    actor: 'system',
    actorRole: 'system',
    action: 'request.notified',
    targetType: 'request',
    targetId: String(seerrRequestId),
    outcome: 'error',
    source,
    correlationId: newCorrelationId(),
    detail: { reason: 'no_email_on_record', ssoUsername, notification },
  });
}

/** A mail failure MUST NOT break enforcement (the project's design) — but it MUST be visible. This is that visibility. */
function surfaceSendFailure(
  db: SeerrQuotaDb,
  source: Source,
  seerrRequestId: number,
  ssoUsername: string,
  notification: NotificationKind,
  err: unknown,
): void {
  writeAuditRow(db, {
    actor: 'system',
    actorRole: 'system',
    action: 'request.notified',
    targetType: 'request',
    targetId: String(seerrRequestId),
    outcome: 'error',
    source,
    correlationId: newCorrelationId(),
    detail: { reason: 'smtp_send_failed', ssoUsername, notification, error: summarizeError(err) },
  });
}

/**
 * `FR-ENF-14`'s cross-instance concurrency guard — module-level (not a
 * per-`createEnforcementNotifier`-instance closure) because two DIFFERENT
 * `EnforcementNotifier` instances (one per webhook HTTP request) must not be
 * able to race each other for the same member. See this file's header
 * comment for the full reasoning.
 */
const HOLD_NOTIFY_IN_FLIGHT = new Map<string, Promise<NotifyResult>>();

/**
 * The real `EnforcementNotifier` (P2-9): sends over the configured SMTP
 * relay (`@/lib/mail`), enforces the `FR-ENF-14` per-member cooldown, and surfaces
 * (`FR-ENF-13`) or records (SMTP failure) everything `./process.ts` cannot
 * see on its own. Construction is cheap and does no I/O (the underlying
 * `MailTransport` only opens a connection inside `.send()`) — safe to call
 * fresh per poller sweep / per webhook request, matching `./process.ts`'s
 * own `resolveDeps` convention of rebuilding its Seerr client fresh each
 * call rather than caching a singleton.
 */
export function createEnforcementNotifier(deps: EnforcementNotifierDeps): EnforcementNotifier {
  const db = deps.db ?? getDb();
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const config = getConfig();
  const transport: MailTransport =
    deps.transport ??
    createSmtpTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      user: config.secrets.smtpUser,
      pass: config.secrets.smtpPass,
      from: config.smtp.from,
      fromName: 'seerr-quota',
    });

  async function doNotifyHeld(n: HoldNotification): Promise<NotifyResult> {
    const contact = loadMemberContact(db, n.ssoUsername);
    if (!contact || !contact.email) {
      surfaceNoEmail(db, deps.source, n.seerrRequestId, n.ssoUsername, 'held');
      return { sent: false };
    }

    const nowS = now();
    const cooldownS = loadCooldownSeconds(db);
    if (contact.lastHoldNotifiedAt !== null && nowS - contact.lastHoldNotifiedAt < cooldownS) {
      // FR-ENF-14: within cooldown — expected throttling, not a failure. No
      // audit row here; the `request.held` row already documents the hold.
      return { sent: false };
    }

    // `+1`: `./process.ts` calls `notifyHeld` BEFORE it upserts THIS
    // request's own `request_decision` row as `hold` (see its `applyHold`),
    // so the row for the transition that triggered this call is never yet
    // counted by `countActiveHolds` above.
    const heldRequestCount = countActiveHolds(db, n.ssoUsername) + 1;
    const email = buildHeldEmail({
      usageBytes: n.usageBytes,
      quotaBytes: n.quotaBytes,
      shortfallBytes: n.shortfallBytes,
      heldRequestCount,
      appUrl: config.upstreams.appUrl,
    });

    try {
      await transport.send({ to: contact.email, subject: email.subject, text: email.text });
    } catch (err) {
      surfaceSendFailure(db, deps.source, n.seerrRequestId, n.ssoUsername, 'held', err);
      return { sent: false };
    }

    db.update(member).set({ lastHoldNotifiedAt: nowS }).where(eq(member.ssoUsername, n.ssoUsername)).run();
    return { sent: true };
  }

  async function notifyHeld(n: HoldNotification): Promise<NotifyResult> {
    const existing = HOLD_NOTIFY_IN_FLIGHT.get(n.ssoUsername);
    if (existing) return existing;
    const run = doNotifyHeld(n).finally(() => HOLD_NOTIFY_IN_FLIGHT.delete(n.ssoUsername));
    HOLD_NOTIFY_IN_FLIGHT.set(n.ssoUsername, run);
    return run;
  }

  async function notifyApproved(n: ApprovedNotification): Promise<NotifyResult> {
    const contact = loadMemberContact(db, n.ssoUsername);
    if (!contact || !contact.email) {
      surfaceNoEmail(db, deps.source, n.seerrRequestId, n.ssoUsername, 'approved');
      return { sent: false };
    }
    const email = buildApprovedEmail({ seerrRequestId: n.seerrRequestId, appUrl: config.upstreams.appUrl });
    try {
      await transport.send({ to: contact.email, subject: email.subject, text: email.text });
    } catch (err) {
      surfaceSendFailure(db, deps.source, n.seerrRequestId, n.ssoUsername, 'approved', err);
      return { sent: false };
    }
    return { sent: true };
  }

  async function notifyDeclined(n: DeclinedNotification): Promise<NotifyResult> {
    const contact = loadMemberContact(db, n.ssoUsername);
    if (!contact || !contact.email) {
      surfaceNoEmail(db, deps.source, n.seerrRequestId, n.ssoUsername, 'declined');
      return { sent: false };
    }
    const email = buildDeclinedEmail({ seerrRequestId: n.seerrRequestId, appUrl: config.upstreams.appUrl });
    try {
      await transport.send({ to: contact.email, subject: email.subject, text: email.text });
    } catch (err) {
      surfaceSendFailure(db, deps.source, n.seerrRequestId, n.ssoUsername, 'declined', err);
      return { sent: false };
    }
    return { sent: true };
  }

  return { notifyHeld, notifyApproved, notifyDeclined };
}
