'use client';

/**
 * `FR-ADM-6`'s per-member half, embedded in `MemberDetailHeader`'s
 * `QuotaSummary` seam. Two actions: set an override (`0` = unlimited,
 * `FR-POL-2`) or clear it (inherit the default). Both go through
 * `POST /api/admin/quota/preview` first (`FR-POL-4`) — setting an override
 * additionally requires an explicit confirmation checkbox when the preview's
 * `requiresConfirmation` is true (`FR-POL-5`: "MUST require an explicit
 * confirmation that states how far over it puts them and that it will block
 * their next request").
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { formatGB } from '@/components/member/logic';
import type { MemberQuotaChangePreview } from '@/lib/quota';

type Mode = 'set' | 'clear';

interface OverridePreviewResponse {
  kind: 'override' | 'clear';
  preview: MemberQuotaChangePreview;
  warning?: string | null;
}

function effectiveLabel(effective: MemberQuotaChangePreview['after']): string {
  if (effective.kind === 'unconfigured') return 'not set';
  if (effective.kind === 'unlimited') return 'unlimited';
  return formatGB(effective.bytes);
}

export function MemberOverrideEditor({ ssoUsername }: { ssoUsername: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('set');
  const [gb, setGb] = useState('');
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<OverridePreviewResponse | null>(null);
  const [previewedKey, setPreviewedKey] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const currentKey = mode === 'set' ? `set:${gb}` : 'clear';

  async function runPreview() {
    if (mode === 'set') {
      const proposedGb = Number(gb);
      if (!Number.isFinite(proposedGb)) {
        setErrorText('enter a number of GB');
        return;
      }
    }
    setBusy('preview');
    setErrorText(null);
    setMessage(null);
    setConfirmed(false);
    try {
      const body = mode === 'set' ? { mode: 'override', ssoUsername, proposedGb: Number(gb) } : { mode: 'clear', ssoUsername };
      const res = await fetch('/api/admin/quota/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        setErrorText(json.error ?? `preview failed (${res.status})`);
        setPreview(null);
        setPreviewedKey(null);
        return;
      }
      setPreview(json as OverridePreviewResponse);
      setPreviewedKey(currentKey);
    } catch {
      setErrorText('preview request failed — network error');
    } finally {
      setBusy(null);
    }
  }

  async function commit() {
    if (!preview || previewedKey !== currentKey) return;
    if (preview.preview.requiresConfirmation && !confirmed) return;

    setBusy('commit');
    setErrorText(null);
    try {
      const url = mode === 'set' ? '/api/admin/quota/override' : '/api/admin/quota/clear';
      const body =
        mode === 'set'
          ? { ssoUsername, proposedGb: Number(gb), note: note.trim() || undefined }
          : { ssoUsername, note: note.trim() || undefined };
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok) {
        setErrorText(json.error ?? `apply failed (${res.status})`);
        return;
      }
      setMessage(mode === 'set' ? `override set — effective quota now ${effectiveLabel(json.after)}` : `override cleared — effective quota now ${effectiveLabel(json.after)}`);
      setPreview(null);
      setPreviewedKey(null);
      setConfirmed(false);
      setNote('');
      router.refresh();
    } catch {
      setErrorText('apply request failed — network error');
    } finally {
      setBusy(null);
    }
  }

  const previewIsCurrent = preview !== null && previewedKey === currentKey;
  const needsConfirm = previewIsCurrent && preview!.preview.requiresConfirmation;
  const canCommit = previewIsCurrent && busy === null && (!needsConfirm || confirmed);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
          <input
            type="radio"
            name={`quota-mode-${ssoUsername}`}
            checked={mode === 'set'}
            onChange={() => {
              setMode('set');
              setPreview(null);
              setPreviewedKey(null);
            }}
          />
          set override
        </label>
        {mode === 'set' && (
          <Input
            type="number"
            min={0}
            step="1"
            value={gb}
            onChange={(e) => {
              setGb(e.target.value);
              setPreview(null);
              setPreviewedKey(null);
            }}
            placeholder="GB (0 = unlimited)"
            style={{ width: '10rem' }}
            aria-label="proposed override in GB"
          />
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
          <input
            type="radio"
            name={`quota-mode-${ssoUsername}`}
            checked={mode === 'clear'}
            onChange={() => {
              setMode('clear');
              setPreview(null);
              setPreviewedKey(null);
            }}
          />
          clear (inherit default)
        </label>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem' }}>
        <Button type="button" onClick={runPreview} disabled={busy !== null || (mode === 'set' && gb.trim() === '')}>
          preview
        </Button>
        <Button type="button" onClick={commit} disabled={!canCommit}>
          apply
        </Button>
      </div>

      {previewIsCurrent && (
        <div style={{ fontSize: '0.8125rem', color: 'var(--sq-muted)' }}>
          <p style={{ margin: '0 0 0.25rem' }}>
            usage {formatGB(preview!.preview.usageBytes)} · current {effectiveLabel(preview!.preview.before)} → proposed {effectiveLabel(preview!.preview.after)}
          </p>
          {preview!.preview.isOver && (
            <p style={{ margin: '0 0 0.25rem', color: 'var(--sq-fg)' }}>
              <strong>⚠ this puts them {formatGB(preview!.preview.overageAfterBytes)} over — their next request will be held.</strong>
            </p>
          )}
          {preview!.warning && <p style={{ margin: '0 0 0.25rem' }}>⚠ {preview!.warning}</p>}
          {needsConfirm && (
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', color: 'var(--sq-fg)' }}>
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              I understand this holds their next request
            </label>
          )}
          <label style={{ display: 'block', marginTop: '0.375rem' }}>
            note (optional)
            <Input type="text" value={note} onChange={(e) => setNote(e.target.value)} style={{ marginLeft: '0.5rem', width: '16rem' }} />
          </label>
        </div>
      )}

      {errorText && <p style={{ margin: 0, fontSize: '0.8125rem' }}>⚠ {errorText}</p>}
      {message && <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--sq-muted)' }}>{message}</p>}
    </div>
  );
}
