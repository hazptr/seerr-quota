# Feature 7 — Admin Dashboard

## Summary

The operator's single screen for the whole system: who's using what, who's over,
who's about to be, where the library is going, what needs attention, and every
control — quotas, protection, manual approve/decline, account sync, audit.

## User stories

- As the **operator**, I want one page that answers "is this working and does
  anyone need me", so I don't have to remember to check five things.
- As the **operator**, I want to change a quota, protect a title, or approve a
  stuck request without leaving that page or touching a config file.
- As the **operator**, I want to see the disk trend, so I know whether the
  quotas are actually bending the growth curve.

## Layout

```
┌─ $ seerr-quota ──────────────────────── data as of 14:32 · sync ok ─┐
│                                                                     │
│  LIBRARY          1.80 TB free  ·  3.00 TB library  ·  ~12mo runway │
│  ATTRIBUTED       900 GB over 40 distinct titles, 4 members          │
│  NEVER WATCHED    180 GB  (20% of attributed)     ← reclaimable      │
│                                                                     │
├─ NEEDS ATTENTION ───────────────────────────────────────────────────┤
│  ! 3 requests skipped (stale snapshot) — [review]                   │
│  ! dave, erin: entitled, no Seerr account — [review]                │
│  ! 1 deletion partially failed — [review]                           │
├─ MEMBERS ─────────────────────── usage overlaps; do not sum ────────┤
│  member    usage     quota    used   unwatched  titles  state        │
│  alice     450 GB    500 GB   90%    ...       ...     ok           │
│  operator  250 GB   unlimited  —     ...       ...     operator    │
│  bob       300 GB    400 GB   75%    ...       ...     ok           │
│  carol     100 GB   unlimited  —     0 GB      ...     exempt       │
│  dave       —       200 GB    —      —         —      no acct      │
├─ TRENDS ────────────────────────────────────────────────────────────┤
│  library growth by month · attributed growth by member               │
└─────────────────────────────────────────────────────────────────────┘
```

Figures above are illustrative, not measured — the shape to notice is that
the member column can sum to *more* than ATTRIBUTED: that gap is exactly the
co-requested titles charged in full to more than one member, and is exactly
why `FR-ADM-2`/`FR-ADM-3` forbid summing the column.

## Functional requirements

- **FR-ADM-1** — Every route and API in this feature MUST be operator-only,
  authorized server-side per request (`FR-SSO-5`), returning a genuine **403** —
  not a 200 whose body says "forbidden".

  > **Next dependency worth knowing at upgrade time.** A Server Component page
  > cannot set an HTTP status without `forbidden()`/`unauthorized()` from
  > `next/navigation`, which are gated behind `experimental.authInterrupts` in
  > `next.config.mjs`. **The authorization does not depend on that flag** —
  > `requireOperator` throws either way and no member-visible data is ever
  > rendered; only the status code does. So the failure mode of a future Next
  > release dropping or renaming the flag is a build error or a degraded status
  > code, never silent access. Check this when bumping Next.
- **FR-ADM-2** — The dashboard MUST show fleet totals: free space on
  `/mnt/media`, total library size, total attributed size, total
  never-watched attributed size, and a runway estimate from recent growth.
  Fleet totals MUST be computed over **distinct titles**, never by summing the
  per-member column, which overlaps under `D-3` (`FR-ACCT-3`).
  **Byte totals include every title on disk regardless of who requested it** —
  including titles attributed to `not_entitled` accounts like a Seerr-internal
  service account — because
  they reflect real disk usage. It is the *per-member table* that excludes
  non-entitled accounts, not the fleet byte total.
- **FR-ADM-3** — The member table MUST show, per member: usage, effective quota
  and its source (default/override/unlimited), percentage used, never-watched
  bytes, title count, and state (`ok` / `over` / `would be over` when
  enforcement is off / `operator` / `exempt` / `no acct` / `ambiguous`).
  `operator` and `exempt` are distinct and checked in that order: the operator
  is exempt *because they are the operator* (`FR-ENF-6`), whereas `exempt` means
  a member whose quota is explicitly `0` = unlimited. The usage column MUST
  be visibly labelled as overlapping — co-requested titles are charged in full to
  each claimant under `D-3` — and the table MUST NOT display a naive column sum.
- **FR-ADM-4** — A **needs attention** panel MUST surface, at minimum: skipped
  enforcement decisions and why, account-sync drift, failed or partially failed
  deletions, unresolved requests and unmatched requesters (`FR-ACCT-4`, read
  from `sync_run.steps`), stale upstream data, and any attribution invariant
  violation (`FR-ACCT-3`).
- **FR-ADM-5** — The operator MUST be able to drill into any member and see
  their full title list, claims, decisions, and audit history.
