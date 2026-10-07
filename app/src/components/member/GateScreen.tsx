/**
 * `FR-SSO-8`: "A member who is authenticated but has no `member` row, or
 * whose `sync_status` is not `matched`, MUST get an informative screen
 * explaining the situation and naming the operator — never a raw error, and
 * never an empty dashboard that looks like 'you're using 0 bytes'." Renders
 * `@/lib/auth/memberGate.ts`'s `MemberGateBlocked` — that module already
 * composed the ready-to-render, non-raw-error message; this component is
 * just its presentation, in the same terminal-theme pane language as the
 * rest of the app. No numbers anywhere on this screen, deliberately — there
 * is nothing measured yet to show.
 */
import { Pane } from '@/components/ui/Pane';
import type { MemberGateBlocked } from '@/lib/auth/memberGate';

export function GateScreen({ gate }: { gate: MemberGateBlocked }) {
  return (
    <Pane title="account not linked">
      <p style={{ margin: 0 }}>{gate.message}</p>
      {gate.syncStatus && (
        <>
          <hr className="sq-rule" />
          <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--sq-muted)' }}>
            status: <span style={{ color: 'var(--sq-fg)' }}>{gate.syncStatus}</span>
            {gate.syncNote && <> — {gate.syncNote}</>}
          </p>
        </>
      )}
    </Pane>
  );
}
