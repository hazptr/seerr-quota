# Feature 5 — Enforcement

> **Revised after spike `P0-1`.** The
> original design declined over-quota requests through Seerr's API and expected
> Seerr's own notification to carry the reason. Verified against live Seerr
> v3.3.0: `POST /api/v1/request/{id}/{approve|decline}` **takes no request body,
> and no reason/message field exists anywhere in the API** (`grep -i reason`
> over the full 8021-line OpenAPI spec: zero hits). A Seerr decline is a blunt
> on/off switch. That killed `FR-ENF-3` as originally written and reshaped this
> feature — see `D-4a` below.

## Summary

When a member is at or over their size quota, their new Seerr requests are
**held** — left pending rather than approved — and this app tells them why, in
its own words, through its own notification. When they free up space, the next
reconcile approves the held request automatically. Nothing is declined unless a
hold ages out or the operator declines it by hand.

## User stories

- As the **operator**, I want over-quota members held without me reading every
  request, so the limit is real rather than aspirational.
- As a **member**, I want to be told *why* my request is stuck and *what to do*,
  not left staring at "Pending" — and I don't want to have to re-request once
  I've cleaned up.
- As the **operator**, I want enforcement to fail **open**, so a Radarr hiccup
  never mass-blocks my friends' requests.

## D-4a — Hold, don't decline

Since the reason cannot travel with a Seerr decline, the member would receive a
bare "Request Declined" with no explanation. That is precisely the failure mode
that broke the first count-quota rollout, where two members were locked
out by a miscalibrated limit and it read as arbitrary. So:

| | Under quota | At/over quota |
|---|---|---|
| **Action** | `POST …/approve` | **nothing — leave pending** |
| **Member sees in Seerr** | request proceeds | "Pending" |
| **Member hears from us** | nothing | a notification with usage, quota, shortfall, and a link |
| **When they free space** | — | next reconcile approves it automatically |

Why this beats declining:

- **It self-heals.** Free space → the held request is approved on the next
  poll. No re-request, no lost intent. The quota becomes a queue rather than a
  wall.
- **It's non-destructive and reversible**, which is the right default on a host
  with no rollback. A wrong hold costs a delay; a wrong decline costs the
  member's request.
- **The count quota still caps the pile-up.** A member can't hold 200 requests,
  because Seerr's native 5 movies/7d and 10 seasons/14d still apply underneath
  (`D-1` earning its place again).

The cost to manage: held requests accumulate in Seerr's pending list, which is
also the operator's "needs action" queue. Mitigated by `HOLD_MAX_DAYS`
(auto-decline as a safety valve) and by surfacing held requests prominently in
both the member UI and the admin dashboard.

## How it works

```
       Seerr: request created, status = 1 (PENDING)
              │
   ┌──────────┴───────────────────────────────┐
   │ webhook (fast)                            │ poller (correct)
   │ Seerr notification agent fires            │ every RECONCILE_INTERVAL,
   │ POST /api/seerr/webhook  {request_id}     │ GET /api/v1/request?filter=pending
   └──────────┬───────────────────────────────┘
              ▼
       decide(member, request)  ← ONE pure function, both paths
              │
      ┌───────┼────────────────────┐
   approve   hold                decline
      │       │                     │
 POST …/    do nothing        only on hold age-out
 approve    + notify once      or operator action
      │       │                     │
   audit    audit + member       audit
            notification
              │
              └─► member frees space ─► next poll ─► approve + notify
```

The webhook is an **optimisation for latency**. The poller is the **contract**.
A dropped webhook must never leave a request stuck, and the two must never
disagree — guaranteed by both calling the same pure decision function over the
same snapshot rather than each implementing the rule.

## Functional requirements

- **FR-ENF-1** — The decision MUST be a pure function of
  `(usage_bytes, quota_bytes, grace_bytes, enforcement_enabled, member state,
  snapshot age, hold age)` with no I/O, so it is unit-testable with
  hand-calculated cases and cannot behave differently on the two paths.
- **FR-ENF-2** — A member whose `usage_bytes > quota_bytes + grace_bytes` MUST
  have new requests **held** — left pending, with no Seerr write at all.
  Otherwise the request MUST be **approved**.
- **FR-ENF-3** — *(revised)* The app MUST deliver the reason itself, through
  **two** channels, because a held request otherwise just reads as "Pending" and
  looks like nothing is wrong:
  1. **In Seerr**, a banner stating usage, quota, shortfall and held count —
     see [[Feature-10-In-Seerr-Banner]]. This is the *primary* signal: it
     reaches the member in the place they made the request.
  2. **By email** (`FR-ENF-13`), so someone who doesn't open Seerr again still
     finds out.

  The app MUST NOT rely on Seerr's decline or its own notifications to convey
  any of this — verified impossible (P0-1 §C).
