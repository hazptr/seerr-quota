import { describe, expect, it } from 'vitest';
import { deriveTitleAction, type TitleActionInput } from '@/lib/deletion/authorize';
import type { GuardEvaluation } from '@/lib/deletion/guards';

const NOT_FIRED: GuardEvaluation[] = [{ guardId: 'recently_played', fired: false }];
const FIRED_RECENT_PLAY: GuardEvaluation[] = [
  { guardId: 'recently_played', fired: true, memberMessage: 'Played recently.', operatorMessage: 'Played recently by erin.' },
];

function baseInput(overrides: Partial<TitleActionInput> = {}): TitleActionInput {
  return {
    requestedMode: 'delete_files',
    isOperator: false,
    hasActiveClaim: true,
    activeClaimantCount: 1,
    protectedTitle: false,
    protectedReason: null,
    sizeBytes: 1000,
    chargedBytes: 1000,
    guardEvaluations: NOT_FIRED,
    operatorOverrideGuards: false,
    ...overrides,
  };
}

describe('deriveTitleAction — the IDOR guard (FR-DEL-1 / FR-DEL-14)', () => {
  it('a member with NO active claim is unauthorized, regardless of requested mode', () => {
    const del = deriveTitleAction(baseInput({ hasActiveClaim: false, activeClaimantCount: 0, requestedMode: 'delete_files' }));
    expect(del).toEqual({ kind: 'unauthorized' });
    const rel = deriveTitleAction(baseInput({ hasActiveClaim: false, activeClaimantCount: 0, requestedMode: 'release_claim' }));
    expect(rel).toEqual({ kind: 'unauthorized' });
  });

  it('an unknown/guessed title id and a real title the member does not claim produce the IDENTICAL decision (no distinguishing signal)', () => {
    // Both are modeled the same way at this layer: hasActiveClaim: false.
    // deletionStore.ts guarantees an unknown id also resolves to
    // hasActiveClaim: false (via `exists: false`'s zero-value state), so
    // there is no code path here that could leak "this id is real" vs "this
    // id doesn't exist" — see test/deletion-execute.test.ts for the
    // end-to-end proof against the DB.
    const forRealButUnclaimedTitle = deriveTitleAction(baseInput({ hasActiveClaim: false, activeClaimantCount: 3 }));
    const forGuessedTitle = deriveTitleAction(baseInput({ hasActiveClaim: false, activeClaimantCount: 0 }));
    expect(forRealButUnclaimedTitle).toEqual({ kind: 'unauthorized' });
    expect(forGuessedTitle).toEqual({ kind: 'unauthorized' });
  });

  it('an operator with no claim is NOT unauthorized (D-6: operator can delete anything) — proceeds to a delete decision', () => {
    const decision = deriveTitleAction(baseInput({ isOperator: true, hasActiveClaim: false, activeClaimantCount: 0, requestedMode: 'delete_files' }));
    expect(decision).toEqual({ kind: 'execute', mode: 'delete_files', downgradedFromDelete: false });
  });

  it('an operator with no claim asking to RELEASE gets no_claim_to_release, not a silent no-op or a delete', () => {
    const decision = deriveTitleAction(baseInput({ isOperator: true, hasActiveClaim: false, activeClaimantCount: 0, requestedMode: 'release_claim' }));
    expect(decision).toEqual({ kind: 'blocked', reason: 'no_claim_to_release' });
  });
});

describe('deriveTitleAction — sole claimant may never release (universal, operator included)', () => {
  it('a sole-claimant MEMBER asking to release is BLOCKED, never silently upgraded to delete', () => {
    const decision = deriveTitleAction(baseInput({ requestedMode: 'release_claim', hasActiveClaim: true, activeClaimantCount: 1, isOperator: false }));
    expect(decision).toEqual({ kind: 'blocked', reason: 'sole_claimant_cannot_release' });
  });

  it('a sole-claimant OPERATOR asking to release is ALSO blocked — the invariant is not member-specific (D-3: bytes must never become unattributed while on disk)', () => {
    const decision = deriveTitleAction(baseInput({ requestedMode: 'release_claim', hasActiveClaim: true, activeClaimantCount: 1, isOperator: true }));
    expect(decision).toEqual({ kind: 'blocked', reason: 'sole_claimant_cannot_release' });
  });

  it('sole claimant asking to DELETE is honored', () => {
    const decision = deriveTitleAction(baseInput({ requestedMode: 'delete_files', hasActiveClaim: true, activeClaimantCount: 1 }));
    expect(decision).toEqual({ kind: 'execute', mode: 'delete_files', downgradedFromDelete: false });
  });
});

