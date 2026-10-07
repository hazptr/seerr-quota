'use client';

/**
 * `FR-ADM-6`'s global-default half. `FR-POL-4`: the "who would be newly over
 * / newly under" preview MUST be shown before a commit — enforced here by
 * disabling the apply button until a preview has been fetched for the
 * EXACT value currently typed (`previewedForGb`); editing the number after
 * previewing invalidates it and the operator must preview again. Calls
 * `POST /api/admin/quota/preview` (read-only) then `POST
 * /api/admin/quota/default` (the actual write, already fully audited by
 * `@/lib/quota/policy.ts`'s `setGlobalDefaultQuota`).
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { formatGB } from '@/components/member/logic';
import type { DefaultChangePreview } from '@/lib/quota';

interface PreviewResponse {
  kind: 'default';
  preview: DefaultChangePreview;
  warning: string | null;
}

export function DefaultQuotaEditor({ currentDefaultBytes }: { currentDefaultBytes: number | null }) {
  const router = useRouter();
  const [gb, setGb] = useState<string>(currentDefaultBytes !== null ? String(currentDefaultBytes / 1_000_000_000) : '');
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewedForGb, setPreviewedForGb] = useState<string | null>(null);
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  function parsedGb(): number | null {
    const n = Number(gb);
    return Number.isFinite(n) ? n : null;
  }

  async function runPreview() {
    const proposedGb = parsedGb();
    if (proposedGb === null) {
      setErrorText('enter a number of GB');
      return;
    }
    setBusy('preview');
    setErrorText(null);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/quota/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'default', proposedGb }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErrorText(json.error ?? `preview failed (${res.status})`);
        setPreview(null);
        setPreviewedForGb(null);
        return;
      }
      setPreview(json as PreviewResponse);
      setPreviewedForGb(gb);
    } catch {
      setErrorText('preview request failed — network error');
    } finally {
      setBusy(null);
    }
  }

  async function commit() {
    const proposedGb = parsedGb();
    if (proposedGb === null || previewedForGb !== gb) return;
    setBusy('commit');
    setErrorText(null);
    try {
      const res = await fetch('/api/admin/quota/default', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proposedGb, note: note.trim() || undefined }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErrorText(json.error ?? `apply failed (${res.status})`);
        return;
      }
      setMessage(`default quota set to ${formatGB(json.after)}`);
      setPreview(null);
      setPreviewedForGb(null);
      setNote('');
      router.refresh();
    } catch {
      setErrorText('apply request failed — network error');
    } finally {
      setBusy(null);
    }
  }

  const canCommit = preview !== null && previewedForGb === gb && busy === null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
          <span style={{ color: 'var(--sq-muted)' }}>default quota (GB, 0 = unlimited)</span>
          <Input
            type="number"
            min={0}
            step="1"
            value={gb}
            onChange={(e) => {
              setGb(e.target.value);
              setPreview(null);
              setPreviewedForGb(null);
            }}
            style={{ width: '7rem' }}
            aria-label="proposed default quota in GB"
          />
        </label>
        <Button type="button" onClick={runPreview} disabled={busy !== null || gb.trim() === ''}>
          preview
        </Button>
        <Button type="button" onClick={commit} disabled={!canCommit}>
          apply
        </Button>
      </div>

      {preview && (
        <div style={{ fontSize: '0.8125rem', color: 'var(--sq-muted)' }}>
          <label style={{ display: 'block', marginBottom: '0.375rem' }}>
            note (optional)
            <Input type="text" value={note} onChange={(e) => setNote(e.target.value)} style={{ marginLeft: '0.5rem', width: '16rem' }} />
          </label>
          <p style={{ margin: '0 0 0.25rem' }}>
            {preview.preview.newlyOver.length > 0 ? (
              <strong style={{ color: 'var(--sq-fg)' }}>
                {preview.preview.newlyOver.length} member{preview.preview.newlyOver.length === 1 ? '' : 's'} would become newly over: {preview.preview.newlyOver.map((m) => m.ssoUsername).join(', ')}
              </strong>
            ) : (
              'no member would become newly over'
            )}
          </p>
          {preview.preview.newlyUnder.length > 0 && (
            <p style={{ margin: '0 0 0.25rem' }}>{preview.preview.newlyUnder.length} member{preview.preview.newlyUnder.length === 1 ? '' : 's'} would come back under: {preview.preview.newlyUnder.map((m) => m.ssoUsername).join(', ')}</p>
          )}
          <p style={{ margin: '0 0 0.25rem' }}>{preview.preview.unaffectedOverrideCount} member{preview.preview.unaffectedOverrideCount === 1 ? '' : 's'} on a custom override, unaffected by this change</p>
          {preview.warning && <p style={{ margin: 0 }}>⚠ {preview.warning}</p>}
        </div>
      )}

      {errorText && <p style={{ margin: 0, fontSize: '0.8125rem' }}>⚠ {errorText}</p>}
      {message && <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--sq-muted)' }}>{message}</p>}
    </div>
  );
}
