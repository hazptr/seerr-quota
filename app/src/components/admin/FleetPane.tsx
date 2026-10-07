/**
 * `FR-ADM-2`: fleet totals — free space, total library size, total
 * attributed size, never-watched attributed size, and a runway estimate.
 * All computed over DISTINCT titles (`src/lib/attribution/compute.ts`'s
 * `computeFleetDistinctTitleTotal`/`computeNeverWatchedBytes` — see
 * `src/app/admin/_data/dashboard.ts`'s `computeFleetTotals`), never by
 * summing the member table's usage column (`FR-ACCT-3`).
 */
import { Pane } from '@/components/ui/Pane';
import { formatGB } from '@/components/member/logic';
import { formatRunway, type FleetTotals } from './logic';

const labelStyle = { color: 'var(--sq-muted)', margin: 0 } as const;
const valueStyle = { margin: 0, fontVariantNumeric: 'tabular-nums' as const };

export function FleetPane({ fleet, distinctTitleCount }: { fleet: FleetTotals; distinctTitleCount: number }) {
  return (
    <Pane title="library">
      <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', rowGap: '0.5rem', columnGap: '1rem' }}>
        <dt style={labelStyle}>free space</dt>
        <dd style={valueStyle}>
          {fleet.freeBytes !== null ? (
            formatGB(fleet.freeBytes)
          ) : (
            <span className="sq-empty">unavailable{fleet.freeBytesError ? ` (${fleet.freeBytesError})` : ''}</span>
          )}
        </dd>

        <dt style={labelStyle}>total library</dt>
        <dd style={valueStyle}>{formatGB(fleet.totalLibraryBytes)}</dd>

        <dt style={labelStyle}>attributed</dt>
        <dd style={valueStyle}>
          {formatGB(fleet.totalAttributedBytes)} over {distinctTitleCount} distinct titles, {fleet.attributedMemberCount} members
        </dd>

        <dt style={labelStyle}>never watched</dt>
        <dd style={valueStyle}>
          {formatGB(fleet.neverWatchedAttributedBytes)}
          {fleet.totalAttributedBytes > 0 && (
            <span style={{ color: 'var(--sq-muted)' }}> ({((fleet.neverWatchedAttributedBytes / fleet.totalAttributedBytes) * 100).toFixed(0)}% of attributed) — reclaimable</span>
          )}
        </dd>

        <dt style={labelStyle}>runway</dt>
        <dd style={valueStyle}>
          {formatRunway(fleet.runwayDays)}
          <span style={{ color: 'var(--sq-muted)' }}> (from the last 30d of growth, {formatGB(Math.max(0, fleet.growthBytesPerDay))}/day)</span>
        </dd>
      </dl>
    </Pane>
  );
}
