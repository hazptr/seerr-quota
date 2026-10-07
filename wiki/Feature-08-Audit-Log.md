# Feature 8 — Audit Log

## Summary

Every state change in this system is attributable, forever: who did it, what
changed, what it was before, what it became, whether it worked, and what the
upstream API said. Including — especially — the actions that were **denied**.

This app can permanently delete media on a production host with no rollback
button. The audit log is what makes that acceptable.

## User stories

- As the **operator**, I want to answer "who deleted that, and when" months
  later, with certainty.
- As the **operator**, I want to know if anyone has been probing at things they
  don't have access to.
- As the **operator**, I want the log to survive the app being wrong, the DB
  being corrupted, or a bad deploy.
- As a **member**, I want to see my own history, so I can check what I did.

## Guarantees

1. **Append-only.** The application issues no `UPDATE` or `DELETE` against
   `audit`, ever. There is no retention job and no purge endpoint. At this
   scale — single-digit members, tens of actions a day — the table stays small
   indefinitely, and "we pruned it" is never an acceptable answer to a
   forensic question.
2. **Denials are logged.** A 403, a failed webhook secret, a rate-limit
   rejection, an IDOR attempt — all produce rows with `outcome = denied`. A log
   that only records successes cannot answer "did anyone try?".
3. **Written twice.** Every row is also emitted to stdout as a single JSON
   object, so `docker logs seerr-quota` is an independent copy. If the DB write
   is what failed, the event still exists.
4. **Backed up.** The SQLite file lives wherever you bind-mount `DB_PATH`
   (see [[Configuration]]), with a `sqlite3 .backup` pre-step recommended
   before whatever captures it (see [[Deployment]]) so the captured copy is
   consistent rather than a mid-write datadir.
5. **Correlated.** Multi-step operations share a `correlation_id`, so a batch
   delete reads as one story rather than fourteen unrelated rows.
6. **Explaining, not just recording.** A decision row snapshots the *inputs*
   (usage, quota) as well as the outcome, so a verdict from three months ago is
   still explainable after the numbers have moved.

## Action vocabulary

| Action | Actor | Target | Records |
|---|---|---|---|
| `member.created` | system | member | Initial classification, default quota |
| `member.sync_changed` | system | member | Old → new `sync_status` |
| `member.entitlement_changed` | system | member | Gained/lost `jellyseerr` binding |
| `quota.set` | operator | member | Before/after bytes, source, note |
| `quota.cleared` | operator | member | Before bytes → inherit default |
| `setting.changed` | operator | setting | Key, before/after |
| `enforcement.toggled` | operator | setting | on/off |
| `request.approved` | system \| operator | request | Usage, quota, reason, Seerr status |
| `request.held` | system | request | Usage, quota, shortfall — the normal over-quota outcome (`D-4a`). No Seerr call is made |
| `request.declined` | operator \| system | request | Usage, quota, reason, Seerr status. Operator action, or the `HOLD_MAX_DAYS` age-out |
| `request.notified` | system | request | Which member notification was sent, and why (`FR-ENF-13`…`15`) |
| `request.skipped` | system | request | Skip reason (`stale_snapshot`, `unknown_member`, …) |
| `claim.released` | member \| operator | title | Bytes released, remaining claimants (`D-3`: no re-split — other claimants are unaffected) |
| `claim.reassigned` | operator | title | From → to |
| `title.protected` / `.unprotected` | operator | title | Reason |
| `delete.requested` | member \| operator | title | Mode, bytes, selection context |
| `delete.scheduled` | member \| operator | title | Deletion row id, `scheduled_for`, grace period, bytes — the member confirmed, nothing is destroyed yet (`FR-DEL-22`) |
| `delete.cancelled` | member \| operator \| system | title | Deletion row id, bytes restored, owner. `system` when an execution-time guard called it off rather than a person (`FR-DEL-26`) |
| `delete.executed` | member \| operator | title | Exact call, status, bytes freed. Actor is the member who **scheduled** it, not the sweeper that ran it (`D-11`) |
| `delete.failed` | member \| operator | title | Exact call, status, error |
| `delete.blocked` | member | title | Which guard fired |
| `access.denied` | member | `route` (or the domain type, when the attempt named one) | What was attempted — the route, and the object id if the member supplied one |
| `webhook.rejected` | system | — | Bad/missing secret |
| `sync.failed` | system | — | Which step, error |
| `invariant.violated` | system | title | Attribution sum mismatch (`FR-ACCT-3`) |

