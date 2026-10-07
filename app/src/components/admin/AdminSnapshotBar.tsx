/**
 * `FR-ADM-13`: "Every screen MUST carry the snapshot timestamp and a clear
 * staleness indicator." This is the top-of-page instance (the layout mock in
 * `wiki/Feature-07-Admin-Dashboard.md` shows it in the title bar itself: "data
 * as of 14:32 · sync ok") — grounded in the ATTRIBUTION snapshot specifically,
 * since that's what the fleet totals and member table are computed from
 * (same convention `SnapshotNote` uses on the member page, P1-8). The
 * sync-status pane (`SyncStatusPane.tsx`) carries the SAME staleness
 * indicator per-pipeline, for the finer-grained "which step failed" question.
 *
 * Stale/degraded are text/glyph states PLUS colour (`--sq-warning`) —
 * colour is never the *sole* signal (`FR-UI-7`), but is no longer withheld
 * (FR-UI-5, revised 2026-08-25).
 */
import { computeFreshness, formatAge, formatTimestamp, severityColorVar } from '@/components/member/logic';

export function AdminSnapshotBar({
  attributionSnapshotAtSeconds,
  nowSeconds,
  staleAfterSeconds,
  allPipelinesOk,
  timeZone,
}: {
  attributionSnapshotAtSeconds: number;
  nowSeconds: number;
  staleAfterSeconds: number;
  allPipelinesOk: boolean;
  timeZone: string;
}) {
  const freshness = computeFreshness(attributionSnapshotAtSeconds, nowSeconds, staleAfterSeconds);
  return (
    <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--sq-muted)' }}>
      data as of {formatTimestamp(attributionSnapshotAtSeconds, timeZone)} ({formatAge(freshness.ageSeconds)})
      {freshness.stale && (
        <strong style={{ color: severityColorVar('warning'), marginLeft: '0.5rem' }}>
          ⚠ STALE — older than the {Math.round(staleAfterSeconds / 60)}m freshness window
        </strong>
      )}
      <span style={{ marginLeft: '0.75rem' }}>
        &middot; sync {allPipelinesOk ? 'ok' : <strong style={{ color: severityColorVar('warning') }}>⚠ degraded — see sync status below</strong>}
      </span>
    </p>
  );
}
