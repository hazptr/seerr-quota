'use client';

/**
 * The undo surface (`FR-DEL-24`). Every deletion this member has scheduled
 * and not yet had executed, each with a Cancel button.
 *
 * This is the component that makes the grace period real. A pending deletion
 * nobody can find is the same as an immediate one, so this pane renders
 * ABOVE the usage figures on the member dashboard whenever it has rows, and
 * says plainly that the space has already been credited — otherwise a member
 * reads their reduced usage, assumes the files are gone, and never realises
 * they still have a window.
 *
 * It is a client component only because cancelling is a POST with an inline
 * result. The list itself is server-rendered data passed in as props; no
 * authorization decision is made here, and the ids sent to
 * `/api/deletion/cancel` are re-checked against the row's real owner
 * server-side (`cancel.ts`) — a tampered id gets the same `not_found` as a
 * nonexistent one.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Pane } from '@/components/ui/Pane';
import { formatGB, formatTimestamp } from '@/components/member/logic';
import { describeCancelRefusal, formatTimeRemaining } from '@/components/member/deleteLogic';
import type { CancelResult } from '@/lib/deletion';

export interface PendingDeletionRow {
  deletionId: number;
  titleId: string;
  name: string;
  bytesClaimed: number;
  scheduledFor: number;
  /** Set only on the admin view, where rows from several members are shown together. */
  owner?: string;
}

export function PendingDeletionsPane({
  rows,
  nowSeconds,
  timeZone,
  title = 'pending deletions — you can still cancel these',
  showOwner = false,
}: {
  rows: PendingDeletionRow[];
  nowSeconds: number;
  timeZone: string;
  title?: string;
  showOwner?: boolean;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Record<number, string>>({});

  if (rows.length === 0) return null;

  async function cancel(deletionId: number) {
    setBusyId(deletionId);
    setMessages((m) => ({ ...m, [deletionId]: '' }));
    try {
      const res = await fetch('/api/deletion/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deletionId }),
      });
      const json = (await res.json()) as CancelResult & { error?: string };
      if (json.outcome === 'cancelled') {
        // Re-render the server component so the row disappears and the usage
        // figures above it move back — rather than mutating local state and
        // letting the two disagree.
        router.refresh();
        return;
      }
      if (json.outcome === 'would_exceed_quota') {
        setMessages((m) => ({ ...m, [deletionId]: describeCancelRefusal(json.overageBytes ?? 0) }));
        return;
      }
      if (json.outcome === 'already_executing') {
        setMessages((m) => ({ ...m, [deletionId]: 'Too late — this one is already running.' }));
        return;
      }
      setMessages((m) => ({ ...m, [deletionId]: 'That deletion is no longer pending.' }));
      router.refresh();
    } catch {
      setMessages((m) => ({ ...m, [deletionId]: 'Network error — nothing was cancelled. Try again.' }));
    } finally {
      setBusyId(null);
    }
  }

  const totalBytes = rows.reduce((sum, r) => sum + r.bytesClaimed, 0);

  return (
    <Pane title={title}>
      <p style={{ margin: '0 0 0.75rem', fontSize: '0.8125rem' }}>
        {rows.length} {rows.length === 1 ? 'deletion is' : 'deletions are'} scheduled but{' '}
        <strong>{rows.length === 1 ? 'has' : 'have'} not run yet</strong> — {formatGB(totalBytes)} in total. That space is already
        counted as free in the quota figures below.
      </p>
      {rows.map((row) => (
        <div key={row.deletionId} style={{ padding: '0.5rem 0', borderBottom: 'var(--sq-border-width) var(--sq-rule-style) var(--sq-rule)' }}>
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600 }}>{row.name}</span>
            {showOwner && row.owner && <span style={{ color: 'var(--sq-muted)' }}>({row.owner})</span>}
            <span style={{ color: 'var(--sq-muted)' }}>{formatGB(row.bytesClaimed)}</span>
            <span style={{ color: 'var(--sq-muted)', fontSize: '0.8125rem' }}>
              runs {formatTimestamp(row.scheduledFor, timeZone)} — {formatTimeRemaining(row.scheduledFor, nowSeconds)}
            </span>
            <Button type="button" onClick={() => void cancel(row.deletionId)} disabled={busyId === row.deletionId}>
              {busyId === row.deletionId ? 'cancelling…' : 'cancel'}
            </Button>
          </div>
          {messages[row.deletionId] && (
            <div style={{ fontSize: '0.8125rem', color: 'var(--sq-muted)', marginTop: '0.25rem' }}>⚠ {messages[row.deletionId]}</div>
          )}
        </div>
      ))}
    </Pane>
  );
}