## Functional requirements

- **FR-AUD-1** — Every action in the vocabulary above MUST write exactly one
  audit row. An operation with no audit row is a bug, and the review checklist
  for any PR touching state MUST check for it.
- **FR-AUD-2** — Rows MUST be append-only. The codebase MUST contain no
  `UPDATE audit` or `DELETE FROM audit`, and this MUST be asserted by a test
  that greps the built output, not merely by convention.
- **FR-AUD-3** — Every row MUST record `ts`, `actor`, `actor_role`, `action`,
  `outcome`, and `source`. Rows for a targeted action MUST record
  `target_type` + `target_id`. State changes MUST record `before` and `after`.
- **FR-AUD-4** — Denied actions MUST be logged with `outcome = denied` and
  enough detail to identify what was attempted.
- **FR-AUD-5** — Multi-step operations MUST share a `correlation_id`.
- **FR-AUD-6** — Every row MUST also be written to stdout as one line of JSON.
- **FR-AUD-7** — Audit writes MUST NOT be able to fail silently. If the DB write
  throws, the failure MUST be logged at error level and MUST be visible in the
  admin dashboard's attention panel.
- **FR-AUD-8** — For a **local** state change, the audit row MUST be written in
  the same transaction as the change, so the two cannot diverge. For a **remote**
  effect (Seerr, Radarr, Sonarr), an intent row MUST be written before the call
  and an outcome row after, both sharing a `correlation_id` — so a crash
  mid-call leaves evidence that the call may have happened.
- **FR-AUD-9** — The operator MUST be able to browse the log with filters on
  actor, action, target, outcome, and time range, and MUST be able to export a
  filtered set as CSV and JSONL.
- **FR-AUD-10** — A member MUST be able to see their own audit history, and MUST
  NOT be able to see anyone else's.
- **FR-AUD-11** — Audit rows MUST NOT contain secrets: no API keys, no webhook
  secret, no `Authorization` header values. Upstream responses MUST be recorded
  with these redacted.
- **FR-AUD-12** — Timestamps MUST be stored as Unix milliseconds UTC and
  rendered in whatever `TZ` is configured (default UTC).

## Acceptance criteria

- **Given** a member deletes three titles, **when** the log is read, **then**
  there are three `delete.requested` and three `delete.executed` rows sharing one
  `correlation_id`, each naming the exact Radarr/Sonarr URL and status.
- **Given** a member attempts to delete a title they don't claim, **when**
  rejected, **then** an `access.denied` row exists naming them and the target.
- **Given** the operator changes `alice`'s quota from 500 GB to 300 GB, **when**
  the log is read, **then** one `quota.set` row shows both values, the actor, and
  the note.
- **Given** a request is declined, **when** the row is read six months later,
  **then** it still states the usage and quota that produced the verdict.
- **Given** the app is restarted mid-delete, **when** the log is read, **then**
  a `delete.requested` row exists with no matching outcome row, making the
  ambiguity visible rather than invisible.
- **Given** a webhook with a bad secret, **when** rejected, **then** a
  `webhook.rejected` row exists.
- **Given** any row, **when** inspected, **then** it contains no API key or secret.
- **Given** the container's stdout, **when** an action occurs, **then** a
  matching JSON line is present.

## Edge cases & failure modes

- **Log volume from the reconciler** — the 15-minute sync must not write a row
  per member per run. Only *changes* are audited (`FR-SYNC-9`); routine
  no-op syncs write a `sync_run` row, not audit rows.
- **Clock changes / DST** — UTC internally, always. The configured `TZ` is
  a render concern only.
- **A very large `before`/`after` blob** — cap serialized detail at a sane size
  and record a truncation marker rather than blowing up the row.
- **Restore from backup** — the log is the most valuable table in the DB; the
  `.backup` pre-step in [[Deployment]] is not optional.

## Open questions

- **Should the audit log be mirrored somewhere off-box** (e.g. an email or
  chat-notification digest of destructive actions)? Whatever notification
  channel you already use for the rest of your stack is a natural fit, kept
  operator-only. Proposal: a daily digest of deletions and any denied
  actions, plus an immediate message on `invariant.violated` or a
  partially-failed deletion. Low cost, high value — [[Backlog]] `P3-5`.
