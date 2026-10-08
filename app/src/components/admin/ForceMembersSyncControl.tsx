'use client';

/**
 * Second security review (PR #17), SHOULD-FIX 2: shown ONLY when
 * `wasMembersSyncRefusedByMassRevocationGuard` (`@/components/admin/logic`)
 * says the last members-sync cycle was refused by `checkMassRevocationRisk`
 * (`src/lib/members/classify.ts`) — an empty or suspiciously-small Seerr
 * user list. Posts to `POST /api/admin/reconcile/force-members-sync`, which
 * applies that exact cycle anyway, audited as `sync.forced`. A plain
 * confirm (not the three-step delete ceremony — this is a data-sync
 * decision, not a file deletion) since the whole point is that an operator
 * has already looked at the refusal and decided it's correct-but-unwanted.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';

export function ForceMembersSyncControl() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [resultText, setResultText] = useState<string | null>(null);

  async function run() {
    if (
      !window.confirm(
        'The last roster sync was refused because it looked like a mass revocation (an empty or suspiciously small Seerr user list). Apply it anyway, for this cycle only?',
      )
    ) {
      return;
    }
    setBusy(true);
    setResultText(null);
    try {
      const res = await fetch('/api/admin/reconcile/force-members-sync', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        setResultText(`error: ${json.error ?? res.status}`);
        return;
      }
      setResultText(json.ok ? 'applied — see the table below for per-member detail' : `still failed: ${json.classify?.error ?? 'unknown error'}`);
      router.refresh();
    } catch {
      setResultText('request failed — network error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem', margin: '0.5rem 0' }}>
      <span style={{ color: 'var(--sq-critical)', fontSize: '0.8125rem' }}>
        ⚠ the last roster sync was refused as a possible mass revocation
      </span>
      <Button type="button" variant="destructive" onClick={run} disabled={busy}>
        {busy ? 'applying…' : 'apply roster sync anyway'}
      </Button>
      {resultText && <span style={{ fontSize: '0.8125rem', color: 'var(--sq-muted)' }}>{resultText}</span>}
    </div>
  );
}