- **FR-ENF-4** — Enforcement MUST fail **open**. If the attribution snapshot is
  older than `STALE_SNAPSHOT_MAX_AGE`, or the member is `ambiguous` /
  `no_seerr_account`, or usage cannot be computed, the app MUST **skip** the
  request — no approve, no hold notification, no decline — and record the skip
  with a **specific** reason: `stale_snapshot`, `unknown_member`,
  `member_not_matched`, `quota_unconfigured`, or `usage_unavailable`. These MUST
  NOT be collapsed into one value; the operator's response to "you never set a
  default quota" is completely different from "this member isn't linked yet". A skip and a hold are different
  states and MUST NOT be conflated: a hold is a decision, a skip is an absence
  of one.
- **FR-ENF-5** — When `enforcement_enabled = false`, the app MUST NOT call Seerr
  at all and MUST NOT notify members. It MUST still evaluate and record what it
  *would* have done (`FR-POL-7`), storing the **true** verdict in `decision` and
  the **true** reason in `reason`, with `enforced = false` marking it a shadow
  row. The reason MUST NOT be overwritten with a marker meaning "enforcement was
  off" — the operator's whole purpose in shadow mode is seeing *why* each
  request would have been held, so "would have held (over quota)" is the
  information they need and "would have held" alone is not.
- **FR-ENF-6** — The operator MUST be exempt: their requests are always
  approved, with reason `operator_exempt`. This mirrors Seerr's own behaviour,
  where `MANAGE_USERS`/`ADMIN` skips quota regardless of stored value.
