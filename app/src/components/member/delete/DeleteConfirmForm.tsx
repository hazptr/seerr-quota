'use client';

/**
 * Step 3 — Confirm (`FR-DEL-5` step 3, `FR-DEL-8`'s result report). The
 * ONLY interactive/mutating piece of the whole delete flow: everything
 * above this component (Steps 1-2) is plain server-rendered HTML with real
 * `<form method="GET">` navigation, needing no JavaScript at all. This one
 * does, because `FR-DEL-5` requires all three of a typed `delete`, a ticked
 * checkbox, and a button disabled until both are satisfied — a dynamic
 * enable/disable that only client JS can do — and the actual mutation is a
 * `fetch` POST to `/api/deletion/execute` (`wiki`: "Mutations may require
 * JS; the read views must not" — Steps 1-2 are the read views, this is the
 * mutation).
 *
 * This component NEVER computes an authorization decision itself. `items`
 * is exactly what the confirm PAGE's own fresh `planDeletionItems` call
 * just showed (server-side, moments before this rendered) — the click
 * handler sends back precisely those `(titleId, mode)` pairs, unmodified,
 * and `scheduleDeletionBatch` re-validates everything again anyway
 * (`FR-DEL-1`/`FR-DEL-14`), as does the sweeper at execution time
 * (`FR-DEL-26`). This file's only jobs are: gate the button,
 * make the POST, and render whatever comes back — including a batch that
 * is only PARTLY successful, which `FR-DEL-8` forbids reporting as a plain
 * "done".
 */
import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Pane } from '@/components/ui/Pane';
import { formatGB } from '@/components/member/logic';
import {
  CONFIRM_TYPED_TEXT,
  RECOVERY_FINE_PRINT,
  RECOVERY_GAP_NOTE,
  buildExecuteRequestItems,
  computeConfirmRequirement,
  confirmAcknowledgementLabel,
  describeScheduleItemDetail,
  formatGraceWindow,
  isConfirmReady,
  isScheduleBatchFullySuccessful,
  scheduleOutcomeLabel,
  seriesWholeShowWarning,
  watchedWarning,
} from '@/components/member/deleteLogic';
import type { DeletionMode, ScheduleDeletionBatchResult } from '@/lib/deletion';

export interface ConfirmItem {
  titleId: string;
  name: string;
  path?: string;
  sizeBytes: number;
  chargedBytes: number;
  mode: 'delete' | 'release';
  watchedByAnyone: boolean;
  otherActiveClaimants: number;
  mediaType: 'movie' | 'tv' | null;
  episodesPlayed?: number | null;
  episodesTotal?: number | null;
}

function ConfirmItemRow({ item }: { item: ConfirmItem }) {
  const watched = watchedWarning(item);
  const wholeShow = seriesWholeShowWarning(item.mediaType ?? undefined);
  return (
    <div style={{ padding: '0.375rem 0', borderBottom: 'var(--sq-border-width) var(--sq-rule-style) var(--sq-rule)' }}>
      <span style={{ fontWeight: 600 }}>{item.mode === 'delete' ? 'delete' : 'release'}:</span> {item.name}{' '}
      <span style={{ color: 'var(--sq-muted)' }}>
        ({item.mode === 'delete' ? formatGB(item.sizeBytes) : `your ${formatGB(item.chargedBytes)} claim only`})
      </span>
      {watched && <div style={{ fontSize: '0.75rem' }}>⚠ {watched}</div>}
      {wholeShow && <div style={{ fontSize: '0.75rem' }}>⚠ {wholeShow}</div>}
    </div>
  );
}

