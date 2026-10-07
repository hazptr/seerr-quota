'use client';

/**
 * `FR-ADM-10`'s trigger half — the control P1-9 deliberately left for this
 * task ("`SyncStatusPane` is the seam for the reconcile trigger"). Posts to
 * `POST /api/admin/reconcile`, then refreshes the page so the (already-built)
 * table below reflects the fresh `sync_run` rows — that table remains the
 * authoritative per-step result view; this button's own summary is just
 * immediate feedback that the run happened.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';

interface ReconcileStepOutcome {
  step: string;
  ok: boolean;
  error?: string;
}

export function ReconcileTrigger() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [resultText, setResultText] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setResultText(null);
    try {
      const res = await fetch('/api/admin/reconcile', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        setResultText(`error: ${json.error ?? res.status}`);
        return;
      }
      const steps = (json.steps ?? []) as ReconcileStepOutcome[];
      const failed = steps.filter((s) => !s.ok);
      setResultText(failed.length === 0 ? 'reconcile complete — see the table below for per-step detail' : `reconcile finished with ${failed.length} error(s): ${failed.map((s) => s.step).join(', ')}`);
      router.refresh();
    } catch {
      setResultText('request failed — network error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
      <Button type="button" onClick={run} disabled={busy}>
        {busy ? 'reconciling…' : 'reconcile now'}
      </Button>
      {resultText && <span style={{ fontSize: '0.8125rem', color: 'var(--sq-muted)' }}>{resultText}</span>}
    </div>
  );
}