describe('deriveTitleAction — co-claimant: release touches nothing, delete downgrades for a member', () => {
  it('a co-claimant MEMBER asking to release is honored — no file touched (that IS the release semantics)', () => {
    const decision = deriveTitleAction(baseInput({ requestedMode: 'release_claim', hasActiveClaim: true, activeClaimantCount: 2, isOperator: false }));
    expect(decision).toEqual({ kind: 'execute', mode: 'release_claim', downgradedFromDelete: false });
  });

  it('a co-claimant MEMBER asking to DELETE is downgraded to release, flagged downgradedFromDelete: true', () => {
    const decision = deriveTitleAction(baseInput({ requestedMode: 'delete_files', hasActiveClaim: true, activeClaimantCount: 2, isOperator: false }));
    expect(decision).toEqual({ kind: 'execute', mode: 'release_claim', downgradedFromDelete: true });
  });

  it('a co-claimant OPERATOR asking to DELETE is honored AS DELETE — operator bypasses the co-claimant restriction (D-6)', () => {
    const decision = deriveTitleAction(baseInput({ requestedMode: 'delete_files', hasActiveClaim: true, activeClaimantCount: 2, isOperator: true }));
    expect(decision).toEqual({ kind: 'execute', mode: 'delete_files', downgradedFromDelete: false });
  });

  it('a co-claimant OPERATOR asking to release is honored as release too (not forced into delete)', () => {
    const decision = deriveTitleAction(baseInput({ requestedMode: 'release_claim', hasActiveClaim: true, activeClaimantCount: 2, isOperator: true }));
    expect(decision).toEqual({ kind: 'execute', mode: 'release_claim', downgradedFromDelete: false });
  });
});

describe('deriveTitleAction — protected (FR-DEL-3): blocks members only', () => {
  it('blocks a member, sole claimant, from deleting a protected title', () => {
    const decision = deriveTitleAction(baseInput({ protectedTitle: true, protectedReason: 'Maintainerr manages this one' }));
    expect(decision).toEqual({ kind: 'blocked', reason: 'protected', protectedReason: 'Maintainerr manages this one' });
  });

  it('does NOT block the operator', () => {
    const decision = deriveTitleAction(baseInput({ protectedTitle: true, protectedReason: 'pinned', isOperator: true }));
    expect(decision).toEqual({ kind: 'execute', mode: 'delete_files', downgradedFromDelete: false });
  });

  it('does not block a release on a protected title (protected only gates file deletion)', () => {
    const decision = deriveTitleAction(
      baseInput({ protectedTitle: true, protectedReason: 'pinned', requestedMode: 'release_claim', activeClaimantCount: 2 }),
    );
    expect(decision).toEqual({ kind: 'execute', mode: 'release_claim', downgradedFromDelete: false });
  });
});

describe('deriveTitleAction — the "watching" guard set (FR-DEL-4/4a/4b): blocks everyone, operator-overridable', () => {
  it('blocks a member when a guard has fired', () => {
    const decision = deriveTitleAction(baseInput({ guardEvaluations: FIRED_RECENT_PLAY }));
    expect(decision.kind).toBe('blocked');
    expect(decision).toMatchObject({ kind: 'blocked', reason: 'guard' });
    if (decision.kind === 'blocked' && decision.reason === 'guard') {
      expect(decision.guards).toEqual(FIRED_RECENT_PLAY);
    }
  });

  it('blocks the OPERATOR too, by default (guards protect everyone, not just members)', () => {
    const decision = deriveTitleAction(baseInput({ isOperator: true, guardEvaluations: FIRED_RECENT_PLAY, operatorOverrideGuards: false }));
    expect(decision).toMatchObject({ kind: 'blocked', reason: 'guard' });
  });

  it('operator override lets the operator proceed past a fired guard', () => {
    const decision = deriveTitleAction(baseInput({ isOperator: true, guardEvaluations: FIRED_RECENT_PLAY, operatorOverrideGuards: true }));
    expect(decision).toEqual({ kind: 'execute', mode: 'delete_files', downgradedFromDelete: false });
  });

  it('a member-supplied override flag is ignored — operatorOverrideGuards only matters when isOperator is true', () => {
    // A member can never set this themselves (execute.ts hard-ignores it for
    // a non-operator actor before this function is even called), but this
    // pins the pure function's own defense as a second layer.
    const decision = deriveTitleAction(baseInput({ isOperator: false, guardEvaluations: FIRED_RECENT_PLAY, operatorOverrideGuards: true }));
    expect(decision).toMatchObject({ kind: 'blocked', reason: 'guard' });
  });

  it('does not block a release (guards only gate file deletion)', () => {
    const decision = deriveTitleAction(baseInput({ requestedMode: 'release_claim', activeClaimantCount: 2, guardEvaluations: FIRED_RECENT_PLAY }));
    expect(decision).toEqual({ kind: 'execute', mode: 'release_claim', downgradedFromDelete: false });
  });
});