- **FR-ENF-6a** — A request whose live Seerr status is no longer `PENDING`
  (approved or declined elsewhere, e.g. by the operator in Seerr's own UI) MUST
  be treated as a no-op: no `request_decision` row, no audit row. None of the
  four decision values honestly describes "something else happened to it", and
  inventing one would corrupt the shadow-mode statistics.
- **FR-ENF-7** — Every decision MUST be idempotent and keyed on
  `seerr_request_id`. The poller MUST NOT re-decide a request already decided,
  and a duplicate webhook MUST NOT produce a second Seerr call **or a second
  notification**.
- **FR-ENF-8** — The webhook receiver MUST treat its payload as untrusted: it is
  a *trigger to re-evaluate*, never a source of truth. Only `request_id` may be
  read from it; the member, request, and usage MUST be re-read from the APIs and
  the local snapshot.
- **FR-ENF-9** — Every decision MUST write both a `request_decision` row (with
  the usage/quota inputs snapshotted, so a past verdict stays explainable months
  later) and an audit row.
- **FR-ENF-10** — The app MUST NOT act on a request belonging to a member it
  does not recognise; it MUST skip and surface it.
- **FR-ENF-11** — There MUST be a manual operator override: approve or decline
  any pending or held request from the admin dashboard, audited with
  `source = manual`. **Declining is an operator action, not an automated one**,
  except for `FR-ENF-12`.
- **FR-ENF-12** — A request held longer than `HOLD_MAX_DAYS` (default `30`,
  `0` = never) MUST be auto-declined as a safety valve, with a member
  notification sent first. This exists so Seerr's pending queue cannot grow
  without bound; it is not the primary enforcement path.
- **FR-ENF-13** — Member notifications MUST be sent by email via the
  configured SMTP relay, to the member's Authentik email. A member with no
  email on record MUST be surfaced to the operator rather than silently
  un-notified.
- **FR-ENF-14** — Notifications MUST be throttled: at most one hold notification
  per member per `NOTIFY_COOLDOWN` (default 24h), regardless of how many
  requests they hold in that window. The reconcile loop runs every 15 minutes
  and MUST NOT mail somebody four times an hour.
- **FR-ENF-15** — When a held request is subsequently approved because the
  member freed space, the member MUST be notified of *that* too. Being told
  you're stuck and never told you're unstuck is worse than not being told at all.
- **FR-ENF-16** — Enforcement MUST NOT modify, retry, or delete anything in
  Radarr/Sonarr. Its entire write surface is Seerr's approve endpoint, plus
  decline under `FR-ENF-11`/`FR-ENF-12`.

## Interactions

All of the following are **`✓ verified` live** against Seerr v3.3.0
(P0-1):

```
GET  /api/v1/request?filter=pending&take=100
     params: take, skip, filter, sort(added|modified), sortDirection, requestedBy, mediaType
POST /api/v1/request/{requestId}/{status}      status ∈ {approve, decline}
     NO request body. Returns 200 + the updated MediaRequest.
     Requires MANAGE_REQUESTS or ADMIN.
```

Note it is **one templated route**, not two handlers — the concrete URLs
`…/97/approve` and `…/97/decline` are correct, but don't go hunting for two
separate handlers in Seerr's source.

**Status enums — use these, not the bundled OpenAPI spec.** The spec shipped in
the image is stale; these come from `/app/dist/constants/media.js` and were
confirmed against all 92 live requests:

```
MediaRequestStatus:  1=PENDING  2=APPROVED  3=DECLINED  4=FAILED  5=COMPLETED
MediaStatus:         1=UNKNOWN  2=PENDING   3=PROCESSING  4=PARTIALLY_AVAILABLE
                     5=AVAILABLE  6=BLOCKLISTED  7=DELETED
```

The old spec omits `FAILED`/`COMPLETED` entirely and says `6=DELETED`. Coding
off it would fall through to a default case on **66 of 92 real requests**
(status 5) and would misread the two genuinely-deleted media rows (status 7) as
blocklisted.

**Seerr webhook config** — Settings → Notifications → Webhook, URL
`http://seerr-quota:3000/api/seerr/webhook`, notification type
**"Request Pending Approval"** (`MEDIA_PENDING = 2`). The default JSON template
includes `{{request_id}}`; trim it to just that per `FR-ENF-8`. The secret can
go in **either** `options.authHeader` (sent verbatim as `Authorization`) or
`options.customHeaders` (arbitrary `{key, value}` pairs, e.g.
`X-Seerr-Webhook-Secret`) — both mechanisms exist and are confirmed in
`webhook.js`. Prefer `customHeaders` so the header name is explicit.

**Permission change required in Seerr** — members must lose `AUTO_APPROVE`. A
deployment that gave every member account auto-approve by default has zero
friction between clicking Request and it hitting the download queue, which is
the root cause this feature exists to fix. Dropping `AUTO_APPROVE` is a
**prerequisite** ([[Backlog]] `P2-1`) and the one change with immediate
user-visible effect in production. Note `filter=pending` returns zero rows for
as long as auto-approve stays on for everyone — so this switch is also what
makes the poller do anything at all.

## Acceptance criteria

- **Given** a member at 90% of quota, **when** they request, **then** it is
  approved within one poll interval, audited `under_quota`.
- **Given** a member over quota, **when** they request, **then** **no Seerr call
  is made**, the request stays pending, a `held` decision is recorded, and the
  member is emailed with their usage, quota, shortfall, and the dashboard link.
- **Given** a member with three held requests in one day, **when** notifications
  are sent, **then** exactly one email is sent in the cooldown window.
- **Given** a member over quota who then deletes enough, **when** the next
  reconcile runs, **then** their held request is approved without them
  re-requesting, and they are notified it went through.
- **Given** a request held for longer than `HOLD_MAX_DAYS`, **when** the sweep
  runs, **then** the member is notified and the request is declined, audited.
- **Given** the snapshot is 3 hours stale, **when** a pending request is
  evaluated, **then** it is **skipped** — not held, not declined, no
  notification — recorded `stale_snapshot`, and shown in the attention list.
- **Given** `enforcement_enabled = false`, **when** an over-quota member
  requests, **then** no Seerr call and no email, and the dashboard shows "would
  have held".
- **Given** the same webhook delivered twice, **when** both are processed,
  **then** at most one Seerr call and at most one notification result.
- **Given** a webhook carrying another member's `request_id`, **when**
  processed, **then** the decision is computed from the real request's real
  requester — the payload cannot redirect the verdict.
- **Given** the operator requests anything, **when** evaluated, **then**
  approved with reason `operator_exempt`.
- **Given** Seerr returns 500 on approve, **when** the call fails, **then** the
  decision is recorded as errored, not marked final, and the next poll retries.

## Edge cases & failure modes

- **Seerr down** — poller fails in isolation, requests stay pending (which is
  also the hold state, so nothing is wrongly decided), no notifications sent.
- **A member sitting exactly at quota** — `>` not `>=`, plus `grace_bytes`.
  Exactly at your limit approves; exceeding it holds. Stated in the member UI so
  the boundary isn't a surprise.
- **Usage rising with no action by the member** — cannot happen by design since
  `D-3` was revised to full charging (`FR-ACCT-7`). The only way a member's usage
  grows is their own request landing, or a title genuinely growing on disk (a
  season being added to a series they claim). The latter *is* real and the
  notification should name the title, so it doesn't read as arbitrary.
- **Held request whose media becomes available anyway** — possible if the
  operator approves in Seerr directly, or another member requests the same
  title and is under quota. The reconcile must notice the request is no longer
  pending and close out the hold rather than re-notifying forever.
- **Request auto-created by Seerr** (`isAutoRequest`, e.g. watchlist sync) —
  same rules; the requester is still the member. Worth an explicit test since it
  bypasses the normal UI path.
- **Member has no email in Authentik** — a shared/household account is a
  realistic case for this. Cannot be notified; surface to the operator
  (`FR-ENF-13`) rather than silently holding.
- **Clock skew / timezone** — Unix seconds UTC internally; rendered in
  whatever `TZ` is configured (default UTC).

## Open questions

- **Should the hold notification come from Seerr's mail identity or this
  app's?** They'd typically use the same SMTP relay either way. Proposal:
  this app's own From/subject, clearly labelled, so it doesn't look like a
  Seerr bug.
- **Is `HOLD_MAX_DAYS = 30` right?** Arbitrary starting value. It only matters
  if someone goes a month without cleaning up; revisit with real data.
- ~~Should members get an email on decline?~~ **Closed by P0-1**: not a choice
  any more. Seerr cannot carry the reason, so this app must own member
  notification end to end.
