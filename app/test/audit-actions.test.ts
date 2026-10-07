import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, requiresTarget, type AuditAction } from '@/lib/audit/actions';

const SPEC_ACTIONS = [
  'member.created',
  'member.sync_changed',
  'member.entitlement_changed',
  'quota.set',
  'quota.cleared',
  'setting.changed',
  'enforcement.toggled',
  'request.approved',
  'request.held',
  'request.declined',
  'request.notified',
  'request.skipped',
  'claim.released',
  'claim.reassigned',
  'title.protected',
  'title.unprotected',
  'delete.requested',
  'delete.scheduled',
  'delete.executed',
  'delete.failed',
  'delete.blocked',
  'delete.cancelled',
  'access.denied',
  'webhook.rejected',
  'sync.failed',
  'invariant.violated',
];

describe('audit action vocabulary — matches wiki/Feature-08-Audit-Log.md "Action vocabulary" exactly', () => {
  it('AUDIT_ACTIONS contains exactly the 26 actions from the spec table (25 rows, one of which — title.protected/.unprotected — is two actions), no more, no fewer', () => {
    expect([...AUDIT_ACTIONS].sort()).toEqual([...SPEC_ACTIONS].sort());
    expect(AUDIT_ACTIONS.length).toBe(26);
  });

  it('requiresTarget is false ONLY for webhook.rejected and sync.failed — the only two "Target: —" rows', () => {
    const withoutTarget = AUDIT_ACTIONS.filter((action) => !requiresTarget(action)).slice().sort();
    expect(withoutTarget).toEqual(['sync.failed', 'webhook.rejected']);

    const withTarget = AUDIT_ACTIONS.filter((action) => requiresTarget(action));
    expect(withTarget.length).toBe(24);
  });

  it('a caller cannot invent an action string not in the vocabulary — compile-time proof', () => {
    function acceptsOnlyKnownActions(action: AuditAction): AuditAction {
      return action;
    }
    expect(acceptsOnlyKnownActions('quota.set')).toBe('quota.set');

    // @ts-expect-error — 'quota.made_up' is not a member of the AuditAction
    // union. If AuditAction is ever loosened to `string` (or this literal
    // stops erroring for any other reason), `@ts-expect-error` itself
    // becomes an "unused directive" error and `tsc --noEmit` fails,
    // catching the regression.
    acceptsOnlyKnownActions('quota.made_up');
  });
});
