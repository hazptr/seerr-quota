'use client';

/**
 * `FR-ADM-11` — settings editing: the six plain numeric settings plus the
 * `enforcement_enabled` toggle, which gets its own confirm flow ("the switch
 * that changes production behaviour for real people", the project's design).
 * `default_quota_bytes` is NOT here — that's `DefaultQuotaEditor`
 * (`FR-ADM-6`), rendered separately on `/admin`.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Pane } from '@/components/ui/Pane';
// Imported from the leaf module, NOT the `@/lib/quota` barrel — that barrel
// re-exports `./policy.ts`, which pulls in `@/lib/db`/`@/lib/audit`/
// `@/lib/config` (node:crypto/fs/path) transitively. `./units.ts` itself has
// zero imports (pure arithmetic), so this is the only safe way for a 'use
// client' component to reuse the house GB<->bytes conversion without
// dragging server-only code into the browser bundle (`next build` fails
// outright otherwise — verified: "UnhandledSchemeError: Reading from
// 'node:crypto' is not handled by plugins").
import { bytesToGb, gbToBytes } from '@/lib/quota/units';
import { EDITABLE_NUMERIC_SETTINGS, SETTING_METADATA, type EditableNumericSettingKey } from './logic';
import type { CurrentSettings } from '@/app/admin/_data/settings';

function toDisplayValue(key: EditableNumericSettingKey, storedValue: number): string {
  return SETTING_METADATA[key].unit === 'bytes_gb' ? String(bytesToGb(storedValue)) : String(storedValue);
}

function toStoredValue(key: EditableNumericSettingKey, displayValue: number): number {
  return SETTING_METADATA[key].unit === 'bytes_gb' ? gbToBytes(displayValue) : Math.round(displayValue);
}

function unitSuffix(key: EditableNumericSettingKey): string {
  switch (SETTING_METADATA[key].unit) {
    case 'bytes_gb':
      return 'GB';
    case 'days':
      return 'days';
    case 'seconds':
      return 's';
    case 'count':
      return '';
  }
}

function NumericSettingRow({ settingKey, storedValue }: { settingKey: EditableNumericSettingKey; storedValue: number }) {
  const router = useRouter();
  const meta = SETTING_METADATA[settingKey];
  const [value, setValue] = useState(toDisplayValue(settingKey, storedValue));
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      setErrorText('enter a number');
      return;
    }
    setBusy(true);
    setErrorText(null);
    setSaved(false);
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: settingKey, value: toStoredValue(settingKey, n) }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErrorText(json.error ?? `failed (${res.status})`);
        return;
      }
      setSaved(true);
      router.refresh();
    } catch {
      setErrorText('request failed — network error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem', padding: '0.375rem 0', borderBottom: 'var(--sq-border-width) var(--sq-rule-style) var(--sq-rule)' }}>
      <span style={{ minWidth: '12rem' }} title={meta.help}>
        {meta.label}
      </span>
      <Input type="number" min={0} step="1" value={value} onChange={(e) => setValue(e.target.value)} style={{ width: '7rem' }} aria-label={`${meta.label} value`} />
      <span style={{ color: 'var(--sq-muted)' }}>{unitSuffix(settingKey)}</span>
      <Button type="button" onClick={save} disabled={busy}>
        save
      </Button>
      {saved && <span style={{ fontSize: '0.75rem', color: 'var(--sq-muted)' }}>saved</span>}
      {errorText && <span style={{ fontSize: '0.75rem' }}>⚠ {errorText}</span>}
    </div>
  );
}

interface EnforcementPreviewResponse {
  currentlyEnabled: boolean;
  defaultQuotaConfigured: boolean;
  affectedCount: number;
  affectedUsernames: string[];
}

function EnforcementToggleControl({ initialEnabled, defaultQuotaConfigured }: { initialEnabled: boolean; defaultQuotaConfigured: boolean }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [preview, setPreview] = useState<EnforcementPreviewResponse | null>(null);
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  async function loadPreview() {
    setBusy('preview');
    setErrorText(null);
    try {
      const res = await fetch('/api/admin/settings/enforcement/preview');
      const json = await res.json();
      if (!res.ok) {
        setErrorText(json.error ?? `failed (${res.status})`);
        return;
      }
      setPreview(json as EnforcementPreviewResponse);
    } catch {
      setErrorText('request failed — network error');
    } finally {
      setBusy(null);
    }
  }

  async function commit(nextEnabled: boolean) {
    setBusy('commit');
    setErrorText(null);
    try {
      const res = await fetch('/api/admin/settings/enforcement', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErrorText(json.error ?? `failed (${res.status})`);
        return;
      }
      setEnabled(nextEnabled);
      setPreview(null);
      router.refresh();
    } catch {
      setErrorText('request failed — network error');
    } finally {
      setBusy(null);
    }
  }

  if (enabled) {
    return (
      <div>
        <p style={{ margin: '0 0 0.5rem' }}>
          enforcement is <strong>on</strong> — over-quota members are held for real.
        </p>
        <Button type="button" onClick={() => commit(false)} disabled={busy !== null}>
          turn off (shadow mode)
        </Button>
        {errorText && <p style={{ margin: '0.375rem 0 0', fontSize: '0.8125rem' }}>⚠ {errorText}</p>}
      </div>
    );
  }

  if (!defaultQuotaConfigured) {
    return (
      <p className="sq-empty" style={{ margin: 0 }}>
        enforcement cannot be enabled until a default quota is set (see above) — the app would refuse to start this way
      </p>
    );
  }

  return (
    <div>
      <p style={{ margin: '0 0 0.5rem' }}>
        enforcement is <strong>off</strong> (shadow mode) — decisions are recorded but nothing is held.
      </p>
      <Button type="button" onClick={loadPreview} disabled={busy !== null}>
        preview turning it on
      </Button>
      {preview && (
        <div style={{ margin: '0.5rem 0', fontSize: '0.8125rem', color: 'var(--sq-muted)' }}>
          <p style={{ margin: '0 0 0.375rem' }}>
            {preview.affectedCount === 0
              ? 'no member is currently over quota — nobody would be held right away'
              : `${preview.affectedCount} member${preview.affectedCount === 1 ? '' : 's'} ${preview.affectedCount === 1 ? 'is' : 'are'} currently over quota and would start being held: ${preview.affectedUsernames.join(', ')}`}
          </p>
          <Button type="button" variant="destructive" onClick={() => commit(true)} disabled={busy !== null}>
            confirm: enable enforcement
          </Button>
        </div>
      )}
      {errorText && <p style={{ margin: '0.375rem 0 0', fontSize: '0.8125rem' }}>⚠ {errorText}</p>}
    </div>
  );
}

export function SettingsPane({ settings }: { settings: CurrentSettings }) {
  return (
    <Pane title="settings">
      <div style={{ marginBottom: '1rem' }}>
        <EnforcementToggleControl initialEnabled={settings.enforcementEnabled} defaultQuotaConfigured={settings.defaultQuotaBytes !== null} />
      </div>
      <div>
        {EDITABLE_NUMERIC_SETTINGS.map((key) => (
          <NumericSettingRow key={key} settingKey={key} storedValue={settings.numeric[key]} />
        ))}
      </div>
    </Pane>
  );
}
