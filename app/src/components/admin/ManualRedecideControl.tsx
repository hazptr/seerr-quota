'use client';

/**
 * `FR-ADM-8`/`FR-ENF-11` — manually re-evaluate one pending-or-held request
 * right now. Calls `POST /api/admin/requests/decide`, which goes through
 * `processPendingRequest(id, 'manual', deps)` — see that route's header
 * comment for why this is "re-decide now" rather than a raw forced
 * approve/decline. Shown only for `hold`/`skip` rows (`MemberDecisionsTable`)
 * — a request already `approve`d/`decline`d in Seerr is terminal; re-running
 * it would just report `not_pending`.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';

type DecideOutcome =
  | { kind: 'not_pending'; seerrRequestId: number }
  | { kind: 'decided'; seerrRequestId: number; decision: string; reason: string }
  | { kind: 'error'; seerrRequestId: number; error: string };

function describeOutcome(outcome: DecideOutcome): string {
  if (outcome.kind === 'not_pending') return 'already resolved elsewhere — nothing to decide';
  if (outcome.kind === 'error') return `error: ${outcome.error}`;
  return `→ ${outcome.decision} (${outcome.reason.replace(/_/g, ' ')})`;
}

export function ManualRedecideControl({ seerrRequestId }: { seerrRequestId: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [resultText, setResultText] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setResultText(null);
    try {
      const res = await fetch('/api/admin/requests/decide', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seerrRequestId }),
      });
      const json = await res.json();
      if (!res.ok) {
        setResultText(`error: ${json.error ?? res.status}`);
        return;
      }
      setResultText(describeOutcome(json.outcome as DecideOutcome));
      router.refresh();
    } catch {
      setResultText('request failed — network error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
      <Button type="button" variant="plain" onClick={run} disabled={busy} style={{ fontSize: '0.8125rem' }}>
        re-decide now
      </Button>
      {resultText && <span style={{ fontSize: '0.75rem', color: 'var(--sq-muted)' }}>{resultText}</span>}
    </span>
  );
}
