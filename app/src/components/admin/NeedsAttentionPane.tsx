/**
 * `FR-ADM-4` — "the most important screen in the app." Surfaces, each in its
 * own clearly-labelled section (never collapsed into one count):
 *   - skipped enforcement decisions, grouped by their SPECIFIC reason
 *     (`stale_snapshot` / `unknown_member` / `member_not_matched` /
 *     `quota_unconfigured` / `usage_unavailable`) — the operator's response
 *     to each is different, so these are never merged.
 *   - account-sync drift (`no_seerr_account` / `not_entitled` / `ambiguous`).
 *   - unresolved requests / unmatched requesters, read from `sync_run.steps`
 *     (`src/lib/attribution/sync.ts` persists both counts onto the
 *     `attribution` step, `FR-ACCT-4`) — the "not recorded" fallback below
 *     still applies to a `sync_run` row written before that was added, or to
 *     a cycle where the step didn't run at all (skipped/failed).
 *   - attribution invariant violations (`FR-ACCT-3`), since the latest
 *     attribution run.
 *
 * "Failed or partially failed deletions" (also named in `FR-ADM-4`'s prose)
 * is deliberately NOT built here — deletion (`P2-4`) doesn't exist yet, so
 * `deletion` is always empty; the project's design explicitly scoped the panel
 * to the five items above. Flagged in the project notes.
 */
import Link from 'next/link';
import { Pane } from '@/components/ui/Pane';
import { formatGB, severityColorVar } from '@/components/member/logic';
import { SKIP_REASON_LABELS, type NeedsAttentionData } from './logic';

const sectionStyle = { margin: '0 0 0.75rem' } as const;
const itemStyle = { margin: '0.25rem 0' } as const;
/** The "!" marker on every attention row — colour ADDITIONAL to the glyph and label already there (`FR-UI-7`), not a replacement for either. */
function Bang() {
  return <span style={{ color: severityColorVar('warning') }}>!</span>;
}

export function NeedsAttentionPane({ attention }: { attention: NeedsAttentionData }) {
  const nothingToShow =
    attention.skipped.length === 0 &&
    attention.syncDrift.length === 0 &&
    attention.invariantViolations.length === 0 &&
    !attention.unresolvedAttribution.available;

  return (
    <Pane title="needs attention">
      {nothingToShow ? (
        <p className="sq-empty" style={{ margin: 0 }}>
          nothing needs attention right now
        </p>
      ) : (
        <>
          {attention.skipped.length > 0 && (
            <div style={sectionStyle}>
              <p style={{ ...itemStyle, fontWeight: 600 }}>skipped enforcement decisions</p>
              {attention.skipped.map((group) => (
                <p key={group.reason} style={itemStyle}>
                  <Bang /> {group.count} request{group.count === 1 ? '' : 's'} skipped ({SKIP_REASON_LABELS[group.reason]}) —{' '}
                  {group.sample.map((s, i) => (
                    <span key={s.seerrRequestId}>
                      {i > 0 && ', '}
                      <Link href={`/admin/members/${encodeURIComponent(s.ssoUsername)}`}>#{s.seerrRequestId}</Link>
                    </span>
                  ))}
                  {group.count > group.sample.length && ` (+${group.count - group.sample.length} more)`}
                </p>
              ))}
            </div>
          )}

          {attention.syncDrift.length > 0 && (
            <div style={sectionStyle}>
              <p style={{ ...itemStyle, fontWeight: 600 }}>account-sync drift</p>
              {attention.syncDrift.map((m) => (
                <p key={m.ssoUsername} style={itemStyle}>
                  <Bang /> <Link href={`/admin/members/${encodeURIComponent(m.ssoUsername)}`}>{m.displayName || m.ssoUsername}</Link>:{' '}
                  {
                    // `syncStatus === 'not_entitled'` already says "not
                    // entitled" — prefixing "not entitled, not entitled" would
                    // be redundant, so only the entitled branch (where the two
                    // facts genuinely differ, e.g. "entitled, no seerr
                    // account") states the entitlement separately.
                    m.syncStatus === 'not_entitled' ? 'not entitled' : `${m.entitled ? 'entitled' : 'not entitled'}, ${m.syncStatus.replace(/_/g, ' ')}`
                  }
                  {m.syncNote ? ` — ${m.syncNote}` : ''}
                </p>
              ))}
            </div>
          )}

          <div style={sectionStyle}>
            <p style={{ ...itemStyle, fontWeight: 600 }}>unresolved requests / unmatched requesters</p>
            {attention.unresolvedAttribution.available ? (
              <p style={itemStyle}>
                <Bang /> {attention.unresolvedAttribution.unresolvedCount ?? 0} unresolved request(s), {attention.unresolvedAttribution.unmatchedRequesterCount ?? 0}{' '}
                unmatched requester(s) in the last attribution run
              </p>
            ) : (
              <p className="sq-empty" style={itemStyle}>
                not recorded in the last sync run (attribution hasn&apos;t run since this was added, or that cycle was skipped/failed — see console warnings from the reconciler)
              </p>
            )}
          </div>

          {attention.invariantViolations.length > 0 && (
            <div style={sectionStyle}>
              <p style={{ ...itemStyle, fontWeight: 600 }}>attribution invariant violations</p>
              {attention.invariantViolations.map((v, i) => (
                // eslint-disable-next-line react/no-array-index-key -- no natural unique key exists across (titleId, ssoUsername) pairs recorded at different timestamps
                <p key={`${v.titleId}-${v.ssoUsername}-${i}`} style={itemStyle}>
                  <Bang /> {v.titleId} charged {formatGB(v.chargedBytes)} to {v.ssoUsername}, expected {formatGB(v.expectedBytes)}
                </p>
              ))}
            </div>
          )}
        </>
      )}
    </Pane>
  );
}
