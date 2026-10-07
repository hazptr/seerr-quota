/**
 * `FR-AUD-9`'s filter controls: actor, action, target type/id, outcome, time
 * range. A plain `<form method="get">` — no client JS anywhere in this
 * component — so filtering/paging works with JavaScript disabled
 * (`FR-UI-9`), matching `@/components/admin/Pagination`'s own plain-`<a>`
 * convention on this same page. Submitting always resets to page 1 (no
 * hidden `page` field), which is the expected behaviour for "I changed what
 * I'm looking for."
 */
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { AUDIT_ACTIONS } from '@/lib/audit';
import { OUTCOMES, TARGET_TYPES, type AuditFilterQuery } from './auditLogic';

/** `<select>` has no shared primitive (`@/components/ui` only has `Input`/`Button`/`Textarea`) — hand-styled to match `.sq-input`'s visual language (monospace, `--sq-*` tokens only, `FR-UI-1`) rather than left unstyled. */
const selectStyle = {
  background: 'transparent',
  border: 'var(--sq-border-width) solid var(--sq-pane-rule)',
  color: 'var(--sq-fg)',
  fontFamily: 'var(--sq-font)',
  fontSize: '0.8125rem',
  padding: '0.25rem 0.375rem',
} as const;

const fieldLabelStyle = { display: 'flex', flexDirection: 'column' as const, gap: '0.25rem', fontSize: '0.75rem', color: 'var(--sq-muted)' };

export function AuditFilterForm({ basePath, current }: { basePath: string; current: AuditFilterQuery }) {
  return (
    <form
      method="get"
      action={basePath}
      style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'end', marginBottom: '0.75rem' }}
    >
      <label style={fieldLabelStyle}>
        actor
        <Input type="text" name="actor" defaultValue={current.actor ?? ''} placeholder="sso_username" />
      </label>

      <label style={fieldLabelStyle}>
        action
        <select name="action" defaultValue={current.action ?? ''} style={selectStyle}>
          <option value="">(any)</option>
          {AUDIT_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </label>

      <label style={fieldLabelStyle}>
        target type
        <select name="targetType" defaultValue={current.targetType ?? ''} style={selectStyle}>
          <option value="">(any)</option>
          {TARGET_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>

      <label style={fieldLabelStyle}>
        target id
        <Input type="text" name="targetId" defaultValue={current.targetId ?? ''} />
      </label>

      <label style={fieldLabelStyle}>
        outcome
        <select name="outcome" defaultValue={current.outcome ?? ''} style={selectStyle}>
          <option value="">(any)</option>
          {OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </label>

      <label style={fieldLabelStyle}>
        from
        <Input type="date" name="from" defaultValue={current.from ?? ''} />
      </label>

      <label style={fieldLabelStyle}>
        to
        <Input type="date" name="to" defaultValue={current.to ?? ''} />
      </label>

      <Button type="submit">filter</Button>

      {(current.actor || current.action || current.targetType || current.targetId || current.outcome || current.from || current.to) && (
        <a href={basePath} style={{ fontSize: '0.8125rem', color: 'var(--sq-muted)' }}>
          clear filters
        </a>
      )}
    </form>
  );
}
