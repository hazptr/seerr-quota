/**
 * Member-facing copy for the three notifications `wiki/Feature-05-Enforcement.md`
 * requires (`FR-ENF-3`, `FR-ENF-15`, `FR-ENF-12`). Pure — no I/O, no
 * `Date.now()` — every figure is an input, so every template is
 * hand-testable (AGENTS.md rule 9).
 *
 * `FR-ENF-3` is explicit that a held member must be told CONCRETE numbers —
 * "current usage, quota, shortfall, and held count" — never a bare "you are
 * over your limit." `buildHeldEmail` below is written so every one of those
 * four numbers appears verbatim in the body, and every acceptance criterion
 * test (`test/mail-templates.test.ts`, `test/enforcement-notify-real.test.ts`)
 * greps for the literal figures, not just that SOME email was built.
 *
 * Previously duplicated the one-line GB formatter `src/components/member/
 * logic.ts`'s `formatGB` already has, rather than importing it, because that
 * file was inside another agent's CONCURRENTLY-being-edited scope (the
 * deletion UI). P2-7 (this task): that editing has settled, and
 * `@/lib/enforcement/notify.ts` — a plain server-side lib module, same
 * category as this one — already imports `resolveNumericRuntimeSetting` from
 * the same file, proving it's a pure TS module (no `'use client'`, no React/
 * Next import) safe for a server-only module to import without pulling
 * client code into the bundle. Consolidated onto the shared implementation.
 * Matches `wiki/Configuration.md`'s decimal-GB convention (`FR-ACCT-9`,
 * `size_bytes/1e9`) exactly, so the number a member reads in email is the
 * same number they'd see on their dashboard.
 */
import { formatGB } from '@/components/member/logic';

export interface HeldEmailInput {
  usageBytes: number;
  quotaBytes: number;
  /** `usageBytes - quotaBytes`, never negative (`./notify.ts`'s `HoldNotification` — only ever called when over quota). */
  shortfallBytes: number;
  /** How many of this member's requests are currently held, INCLUDING the one that just triggered this notification (`FR-ENF-3`: "held count"). */
  heldRequestCount: number;
  appUrl: string;
}

export interface HeldEmail {
  subject: string;
  text: string;
}

/** `FR-ENF-3`/`D-4a`: the ONLY place a member learns why their request is stuck — Seerr itself just shows "Pending." Names the app in the subject so it doesn't read as a Seerr bug (`wiki/Feature-05-Enforcement.md`'s open question, resolved: "this app's own From/subject, clearly labelled"). */
export function buildHeldEmail(input: HeldEmailInput): HeldEmail {
  const plural = input.heldRequestCount === 1 ? 'request is' : 'requests are';
  const subject = 'seerr-quota: your request is on hold — over your storage quota';
  const text = [
    'Your Seerr request is being held rather than approved, because your account is currently over its storage quota.',
    '',
    `Current usage:    ${formatGB(input.usageBytes)}`,
    `Your quota:       ${formatGB(input.quotaBytes)}`,
    `Free up at least: ${formatGB(input.shortfallBytes)} to clear this`,
    '',
    `You have ${input.heldRequestCount} ${plural} waiting on this.`,
    '',
    "Nothing to re-request — once you free up enough space, this (and any other held request) is approved automatically on the next check. No action needed beyond freeing up space.",
    '',
    `Free up space: ${input.appUrl}`,
  ].join('\n');
  return { subject, text };
}

export interface ApprovedEmailInput {
  seerrRequestId: number;
  appUrl: string;
}

/** `FR-ENF-15`: "Being told you're stuck and never told you're unstuck is worse than not being told at all." */
export function buildApprovedEmail(input: ApprovedEmailInput): { subject: string; text: string } {
  const subject = 'seerr-quota: your held request has been approved';
  const text = [
    `Good news — your request (#${input.seerrRequestId}) was being held for being over your storage quota, and has now been approved because you freed up enough space.`,
    '',
    `${input.appUrl}`,
  ].join('\n');
  return { subject, text };
}

export interface DeclinedEmailInput {
  seerrRequestId: number;
  appUrl: string;
}

/** `FR-ENF-12`: the `HOLD_MAX_DAYS` safety-valve decline — "with a member notification sent first." */
export function buildDeclinedEmail(input: DeclinedEmailInput): { subject: string; text: string } {
  const subject = 'seerr-quota: your held request was declined (held too long)';
  const text = [
    `Your request (#${input.seerrRequestId}) was held for being over your storage quota, and has now been automatically declined because it was held too long without enough space being freed up.`,
    '',
    "You're welcome to request it again once you're back under quota.",
    '',
    `${input.appUrl}`,
  ].join('\n');
  return { subject, text };
}
