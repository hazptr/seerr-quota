'use client';

/**
 * Security review (PR #17): the operator-facing undo for a member's
 * `login_alias`. Rendered only when a member actually has one set
 * (`MemberDetailHeader`). One click + a plain confirm — this is an undo of
 * a trust decision, not a destructive action over media, so AGENTS.md
 * rule 3's three-step ceremony does not apply here (same reasoning as
 * `TitleProtectionControl`'s unprotect half).
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';

export function ClearAliasControl({ ssoUsername, currentAlias }: { ssoUsername: string; currentAlias: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  async function submit() {
    if (!window.confirm(`Clear login alias "${currentAlias}" from ${ssoUsername}? A future email-fallback login may re-link a (possibly different) alias.`)) {
      return;
    }
    setBusy(true);
    setErrorText(null);
    try {
      const res = await fetch('/api/admin/members/clear-alias', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ssoUsername }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setErrorText(json.error ?? `failed (${res.status})`);
        return;
      }
      router.refresh();
    } catch {
      setErrorText('request failed — network error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ marginLeft: '0.5rem' }}>
      <Button type="button" onClick={submit} disabled={busy} variant="destructive">
        clear alias
      </Button>
      {errorText && <span style={{ color: 'var(--sq-critical)', marginLeft: '0.5rem' }}>{errorText}</span>}
    </span>
  );
}
