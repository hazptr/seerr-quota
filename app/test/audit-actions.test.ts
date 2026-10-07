import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, requiresTarget, type AuditAction } from '@/lib/audit/actions';

const SPEC_ACTIONS = [
  'member.created',
  'member.sync_changed',
  'member.entitlement_changed',
  'member.alias_linked',
  'member.alias_cleared',
  'member.alias_link_denied',
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
  'sync.forced',
  'invariant.violated',
];

describe('audit action vocabulary — matches wiki/Feature-08-Audit-Log.md "Action vocabulary" exactly', () => {
  it('AUDIT_ACTIONS contains exactly the 30 actions from the spec table (25 rows, one of which — title.protected/.unprotected — is two actions, plus 0.2.0\'s member.alias_linked/alias_cleared/alias_link_denied/sync.forced)', () => {
    expect([...AUDIT_ACTIONS].sort()).toEqual([...SPEC_ACTIONS].sort());
    expect(AUDIT_ACTIONS.length).toBe(30);
  });

  it('requiresTarget is false ONLY for webhook.rejected, sync.failed, and sync.forced — the only "Target: —" rows', () => {
    const withoutTarget = AUDIT_ACTIONS.filter((action) => !requiresTarget(action)).slice().sort();
    expect(withoutTarget).toEqual(['sync.failed', 'sync.forced', 'webhook.rejected']);

    const withTarget = AUDIT_ACTIONS.filter((action) => requiresTarget(action));
    expect(withTarget.length).toBe(27);
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
