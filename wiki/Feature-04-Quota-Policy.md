# Feature 4 — Quota Policy

## Summary

Each member gets a size quota in bytes: a global default, overridable per
person by the operator. Setting a quota is a first-class, audited action with a
visible before/after — not a config file edit and a restart.

## User stories

- As the **operator**, I want to set one person's quota from a dashboard in ten
  seconds, so that "Alice gets more room" isn't a deployment.
- As the **operator**, I want to see what a quota change would do *before* I
  commit it — who goes over, who comes back under.
- As a **member**, I want to know what my limit is and why it's that, without
  having to ask.

## Functional requirements

- **FR-POL-1** — There MUST be a global default quota (`default_quota_bytes`),
  editable by the operator at runtime, applied to every member with no override.
- **FR-POL-2** — The operator MUST be able to set a per-member override. An
  override of `0` MUST mean **unlimited**, matching Seerr's own convention for
  `movieQuotaLimit`. A `null`/cleared override MUST mean "inherit the default"
  and MUST be visibly distinct from `0` in the UI.
- **FR-POL-2a** — Effective-quota resolution MUST take **both** the member's
  override and the global default, and MUST distinguish **three** states, never
  two: a concrete limit, `0` = unlimited (a decision), and **"no quota
  configured"** (an absence — the global default is unset **and** the member has
  no override). Inheritance MUST be resolved at read time; the default's value
  MUST NOT be materialised into `quota_policy` rows, so raising the default
  applies immediately with no fan-out write and nothing to drift. An absence MUST NOT be silently promoted to
  unlimited. Enforcement treats it as unenforceable and **skips**, per the
  fail-open rule in `FR-ENF-4`, and the app MUST refuse to start when
  `enforcement_enabled` is true and `default_quota_bytes` is unset — enforcing
  a limit nobody has decided is worse than not starting.
- **FR-POL-3** — Every quota change MUST write an audit row with the previous
  and new values, the actor, and any note (`D-8`).
- **FR-POL-4** — Before committing a change, the UI MUST show its effect:
  for a default change, which members would newly be over or newly under; for
  an override, that member's current usage against the proposed limit.
- **FR-POL-5** — Setting a quota below a member's current usage MUST be allowed
  (it is often exactly the intent) but MUST require an explicit confirmation
  that states how far over it puts them and that it will block their next
  request.
- **FR-POL-6** — A member MUST be able to see their own quota, current usage,
  percentage, remaining bytes, and any operator note. A member MUST NOT be able
  to change their own quota, and MUST NOT see other members' quotas.
- **FR-POL-7** — There MUST be a global `enforcement_enabled` switch, default
  **off** at first deploy, so accounting can be observed for a period before
  anything is blocked. Flipping it MUST be audited.
- **FR-POL-8** — There MUST be a `grace_bytes` allowance (default 0) applied
  above the quota before a request is held, so a member sitting marginally over
  isn't blocked by rounding.
- **FR-POL-9** — Quota values MUST be entered and displayed in GB (decimal) and
  stored in bytes. The UI MUST NOT accept a negative value, and MUST warn on a
  value above the free space on `/mnt/media`.
- **FR-POL-10** — This feature MUST NOT modify Seerr's native count quotas
  (`movieQuotaLimit` / `tvQuotaLimit`). Those remain configured in Seerr and are
  displayed here read-only for context (`D-1`).

## Choosing the numbers

Not prescribed by this spec — the operator sets them, per deployment — but
two complementary approaches are worth weighing, and the admin dashboard's
"what would this do" preview (`FR-POL-4`) is built to let you try either
before committing to real numbers.

For illustration, imagine a deployment where the library is a few TB with
modest free space remaining and a few hundred GB/month of recent growth, and
measured per-member usage ranges from under 200 GB to just over 1 TB. One
reasonable recommendation on that shape of data would be to **grandfather
each member's current usage with a fixed headroom on top** (e.g. +100 GB),
with a flat default quota for new members (e.g. 300 GB), and `0` (unlimited,
but still tracked) for any member the operator wants exempt — mirroring
Seerr's own admin bypass for the operator's own account.

**A caution worth carrying into any real analysis**: don't trust a one-off
growth-rate figure at face value. Different framings of "normal" vs.
"elevated" growth can produce wildly different multipliers from the same raw
numbers — re-derive the baseline a couple of ways before treating any
single ratio as ground truth, and re-run the whole analysis again after a
few weeks of enforcement-off observation, since a quota system changes
behaviour the moment people know it exists.

The two approaches modelled:

1. **Bound total growth** — pick a fleet budget (say 3 TB/year of headroom),
   divide by active members, set that as the default. Simple, fair, easy to
   explain.
2. **Grandfather current usage** — set each member's override at their current
   usage plus headroom, so nobody is instantly blocked and the quota bites on
   *new* growth. Gentler rollout; costs the operator a per-member decision.

The dashboard's "what would this do" preview (`FR-POL-4`) exists so either can
be tried before committing. Recommendation: ship with
`enforcement_enabled = false` (`FR-POL-7`), watch real numbers for a couple of
weeks before setting limits — skipping this observation step is exactly what
makes a first quota rollout feel arbitrary to the people it affects.

## Interactions

Entirely local: `quota_policy` and `app_setting` tables. Seerr's count quotas
are read for display only:

```
GET /api/v1/user/{id}                → movieQuotaLimit/Days, tvQuotaLimit/Days
GET /api/v1/user/{id}/quota          → current count-quota consumption  (✓ verified
                                       against a live Seerr instance)
```

## Acceptance criteria

- **Given** a member with no override, **when** the operator raises the global
  default, **then** that member's effective quota rises and an audit row records
  the default change.
- **Given** a member with override `0`, **when** enforcement evaluates them,
  **then** they are never held for size, regardless of usage.
- **Given** a cleared override, **when** displayed, **then** the UI shows
  "inherits default (X GB)" and not "0".
- **Given** a proposed default of 200 GB, **when** the operator opens the
  preview, **then** it lists exactly which members would be newly over.
- **Given** an override set below current usage, **when** the operator submits,
  **then** a confirmation states the overage and the blocking consequence before
  it commits.
- **Given** `enforcement_enabled = false`, **when** a member exceeds quota,
  **then** nothing is held, no notification is sent, and the admin dashboard
  shows them as "would be held".
- **Given** any quota change, **when** the audit log is read, **then** the row
  contains before, after, actor, and timestamp.

## Edge cases & failure modes

- **Member with `sync_status != matched`** — has a quota row (FR-SYNC-5) but no
  attributable usage. Show as "not yet linked", never as 0% used.
- **Quota set while a reconcile is mid-flight** — the policy read happens at
  decision time, not snapshot time, so the new value applies from the next
  decision. No need to invalidate the snapshot.
- **Default lowered to below every member's usage** — legal, and will block
  everyone. The preview must make this unmissable; that is the whole point of
  FR-POL-4.
- **`grace_bytes` larger than the quota** — reject at input validation.

## Open questions

- **Should quota be time-windowed like Seerr's count quotas (X GB per 30 days)
  rather than a standing footprint cap?** A rolling window rewards deleting
  and re-requesting; a standing cap rewards keeping your library small. The
  default intent modelled here — give each member their own size quota and
  let them delete titles they no longer want if they run out of room — is a
  **standing cap**, so that's what's specced. Worth revisiting for your own
  deployment after a month of real data.
- **Should there be a shared "household" pool** (e.g. two members sharing
  one budget)? Not specced; would need a group concept. If a member is
  already exempt from Seerr's own count quotas, the operator may want the
  same exemption here.
