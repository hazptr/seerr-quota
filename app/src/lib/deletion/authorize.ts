/**
 * The pure per-title authorization + action-derivation core
 * (`FR-DEL-1`/`2`/`3`/`14`, AGENTS.md rule 9: "pure core, impure shell").
 * Every input is plain, freshly-read data — no I/O, no `Date.now()`, no DB —
 * so every branch is hand-calculable in `test/deletion-authorize.test.ts`.
 *
 * This is the ONE function `plan.ts` (read-only preview) and `execute.ts`
 * (the actual step-3 confirm) both call, over the SAME freshly-read state,
 * so a preview and an execution can never silently disagree about what a
 * given title's action is — the same "one decision function, called from
 * every path" discipline `src/lib/enforcement/decide.ts` and
 * `src/lib/attribution/compute.ts` already establish elsewhere in this
 * codebase.
 *
 * **This is the IDOR guard (`FR-DEL-1`/`FR-DEL-14`).** Every field on
 * `TitleActionInput` describing claim/protection/guard state MUST be
 * re-read fresh, per call, from the database — never cached, never trusted
 * from whatever the client's UI last rendered. `execute.ts` re-derives this
 * decision from scratch for every title in every batch call; nothing here
 * or upstream of it ever "remembers" a previous decision for the same
 * title. See `test/deletion-authorize.test.ts` and
 * `test/deletion-execute.test.ts` for tests that actively try to break this
 * by claiming an id the actor was never granted.
 *
 * ## `FR-DEL-15` — fail closed on an unrecognised mode
 *
 * The very FIRST thing this function does is validate `input.requestedMode`
 * against the known `DeletionMode` literals (`types.ts`'s `isDeletionMode`)
 * and return `{ kind: 'invalid_mode' }` for anything else — before
 * `hasActiveClaim` is even consulted. This is deliberately NOT a caller-side
 * concern: a review proved that a sole claimant sending `requestedMode:
 * 'release'` (a typo for `'release_claim'`) fell through the old `if
 * (requestedMode === 'release_claim') ... else` shape straight into the
 * `delete_files` branch below — an unrecognised instruction defaulting to
 * the irreversible one. Validating here, in the one pure function every
 * path (`plan.ts`, `execute.ts`) funnels through, makes that impossible
 * regardless of what any future caller does or fails to do.
 *
 * ## Judgment calls made here (flagged, not silently picked — see this
 * task's final report)
 *
 * 1. **A sole claimant may never release — full stop, operator included.**
 *    `wiki/Architecture.md` D-3 frames this as a structural invariant
 *    ("bytes can never become unattributed while they sit on disk"), not
 *    merely an anti-collusion rule for members — so it is enforced
 *    regardless of `isOperator`. An operator who genuinely wants to zero out
 *    a sole claim without touching the file has `claim.reassigned`
 *    (`P3-6`, not built here) for that; `release_claim` is not a substitute.
 * 2. **Co-claimant + requested `delete_files`: auto-downgraded to `release`
 *    for a MEMBER, honored as-asked for an OPERATOR.** `FR-DEL-2` scopes
 *    the "only release is offered" restriction to "the only MEMBER action" —
 *    read literally, an operator's blanket delete authority (`D-6`: "the
 *    operator can delete anything") is not subject to it. The member-side
 *    downgrade is exactly the mechanism the wiki's "claim released between
 *    review and confirm" edge case describes: re-validate at execute, and
 *    if the actor is no longer sole, downgrade delete->release and say so
 *    (`downgradedFromDelete: true`) rather than deleting a file they no
 *    longer solely own, or erroring the whole batch.
 * 3. **`protected` blocks members only** (`FR-DEL-3`'s literal wording,
 *    "MUST NOT be deletable by a member") — but the `guards.ts` "watching"
 *    guard set blocks EVERYONE, operator included, unless explicitly
 *    overridden (`FR-DEL-4`'s "operator MAY override ... with an explicit
 *    extra confirmation").
 * 4. **An unknown/garbage title id and a real title the subject simply
 *    doesn't claim are indistinguishable to the CALLER** (both produce
 *    `kind: 'unauthorized'`) — deliberately, so this function can never be
 *    used to probe which ids are real (`FR-DEL-14`). `execute.ts` still logs
 *    the distinction internally (audit `detail.reason`), because the audit
 *    log is an operator-facing forensic tool, not a surface a member reads.
 */
import type { DeletionMode } from './types';
import { isDeletionMode } from './types';
import type { GuardEvaluation } from './guards';
import { firedGuards } from './guards';

export interface TitleActionInput {
  requestedMode: DeletionMode;
  isOperator: boolean;
  /** Whether the SUBJECT (the acting member, or the operator's `onBehalfOf` target) holds a currently-ACTIVE claim on this title — freshly read. */
  hasActiveClaim: boolean;
  /** Total distinct ACTIVE claimants on this title (including the subject, if `hasActiveClaim`), freshly read. */
  activeClaimantCount: number;
  protectedTitle: boolean;
  protectedReason: string | null;
  /** Title's current known size, bytes. `<= 0` means "nothing to delete" — `D-2`'s own "not yet available" convention, run in reverse for "no longer available." */
  sizeBytes: number;
  /** The SUBJECT's active claim's `charged_bytes` (0 with no claim). Less than `sizeBytes` means the title holds files the subject didn't cause — pre-existing seasons, or the operator's own adds (`FR-ACCT-8`) — so a member may not delete it (`FR-DEL-29`). */
  chargedBytes: number;
  /** Every registered guard's evaluation (`guards.ts`'s `runDeletionGuards`) — today just `recently_played`; `in_progress`/`active_session` slot in later with zero change to this function (`FR-DEL-4b`). */
  guardEvaluations: readonly GuardEvaluation[];
  /** Operator-only explicit override of every currently-fired guard (`FR-DEL-4`). Ignored when `isOperator` is false — a member can never set this. */
  operatorOverrideGuards: boolean;
}

