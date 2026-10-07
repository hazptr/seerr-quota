/**
 * `FR-ADM-5` member drill-down — the header block: identity, sync status,
 * quota + source, and current usage. `FR-ADM-6`'s quota-override edit/clear
 * control (`MemberOverrideEditor`) is rendered right below `QuotaSummary` —
 * exactly the seam this component's header comment (P1-9) called out:
 * "`QuotaSummary` is its own component specifically so an edit form can
 * replace its body later without touching the page around it." `FR-ADM-14`
 * (act on behalf of) is still out of this task's scope (P2-4, built
 * concurrently by another agent).
 */
import { Pane } from '@/components/ui/Pane';
import { formatGB, formatTimestamp } from '@/components/member/logic';
import { MemberOverrideEditor } from './MemberOverrideEditor';
import { ClearAliasControl } from './ClearAliasControl';
import type { MemberDetailHeader as MemberDetailHeaderData } from '@/app/admin/members/[username]/_data/memberDetail';

function QuotaSummary({ header }: { header: MemberDetailHeaderData }) {
  if (header.quota.kind === 'unconfigured') {
    return <span className="sq-empty">not set — no limit configured</span>;
  }
  const valueText = header.quota.kind === 'unlimited' ? 'unlimited' : formatGB(header.quota.bytes);
  return (
    <span>
      {valueText}
      {header.quotaSource && <span style={{ color: 'var(--sq-muted)' }}> ({header.quotaSource})</span>}
    </span>
  );
}

export function MemberDetailHeader({ header, timeZone }: { header: MemberDetailHeaderData; timeZone: string }) {
  const labelStyle = { color: 'var(--sq-muted)', margin: 0 } as const;
  const valueStyle = { margin: 0 } as const;

  return (
    <Pane title={header.displayName || header.ssoUsername}>
      <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', rowGap: '0.5rem', columnGap: '1rem' }}>
        <dt style={labelStyle}>sso username</dt>
        <dd style={valueStyle}>{header.ssoUsername}</dd>

        <dt style={labelStyle}>entitled</dt>
        <dd style={valueStyle}>
          {header.entitled ? 'yes' : 'no'}
          {header.isOperator && <span style={{ marginLeft: '0.5rem', fontWeight: 600 }}>[operator]</span>}
        </dd>

        <dt style={labelStyle}>sync status</dt>
        <dd style={valueStyle}>
          {header.syncStatus}
          {header.syncNote && <span style={{ color: 'var(--sq-muted)' }}> — {header.syncNote}</span>}
        </dd>

        {header.loginAlias && (
          <>
            <dt style={labelStyle}>login alias</dt>
            <dd style={valueStyle}>
              {header.loginAlias}
              <ClearAliasControl ssoUsername={header.ssoUsername} currentAlias={header.loginAlias} />
            </dd>
          </>
        )}

        <dt style={labelStyle}>quota</dt>
        <dd style={valueStyle}>
          <QuotaSummary header={header} />
          {header.quotaNote && (
            <span style={{ color: 'var(--sq-muted)' }}>
              {' '}
              — {header.quotaNote}
            </span>
          )}
        </dd>

        <dt style={labelStyle}>usage</dt>
        <dd style={{ ...valueStyle, fontVariantNumeric: 'tabular-nums' }}>{header.usedBytes === null ? '—' : formatGB(header.usedBytes)}</dd>

        <dt style={labelStyle}>first seen</dt>
        <dd style={valueStyle}>{formatTimestamp(header.firstSeenAt, timeZone)}</dd>

        <dt style={labelStyle}>last synced</dt>
        <dd style={valueStyle}>{formatTimestamp(header.lastSyncedAt, timeZone)}</dd>
      </dl>
      <MemberOverrideEditor ssoUsername={header.ssoUsername} />
    </Pane>
  );
}