export function DeleteConfirmForm({ items }: { items: ConfirmItem[] }) {
  const [typedText, setTypedText] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ScheduleDeletionBatchResult | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const requirement = computeConfirmRequirement(items);
  const ready = isConfirmReady(typedText, acknowledged, items.length);
  const nameById = new Map(items.map((i) => [i.titleId, i.name]));

  async function submit() {
    setSubmitting(true);
    setErrorText(null);
    try {
      const requestItems = items.map((i) => ({ titleId: i.titleId, requestedMode: (i.mode === 'delete' ? 'delete_files' : 'release_claim') as DeletionMode }));
      const res = await fetch('/api/deletion/execute', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: buildExecuteRequestItems(requestItems) }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErrorText(json.error ?? `request failed (${res.status})`);
        return;
      }
      setResult(json as ScheduleDeletionBatchResult);
    } catch {
      setErrorText('request failed — network error. Nothing was confirmed to have been scheduled; check your usage before retrying.');
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    const success = isScheduleBatchFullySuccessful(result.summary);
    const done = result.summary.scheduled + result.summary.released + result.summary.alreadyGone;
    return (
      <Pane title="delete — scheduled">
        <p style={{ margin: '0 0 0.75rem', fontWeight: 600 }}>
          {success
            ? `✓ all ${result.summary.total} done as requested`
            : `⚠ ${done} of ${result.summary.total} done — this batch was NOT a full success, see below`}
        </p>
        {result.summary.scheduled > 0 && (
          <p style={{ margin: '0 0 0.75rem', fontSize: '0.8125rem' }}>
            Nothing has been deleted yet. {result.summary.scheduled === 1 ? 'This deletion runs' : 'These deletions run'} in{' '}
            {formatGraceWindow(result.gracePeriodSeconds)}, and you can cancel {result.summary.scheduled === 1 ? 'it' : 'them'} from your usage page until then.
          </p>
        )}
        {result.items.map((item) => {
          const detail = describeScheduleItemDetail(item);
          return (
            <div key={item.titleId} style={{ padding: '0.375rem 0', borderBottom: 'var(--sq-border-width) var(--sq-rule-style) var(--sq-rule)' }}>
              <span style={{ fontWeight: 600 }}>{scheduleOutcomeLabel(item.outcome)}</span> — {nameById.get(item.titleId) ?? item.titleId}
              {typeof item.bytesClaimed === 'number' && item.bytesClaimed > 0 && item.outcome === 'scheduled' && <> ({formatGB(item.bytesClaimed)})</>}
              {detail && <div style={{ fontSize: '0.8125rem', color: 'var(--sq-muted)' }}>{detail}</div>}
            </div>
          );
        })}
        <hr className="sq-rule" />
        <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--sq-muted)' }}>
          Your quota already reflects the space these will free.{' '}
          <Link href="/" style={{ color: 'var(--sq-fg)' }}>
            back to my usage
          </Link>
        </p>
      </Pane>
    );
  }

  return (
    <Pane title="delete — step 3 of 3: confirm">
      {items.length === 0 ? (
        <p className="sq-empty" style={{ margin: 0 }}>
          nothing to confirm — go back and select at least one title
        </p>
      ) : (
        <>
          {items.map((item) => (
            <ConfirmItemRow key={item.titleId} item={item} />
          ))}
          <hr className="sq-rule" />
          <p style={{ margin: '0 0 0.75rem', fontSize: '0.8125rem' }}>{RECOVERY_FINE_PRINT}</p>
          <p style={{ margin: '0 0 1rem', fontSize: '0.75rem', color: 'var(--sq-muted)' }}>{RECOVERY_GAP_NOTE}</p>

          <label style={{ display: 'block', marginBottom: '0.5rem' }}>
            <span style={{ display: 'block', fontSize: '0.8125rem', marginBottom: '0.25rem' }}>
              Type <strong>{CONFIRM_TYPED_TEXT}</strong> to continue
            </span>
            <Input
              type="text"
              value={typedText}
              onChange={(e) => setTypedText(e.target.value)}
              placeholder={CONFIRM_TYPED_TEXT}
              aria-label={`type ${CONFIRM_TYPED_TEXT} to confirm`}
              autoComplete="off"
              style={{ width: '12rem' }}
            />
          </label>

          <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', margin: '0.75rem 0 1rem' }}>
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              style={{ marginTop: '0.1875rem', width: '1.125rem', height: '1.125rem' }}
            />
            <span>{confirmAcknowledgementLabel(requirement)}</span>
          </label>

          <Button type="button" variant="destructive" disabled={!ready || submitting} onClick={submit}>
            {submitting ? 'working…' : 'schedule deletion / release selected'}
          </Button>
          {errorText && <p style={{ margin: '0.5rem 0 0', fontSize: '0.8125rem' }}>⚠ {errorText}</p>}
        </>
      )}
    </Pane>
  );
}