- **FR-ADM-6** — The operator MUST be able to set a member's quota override
  and clear it, with the preview and confirmations from
  [[Feature-04-Quota-Policy]].
- **FR-ADM-7** — The operator MUST be able to mark any title `protected`
  (with a reason) and unprotect it. Both are audited.
- **FR-ADM-8** — The operator MUST be able to manually approve or decline any
  pending request, and to re-run a decision (`FR-ENF-11`).
- **FR-ADM-9** *(Removed in 0.2.0)* — surfaced a mismatch between Authentik's
  `jellyseerr` entitlement and this app's own Authentik application
  entitlement. Removed along with the Authentik integration: the member
  roster is Seerr's own user list now (`wiki/Feature-02-Account-Sync.md`),
  so there is no second entitlement list left to drift from.
- **FR-ADM-10** — The operator MUST be able to trigger an immediate reconcile
  and see per-step results from the last `sync_run`.
- **FR-ADM-10a** *(second security review, PR #17, SHOULD-FIX 2)* — When the
  last `members` sync cycle was refused by `checkMassRevocationRisk`
  (`src/lib/members/classify.ts`, `wiki/Feature-02-Account-Sync.md`'s
  extended `FR-SYNC-10`), the dashboard MUST show a one-shot "apply roster
  sync anyway" control (`ForceMembersSyncControl`,
  `POST /api/admin/reconcile/force-members-sync`) — operator-only, audited
  as `sync.forced`. It overrides the flip thresholds for that one call only — an empty Seerr list, a failed fetch, or a partial read is still refused. Hidden on every ordinary cycle; this guard has no
  other escape hatch, since a refused cycle otherwise stays refused on
  every scheduled run until an operator intervenes.
- **FR-ADM-11** — The operator MUST be able to toggle `enforcement_enabled` and
  edit every `app_setting`, each audited.
- **FR-ADM-12** — Trend views MUST show library growth by month (as
  a reference disk-usage computation does it, by Radarr/Sonarr `added` date) and
  attributed growth per member over time.
- **FR-ADM-13** — Every screen MUST carry the snapshot timestamp and a clear
  staleness indicator (`FR-ACCT-8`). A dashboard silently showing hours-old
  numbers as current is worse than one that's honestly empty.
- **FR-ADM-14** — The operator MUST be able to act on another member's titles
  (delete/release/reassign a claim), through the same three-step flow, with the
  audit row recording `on_behalf_of`.
- **FR-ADM-15** — The dashboard MUST NOT expose any API key, token, or secret,
  including in error messages and debug output.

## Interactions

Reads its own SQLite for everything except free space, which comes from a
`statvfs` on the bind-mounted path (the container needs a read-only mount of
`/mnt/media` for this, or the value can be fetched from Glances, which is
already deployed — the former is simpler and has no new dependency).

Trend data comes from `title.added_at` + `size_bytes`, matching the existing
monthly-growth computation so the dashboard and the scripts agree.

## Acceptance criteria

- **Given** a member logs in, **when** they request any admin route, **then**
  403 and an audit row.
- **Given** three requests were skipped for staleness, **when** the operator
  opens the dashboard, **then** the attention panel names them with the reason
  and links to each.
- **Given** the operator changes a quota, **when** the change commits, **then**
  the member table reflects it immediately and an audit row records before/after.
- **Given** a title is protected, **when** its claimant opens their list,
  **then** the row shows as blocked with the operator's reason.
- **Given** the last reconcile failed on the Jellyfin step, **when** the
  dashboard renders, **then** watched/unwatched columns are marked stale and the
  attention panel says which step failed.
- **Given** `enforcement_enabled = false`, **when** the member table renders,
  **then** over-quota members show "would be over", not "OVER".

## Edge cases & failure modes

- **Empty state, first boot** — no reconcile has run yet. Show "no data yet,
  first sync in progress", never zeros that look like real measurements.
- **A member with no Seerr account** — usage column is `—`, not `0`. The
  distinction matters: one means "linked and using nothing", the other means
  "not linked".
- **Very large title lists** — paginate server-side; a member drill-down must
  not load 500 rows into the browser.
- **Two operators** — not a case today (only `admin`), but `actor` is
  recorded on every action so it doesn't need special handling if it changes.

## Open questions

- **Should there be a read-only "fleet" view for members** (e.g. see everyone's
  usage, to create social pressure)? Proposal: **no** in v1. Members see only
  themselves. Publishing per-person usage among friends is a social decision,
  not a technical one, and it's easy to add later and impossible to un-share.
- **Should the dashboard replace the root `seerr-quota/` analysis scripts?**
  Partly — it subsumes the recurring reporting. Keep the scripts: they're the
  reproducible, dependency-free way to re-derive the numbers if this app is ever
  wrong, and they were the source of truth for the original analysis.
