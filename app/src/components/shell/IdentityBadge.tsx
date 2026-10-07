/**
 * Small "who's signed in" readout for `AppShell`'s header — the raw forward-auth
 * username header value as the reverse proxy sent it (`identity.displayUsername`,
 * casing preserved, DISPLAY ONLY per `@/lib/auth/identity.ts`'s header
 * comment: never compared or looked up by), plus an "operator" tag when
 * applicable. Server component — no client JS needed, so it renders with
 * JavaScript disabled (`FR-UI-9`).
 */
import type { Identity } from '@/lib/auth/identity';

export function IdentityBadge({ identity }: { identity: Identity }) {
  return (
    <span style={{ fontSize: '0.8125rem', color: 'var(--sq-muted)', whiteSpace: 'nowrap' }}>
      {identity.displayUsername}
      {identity.isOperator && (
        <span style={{ color: 'var(--sq-fg)', marginLeft: '0.375rem', fontWeight: 600 }}>[operator]</span>
      )}
    </span>
  );
}
