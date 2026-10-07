/**
 * `FR-POL-6`: "A member MUST be able to see their own quota, current usage,
 * percentage, remaining bytes, and any operator note." Renders all three
 * `FR-POL-2a` quota states distinctly (never promoting "unconfigured" to a
 * number) via `deriveQuotaDisplay` (`./logic.ts`). The over-quota indicator
 * is a glyph + bold text, PLUS colour (`quotaSeverity`) — colour is never the
 * *sole* signal (`FR-UI-7`), but is no longer withheld either (FR-UI-5,
 * revised 2026-08-25 for full status coloring per the operator).
 */
import type { CSSProperties } from 'react';
import { Pane } from '@/components/ui/Pane';
import type { EffectiveQuota } from '@/lib/members/quota';
import { SnapshotNote } from './SnapshotNote';
import { deriveQuotaDisplay, formatGB, quotaSeverity, severityFillVar } from './logic';

export function QuotaPane({
  quota,
  usedBytes,
  quotaNote,
  snapshotAtSeconds,
  nowSeconds,
  staleAfterSeconds,
  timeZone,
}: {
  quota: EffectiveQuota;
  usedBytes: number;
  quotaNote: string | null;
  snapshotAtSeconds: number;
  nowSeconds: number;
  staleAfterSeconds: number;
  timeZone: string;
}) {
  const display = deriveQuotaDisplay(quota, usedBytes);
  const labelStyle: CSSProperties = { color: 'var(--sq-muted)', margin: 0 };
  const valueStyle: CSSProperties = { margin: 0, fontVariantNumeric: 'tabular-nums' };

  return (
    <Pane title="quota">
      <SnapshotNote
        snapshotAtSeconds={snapshotAtSeconds}
        nowSeconds={nowSeconds}
        staleAfterSeconds={staleAfterSeconds}
        timeZone={timeZone}
      />
      <hr className="sq-rule" />
      <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', rowGap: '0.5rem', columnGap: '1rem' }}>
        <dt style={labelStyle}>usage</dt>
        <dd style={valueStyle}>{formatGB(display.usedBytes)}</dd>

        <dt style={labelStyle}>quota</dt>
        <dd style={{ margin: 0 }}>
          {display.kind === 'unconfigured' && <span>not set — no limit has been configured for you yet</span>}
          {display.kind === 'unlimited' && <span>unlimited</span>}
          {display.kind === 'limited' && <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatGB(display.quotaBytes)}</span>}
        </dd>

        {display.kind === 'limited' && (
          <>
            <dt style={labelStyle}>used</dt>
            <dd style={valueStyle}>{display.percentUsed.toFixed(1)}%</dd>

            <dt style={labelStyle}>remaining</dt>
            <dd style={valueStyle}>
              {display.overQuota ? (
                <strong style={{ color: 'var(--sq-critical)' }}>⚠ OVER QUOTA — {formatGB(Math.abs(display.remainingBytes))} over</strong>
              ) : (
                formatGB(display.remainingBytes)
              )}
            </dd>
          </>
        )}
      </dl>
      {display.kind === 'limited' && (
        <div className="sq-bar-track" style={{ marginTop: '0.75rem' }} role="img" aria-label={`${display.percentUsed.toFixed(0)}% of quota used`}>
          <div
            className="sq-bar-fill"
            style={{ width: `${Math.min(display.percentUsed, 100)}%`, background: severityFillVar(quotaSeverity(display.percentUsed)) }}
          />
        </div>
      )}
      {quotaNote && (
        <>
          <hr className="sq-rule" />
          <p style={{ margin: 0 }}>
            <span style={{ color: 'var(--sq-muted)' }}>note: </span>
            {quotaNote}
          </p>
        </>
      )}
    </Pane>
  );
}