export type TitleBlockedReason = 'protected' | 'includes_uncharged_files' | 'sole_claimant_cannot_release' | 'no_claim_to_release' | 'guard';

export type TitleActionDecision =
  | { kind: 'execute'; mode: DeletionMode; downgradedFromDelete: boolean }
  | { kind: 'already_gone' }
  /** `FR-DEL-1`/`14` — the IDOR guard. Maps to `access.denied` in the audit log, never `delete.blocked`: the subject has no standing to have asked at all. */
  | { kind: 'unauthorized' }
  /** `FR-DEL-15` — `requestedMode` was absent, malformed, or not an exact known `DeletionMode` literal. Maps to `access.denied` in the audit log, and — critically — NEVER to `execute`/`delete_files`: an unrecognised instruction must be refused, not defaulted to the destructive branch. */
  | { kind: 'invalid_mode' }
  | { kind: 'blocked'; reason: 'protected'; protectedReason: string | null }
  | { kind: 'blocked'; reason: 'includes_uncharged_files'; chargedBytes: number; sizeBytes: number }
  | { kind: 'blocked'; reason: 'sole_claimant_cannot_release' }
  | { kind: 'blocked'; reason: 'no_claim_to_release' }
  | { kind: 'blocked'; reason: 'guard'; guards: GuardEvaluation[] };

export function deriveTitleAction(input: TitleActionInput): TitleActionDecision {
  // FR-DEL-15 — checked FIRST, before hasActiveClaim/isOperator/anything
  // else: fail closed on any mode that isn't an exact known literal, rather
  // than letting it fall through to whichever branch a loose `===
  // 'release_claim'` check happens to miss.
  if (!isDeletionMode(input.requestedMode)) {
    return { kind: 'invalid_mode' };
  }

  if (!input.hasActiveClaim) {
    if (!input.isOperator) {
      // Not a claimant, not an operator: FR-DEL-14's IDOR guard, full stop.
      return { kind: 'unauthorized' };
    }
    // Operator, no claim at all (D-6: "the operator can delete anything").
    // There is nothing to release, but a delete is still fully within
    // authority (e.g. cleaning up an orphaned/unclaimed title).
    if (input.requestedMode === 'release_claim') {
      return { kind: 'blocked', reason: 'no_claim_to_release' };
    }
    return finishDeleteDecision(input);
  }

  const soleClaimant = input.activeClaimantCount <= 1;

  if (input.requestedMode === 'release_claim') {
    if (soleClaimant) {
      // Judgment call 1 above — universal, not member-specific.
      return { kind: 'blocked', reason: 'sole_claimant_cannot_release' };
    }
    return { kind: 'execute', mode: 'release_claim', downgradedFromDelete: false };
  }

  // requestedMode === 'delete_files'
  if (soleClaimant || input.isOperator) {
    // Sole claimant always gets the delete they asked for; an operator
    // co-claimant does too (judgment call 2 above — operator bypass).
    return finishDeleteDecision(input);
  }

  // Member, co-claimant, asked to delete: the ONLY member action available
  // is release (FR-DEL-2) — auto-downgrade rather than deny or error,
  // matching the wiki's explicit "claim released between review and
  // confirm" edge case.
  return { kind: 'execute', mode: 'release_claim', downgradedFromDelete: true };
}

/** Shared tail for every path that ends up attempting an actual file delete — the already-gone check, then the protected/guard blocks. Only ever reached with `requestedMode === 'delete_files'` in spirit (the no-claim-operator branch synthesises the same outcome). */
function finishDeleteDecision(input: TitleActionInput): TitleActionDecision {
  if (input.sizeBytes <= 0) {
    return { kind: 'already_gone' };
  }
  if (input.protectedTitle && !input.isOperator) {
    return { kind: 'blocked', reason: 'protected', protectedReason: input.protectedReason };
  }
  // FR-DEL-29: a member's delete removes the WHOLE title, so it is only theirs
  // to remove when they were charged for all of it. Attribution is per series
  // (P4-1), so a Season 3 request on a show whose S1-2 predate it (or that the
  // operator added by hand) leaves a sole claimant charged for none of it —
  // and, before this check, free to delete all of it.
  if (!input.isOperator && input.chargedBytes < input.sizeBytes) {
    return { kind: 'blocked', reason: 'includes_uncharged_files', chargedBytes: input.chargedBytes, sizeBytes: input.sizeBytes };
  }
  const fired = firedGuards(input.guardEvaluations);
  if (fired.length > 0 && !(input.isOperator && input.operatorOverrideGuards)) {
    return { kind: 'blocked', reason: 'guard', guards: fired };
  }
  return { kind: 'execute', mode: 'delete_files', downgradedFromDelete: false };
}