describe('deriveTitleAction — already gone', () => {
  it('sizeBytes <= 0 short-circuits to already_gone, bypassing protected/guard checks entirely', () => {
    const decision = deriveTitleAction(baseInput({ sizeBytes: 0, protectedTitle: true, guardEvaluations: FIRED_RECENT_PLAY }));
    expect(decision).toEqual({ kind: 'already_gone' });
  });

  it('negative sizeBytes (defensive) is also already_gone', () => {
    const decision = deriveTitleAction(baseInput({ sizeBytes: -1 }));
    expect(decision).toEqual({ kind: 'already_gone' });
  });

  it('does not apply to a release decision (release never checks sizeBytes)', () => {
    const decision = deriveTitleAction(baseInput({ requestedMode: 'release_claim', activeClaimantCount: 2, sizeBytes: 0 }));
    expect(decision).toEqual({ kind: 'execute', mode: 'release_claim', downgradedFromDelete: false });
  });
});

describe('deriveTitleAction — FR-DEL-15: fails closed on an unrecognised mode, NEVER falls through to delete_files', () => {
  it('a client typo ("release" instead of "release_claim") for a SOLE CLAIMANT is refused, not silently executed as a delete', () => {
    // This is the exact defect a review found: `if (requestedMode ===
    // 'release_claim') {...} else {...}` treated anything else — including
    // this one-letter-off typo — as a delete_files request. The caller's
    // static DeletionMode type does not protect against this: nothing
    // upstream of this module validates a request body before it's cast to
    // that type, so this function must defend itself against the value at
    // runtime, not trust its own parameter type.
    const decision = deriveTitleAction(
      baseInput({ requestedMode: 'release' as unknown as TitleActionInput['requestedMode'], hasActiveClaim: true, activeClaimantCount: 1, isOperator: false }),
    );
    expect(decision).toEqual({ kind: 'invalid_mode' });
  });

  it('an omitted requestedMode (undefined) is ALSO refused, not defaulted to delete', () => {
    const decision = deriveTitleAction(baseInput({ requestedMode: undefined as unknown as TitleActionInput['requestedMode'] }));
    expect(decision).toEqual({ kind: 'invalid_mode' });
  });

  it('garbage input (empty string, wrong case, unrelated value) is refused regardless of claim/operator state', () => {
    for (const bogus of ['', 'DELETE_FILES', 'delete', 'releaseClaim', 'drop_table', null, 42, {}]) {
      const decision = deriveTitleAction(
        baseInput({ requestedMode: bogus as unknown as TitleActionInput['requestedMode'], hasActiveClaim: true, activeClaimantCount: 1, isOperator: true }),
      );
      expect(decision).toEqual({ kind: 'invalid_mode' });
    }
  });

  it('is checked BEFORE the IDOR guard — even a non-claimant with an invalid mode gets invalid_mode, not unauthorized (both deny; the point is neither ever reaches execute)', () => {
    const decision = deriveTitleAction(
      baseInput({ requestedMode: 'nope' as unknown as TitleActionInput['requestedMode'], hasActiveClaim: false, activeClaimantCount: 0 }),
    );
    expect(decision).toEqual({ kind: 'invalid_mode' });
  });
});

describe('FR-DEL-29 — a member cannot delete files they were not charged for', () => {
  it('blocks a sole-claimant member charged for none of the title (the zero-charge case)', () => {
    expect(deriveTitleAction(baseInput({ chargedBytes: 0, sizeBytes: 63_698_411_461 }))).toEqual({
      kind: 'blocked', reason: 'includes_uncharged_files', chargedBytes: 0, sizeBytes: 63_698_411_461,
    });
  });

  it('blocks a member charged for only part of the title', () => {
    expect(deriveTitleAction(baseInput({ chargedBytes: 600 })).kind).toBe('blocked');
  });

  it('allows a member charged for all of it', () => {
    expect(deriveTitleAction(baseInput({ chargedBytes: 1000 }))).toEqual({ kind: 'execute', mode: 'delete_files', downgradedFromDelete: false });
  });

  it('does not stop the operator', () => {
    expect(deriveTitleAction(baseInput({ isOperator: true, chargedBytes: 0 })).kind).toBe('execute');
  });

  it('does not affect a co-claimant release', () => {
    expect(deriveTitleAction(baseInput({ requestedMode: 'release_claim', activeClaimantCount: 2, chargedBytes: 0 })).kind).toBe('execute');
  });
});
