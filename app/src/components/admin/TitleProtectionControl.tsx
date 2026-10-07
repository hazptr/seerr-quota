'use client';

/**
 * `FR-ADM-7` — protect/unprotect a title, with a reason. The reason is
 * user-facing copy (shown to the member whose deletion it blocks, per
 * `wiki/Feature-06-Self-Service-Deletion.md`'s guard surface), so the form
 * requires a non-empty reason before "protect" can be submitted; "unprotect"
 * needs no reason. Embedded in `MemberClaimsTable`'s `ProtectedCell` — the
 * seam that component's own header comment named for exactly this control.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';

export function TitleProtectionControl({ titleId, initialProtected, initialReason }: { titleId: string; initialProtected: boolean; initialReason: string | null }) {
  const router = useRouter();
  const [isProtected, setIsProtected] = useState(initialProtected);
  const [reasonShown, setReasonShown] = useState(initialReason);
  const [editing, setEditing] = useState(false);
  const [draftReason, setDraftReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  async function submitProtect() {
    if (draftReason.trim() === '') {
      setErrorText('a reason is required — it is shown to the member whose deletion it blocks');
      return;
    }
    setBusy(true);
    setErrorText(null);
    try {
      const res = await fetch('/api/admin/titles/protect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ titleId, reason: draftReason.trim() }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErrorText(json.error ?? `failed (${res.status})`);
        return;
      }
      setIsProtected(true);
      setReasonShown(json.reason);
      setEditing(false);
      setDraftReason('');
      router.refresh();
    } catch {
      setErrorText('request failed — network error');
    } finally {
      setBusy(false);
    }
  }

  async function submitUnprotect() {
    setBusy(true);
    setErrorText(null);
    try {
      const res = await fetch('/api/admin/titles/unprotect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ titleId }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErrorText(json.error ?? `failed (${res.status})`);
        return;
      }
      setIsProtected(false);
      setReasonShown(null);
      router.refresh();
    } catch {
      setErrorText('request failed — network error');
    } finally {
      setBusy(false);
    }
  }

  if (isProtected) {
    return (
      <span style={{ display: 'inline-flex', flexDirection: 'column', gap: '0.25rem' }}>
        <span title={reasonShown ?? undefined}>protected{reasonShown ? ` (${reasonShown})` : ''}</span>
        <Button type="button" variant="plain" onClick={submitUnprotect} disabled={busy}>
          unprotect
        </Button>
        {errorText && <span style={{ fontSize: '0.75rem' }}>⚠ {errorText}</span>}
      </span>
    );
  }

  if (!editing) {
    return (
      <Button type="button" variant="plain" onClick={() => setEditing(true)}>
        protect
      </Button>
    );
  }

  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: '0.25rem', minWidth: '12rem' }}>
      <Textarea
        value={draftReason}
        onChange={(e) => setDraftReason(e.target.value)}
        placeholder="reason shown to the member"
        aria-label={`protection reason for ${titleId}`}
      />
      <span style={{ display: 'flex', gap: '0.5rem' }}>
        <Button type="button" onClick={submitProtect} disabled={busy}>
          confirm
        </Button>
        <Button
          type="button"
          onClick={() => {
            setEditing(false);
            setDraftReason('');
            setErrorText(null);
          }}
          disabled={busy}
        >
          cancel
        </Button>
      </span>
      {errorText && <span style={{ fontSize: '0.75rem' }}>⚠ {errorText}</span>}
    </span>
  );
}
