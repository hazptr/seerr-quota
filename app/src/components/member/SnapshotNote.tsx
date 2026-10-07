/**
 * `FR-ACCT-8`: "Every figure shown MUST carry the timestamp of the snapshot
 * it came from, and MUST be visibly marked stale when older than
 * STALE_SNAPSHOT_MAX_AGE." One instance sits at the top of every pane whose
 * figures come from the attribution snapshot (`QuotaPane`, `TitlesPane`) —
 * both panes render from the SAME snapshot, so repeating this note in each
 * makes the timestamp unmissable next to the numbers it describes. Stale is
 * a TEXT/glyph state PLUS `--sq-warning` colour — colour is never the
 * *sole* signal (`FR-UI-7`), but is no longer withheld (FR-UI-5, revised
 * 2026-08-25).
 */
import { computeFreshness, formatAge, formatTimestamp, severityColorVar } from './logic';

export function SnapshotNote({
  snapshotAtSeconds,
  nowSeconds,
  staleAfterSeconds,
  timeZone,
}: {
  snapshotAtSeconds: number;
  nowSeconds: number;
  staleAfterSeconds: number;
  timeZone: string;
}) {
  const freshness = computeFreshness(snapshotAtSeconds, nowSeconds, staleAfterSeconds);
  return (
    <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--sq-muted)' }}>
      snapshot: {formatTimestamp(snapshotAtSeconds, timeZone)} ({formatAge(freshness.ageSeconds)})
      {freshness.stale && (
        <strong style={{ color: severityColorVar('warning'), marginLeft: '0.5rem' }}>
          ⚠ STALE — older than the {Math.round(staleAfterSeconds / 60)}m freshness window
        </strong>
      )}
    </p>
  );
}
