# Architecture

## The problem, restated

A self-hosted media library has finite disk, and growth traces almost
entirely to Seerr requests. On a typical deployment, a meaningful share of
everything ever requested — think "a few hundred GB out of a couple TB" —
turns out to have never been played by anyone.

Seerr's native quotas cap *request count*, which is a proxy for disk at best: a
single "request this show" click can pull 16 seasons. What an operator actually
wants to bound is **bytes per person**, and — critically — to hand each person
the ability to get back under their own limit without asking anyone.

## System map

```
                        ┌────────────────────────────────────────┐
  member's browser ────►│ nginx (reverse proxy) quota.example.com│
                        │  forward-auth ──► any IdP (0.2.0: not  │
                        │  this app's concern which one)         │
                        │  injects Remote-User / Remote-Groups   │
                        └───────────────┬────────────────────────┘
                                        │ proxy network
                                        ▼
   ┌─────────────────────────────────────────────────────────────────┐
   │ seerr-quota  (Next.js, :3000, container user 1000:1000)         │
   │                                                                  │
   │  ┌───────────┐   ┌────────────┐   ┌──────────┐   ┌───────────┐  │
   │  │ member UI │   │ admin UI   │   │ webhook  │   │ reconciler│  │
   │  │ my usage  │   │ quotas,    │   │ receiver │   │ (interval)│  │
   │  │ my titles │   │ drift,     │   │ /api/    │   │           │  │
   │  │ delete    │   │ audit      │   │ seerr    │   │           │  │
   │  └─────┬─────┘   └─────┬──────┘   └────┬─────┘   └─────┬─────┘  │
   │        └───────────────┴───────────────┴───────────────┘        │
   │                            │                                     │
   │                   ┌────────▼─────────┐                          │
   │                   │ SQLite (/db)     │  quota policy,           │
   │                   │ better-sqlite3   │  attribution snapshot,   │
   │                   │ + Drizzle        │  APPEND-ONLY audit log   │
   │                   └──────────────────┘                          │
   └───────┬──────────┬───────────┬──────────────┬───────────────────┘
           │          │           │              │
      read/write   read-only   read-only     read-only
           │          │           │              │
           ▼          ▼           ▼
      ┌────────┐ ┌─────────┐ ┌─────────┐
      │ Seerr  │ │ Radarr  │ │ Jellyfin│
      │ /api/v1│ │ Sonarr  │ │ /Items  │
      │ users  │ │ /api/v3 │ │ played  │
      └────────┘ └─────────┘ └─────────┘
       approve/    DELETE on
       decline     user action
```

Since 0.2.0 there is no Authentik (or any other IdP) API call from this
app at all — the member roster comes straight from Seerr's own user list
(`wiki/Feature-02-Account-Sync.md`), and login identity comes only from
forward-auth headers the reverse proxy sets (`wiki/Feature-01-SSO-Identity.md`).

Everything upstream is **read-only except two writes**, both of which are
narrow and audited:

1. `POST /api/v1/request/{id}/approve` on Seerr — the enforcement gate. The
   over-quota path writes **nothing**: it leaves the request pending and
   notifies the member itself (`D-4a`, added after spike
   P0-1 proved Seerr's decline call cannot carry
   a reason). `…/decline` is only ever called by an operator action or by the
   `HOLD_MAX_DAYS` safety valve.
2. `DELETE /api/v3/movie/{id}` / `DELETE /api/v3/series/{id}` on Radarr/Sonarr
   — only ever as the direct result of a human clicking through the three-step
   delete flow. **Note the two apps' exclusion parameters are named
   differently** (Radarr `addImportExclusion`, Sonarr `addImportListExclusion`)
   — see P0-2.
3. SMTP to whatever relay you configure, for member notifications (`FR-ENF-13`).

## Stack

**Next.js 15 (App Router) + TypeScript + SQLite (better-sqlite3 + Drizzle),
Tailwind for styling.**

This mirrors the stack of other proxy-auth-gated Next.js sidecars in a
self-hosted media stack — a bind-mounted SQLite DB, a working
Dockerfile/test-stage/deploy pattern worth copying rather than re-deriving. A
Next.js stack was chosen over a FastAPI one on this
host; don't relitigate it.

Container runs as `user: "${PUID:-1000}:${PGID:-1000}"` (PUID/PGID convention)
and binds `127.0.0.1:8101:3000` by default — loopback only, public
exclusively through a reverse proxy. Pick whatever host port is free on your
own deployment.

## Data sources — what each one is authoritative for

| Source | Authoritative for | Access |
|---|---|---|
| **Seerr** `/api/v1` | Who exists (member roster, 0.2.0), requests, requesters, approval state, count quotas | REST, `X-Api-Key` from `configs/jellyseerr/settings.json` → `.env` |
| **Radarr / Sonarr** `/api/v3` | `sizeOnDisk`, file paths, deletion | REST, API keys from each `config.xml` → `.env` |
| **Jellyfin** `/Items`, `/Users` | Playback state (played, last-played, in-progress) | REST, API key → `.env` |
| **seerr-quota** SQLite | Quota policy, attribution snapshot, audit log | local |

Nothing is duplicated into local SQLite that can be re-derived from the sources
above — with three deliberate exceptions (`D-2`, `D-8`): the attribution
snapshot (because it's expensive to recompute and needs history), quota policy
(nowhere else to put it), and the audit log (must survive everything).

> **Read the Seerr API, not its SQLite file.** The existing analysis scripts
> read `configs/jellyseerr/db/db.sqlite3` directly, which is fine for a one-shot
> report but wrong for a long-running service — Seerr holds the WAL, and the
> schema is an internal detail (it has already churned once through the
> Jellyseerr→Seerr rebrand). Read-only sqlite access is permitted **only** as a
> fallback for joins the API genuinely cannot do, and must be documented where
> used. The same rule applies to `jellyfin.db`.

## Design decisions

### D-1 — Quota unit is **bytes on disk**. Seerr's count quotas stay.

Size is what maps to the actual constraint. But the count quota already live
(5 movies/7d, 10 seasons/14d) does something size can't: it stops a burst
*before* 16 seasons are queued. They solve different halves and both stay.

- Count quota: enforced natively by Seerr, unchanged, still configured in Seerr.
- Size quota: enforced by this app.

Rejected: replacing count quotas with size. It would re-open the exact failure
already hit once — a single click pulling a huge multi-season grab before any
size signal exists.

### D-2 — Usage is measured from **actual bytes on disk**, never estimated.

A member's usage is the sum of their attributed share of `sizeOnDisk` as
reported by Radarr/Sonarr at the last reconcile. Pending and unavailable
requests contribute **zero**. This is honest, matches the proven join in
a reference disk-usage computation, and means the numbers shown to a member always
reconcile against the real library.

Consequence to accept: there is a lag between "approved" and "counted" —
a member can be under quota, get approved, and be over once the file lands.
That is correct behaviour, not a bug: the next request is what gets blocked.

### D-3 — Every requester is charged the **full** size of what they asked for.

> **Amended 2026-09-06 by `FR-ACCT-8`.** "Never divided between claimants"
> stands unchanged. "Full size" now means the full size of what they *caused* —
> bytes already on disk before they requested are not charged to them. See
> [[Feature-03-Usage-Accounting]] `FR-ACCT-8` for the case that forced it and
> the (TV-only) scope.

> **This decision was reversed after measuring a real deployment.** It
> originally split a shared title's bytes evenly between its requesters.
> Measured against real data, that was complexity buying nothing and
> creating an exploit. Reversed — reasoning below, because the original argument
> was not stupid and someone will re-propose it.

If two members both requested the same 12 GB movie, **both are charged
12 GB**. Per-member usage therefore does *not* sum to the library size; fleet
totals must be computed over **distinct titles** (`FR-ACCT-3`), and any
per-member column that is summed must be labelled as overlapping.

Why this beats the even split it replaced:

1. **The split bought almost nothing.** Measured against a real deployment's
   history, only a small minority of attributed titles had ever been
   co-requested — e.g. one title out of eighty, overlapping by a few
   percent of the total. All the machinery of shares, re-splits, and a
   sum invariant existed to correct what amounted to a rounding error.
2. **The split is exploitable by collusion, and profitably so.** Under an even
   split, five members who agree to co-request everything each pay ⅕, so the
   library can grow to roughly *five times* the sum of their quotas before
   anything binds. Every colluder gains and nobody loses, which is the kind of
   exploit that actually gets used. Under full charge the library is bounded by
   the *largest* quota, not the sum, and co-requesting costs you full price — so
   there's nothing to collude about.
3. **It deletes a whole class of confusing behaviour.** No re-splits, so a
   member's usage never rises because somebody else did something. That removes
   the passive-overage edge case, the requirement to explain it in the UI, and
   the matching wrinkle in the hold notification.

The residual gaming vector is the mirror image: a co-claimant could release
their claim, drop their full charge, and still watch the title someone else is
paying for. That needs a colluder willing to absorb the full cost for someone
else's benefit — an exploit with a victim, which is far less likely to happen
than one where everybody wins. It is bounded by the rule that a **sole**
claimant may never release, only delete ([[Feature-06-Self-Service-Deletion]]
`D-6`), so bytes can never become unattributed while they sit on disk.

Still rejected: charging only the first requester — unfair, and trivially gamed
by waiting for someone else to ask first.

### D-4 — Enforcement happens at **Seerr's approval gate**, via webhook + poller.

Member accounts lose `AUTO_APPROVE`; their requests land in Seerr as *pending*.
Seerr fires its webhook notification agent on "Request Pending Approval" → this
app evaluates the requester's current usage against their quota → calls
`approve` or `decline` on the Seerr API with a reason.

- **Webhook is for latency** (a member should get a verdict in seconds).
- **A poller is for correctness** — every `RECONCILE_INTERVAL`, sweep
  `GET /api/v1/request?filter=pending` and decide anything the webhook missed.
  The webhook is a best-effort optimisation; the poller is the contract. A
  dropped webhook must never mean a request sits pending forever.

Both paths run the same pure decision function, so they cannot disagree.

Rejected: writing Seerr's per-user count quota to `0` to simulate a block — it
produces a confusing, wrong-reason error in Seerr's UI and fights the count
quota we want to keep.

> **This reverses the direction sketched in an earlier draft of this design**,
> which proposed a pre-check between Seerr and Radarr/Sonarr rather than
> fighting Seerr's own approval flow. That was the
> right instinct about the *problem* — don't fight Seerr — but interception is
> the wrong solution to it. There is no supported hook between Seerr and the
> \*arrs; Seerr calls their APIs directly on approval, so intercepting means
> proxying the Radarr/Sonarr API and leaves Seerr believing a request was
> approved when it wasn't. Driving Seerr's approval gate isn't fighting it —
> it's using the one interface Seerr actually exposes for exactly this
> decision, and it keeps Seerr's state correct and its notifications working.
> Flagged here because it's a deliberate reversal, not an oversight.

### D-5 — Phase 1 gates on **current usage only**; size estimation is deferred.

The rule is: *if you are at or over your quota, your next request is declined.*
There is no attempt in v1 to predict how big the pending item will be and check
`usage + estimate <= quota`.

This is a deliberate simplification. Estimation needs a bitrate model per
quality profile and is wrong often enough to generate exactly the kind of
unexplainable rejection that made the first count-quota pass fail. Getting
"you're out of room, here's what you're holding, delete something" right first
is worth more. Estimation is [[Backlog]] `P3-2`, default-off when it lands.

### D-6 — Deletion authority is **strictly scoped**, and "delete" ≠ "release".

The acting member may act only on titles they are an attributed requester of.
Two different outcomes, and the UI must never blur them:

| Situation | Action | Effect |
|---|---|---|
| Member is the **sole** requester | **Delete** | Radarr/Sonarr delete-with-files, Seerr request removed, member's usage drops by the full size |
| Member is **one of several** requesters | **Release claim** | Their charge ends; other claimants are unaffected (`D-3`). **No file is touched.** |
| Member is not a requester | — | Not offered, and rejected server-side with 403 |

Server-side authorization is re-checked at execute time against freshly-read
attribution — never trusted from the client, and never from the list the UI was
rendered with (it may be stale).

Additional hard blocks, all configurable, all enforced server-side:
- **Operator-protected** titles (`protected` flag) can never be deleted by a member.
- Titles with **playback activity in the last `DELETE_RECENT_PLAY_DAYS`** (default 14)
  by *anyone* are blocked — someone is mid-watch.
- The **operator can delete anything**, subject to the same three-step flow and
  the same audit trail.

### D-7 — Deleting takes **three distinct user actions**, then waits — and is cancellable until it runs.

1. **Select** — tick titles in "my library". Running total of bytes reclaimed.
2. **Review** — a dedicated screen listing every file that will be removed, the
   total size, and a per-title warning if *anyone else* has ever played it.
3. **Confirm** — type the word `delete` (not a title — retyping long titles is
   theatre, and users learn to copy-paste), tick "I understand this schedules
   the permanent removal of N files, X GB, and that it will run unless I cancel
   it first", then the final button.

**Revised 2026-09-05 (operator request).** Confirm no longer deletes. It
schedules the deletion for `DELETE_GRACE_PERIOD` (default 24h) later and
returns; a sweeper on `DELETE_SWEEP_INTERVAL` executes anything now due. Until
then, **the member who scheduled it or the operator can cancel it outright**
(`FR-DEL-22`/`FR-DEL-24`) — a real in-app undo, which this decision previously
said did not exist.

Three consequences worth stating, because each is load-bearing:

- **The grace period is a re-check, not just a delay.** The sweeper re-derives
  every authorization and guard decision against fresh state. A title that
  became protected, or that somebody started watching overnight, is **cancelled**
  rather than deleted (`FR-DEL-26`). That is most of the value: the risk this
  addresses isn't only "I changed my mind", it's "the world changed after I
  decided".
- **The bytes are credited immediately** (`FR-DEL-27`), so a member clearing
  space to get under quota isn't blocked for a day — the "just a wall" failure
  [[Backlog]] warns about. The loophole that opens (schedule, spend the
  headroom, cancel) is closed by refusing a member's cancel that would put them
  back over quota (`FR-DEL-28`); the operator is exempt.
- **A filesystem snapshot tool (e.g. ZFS) is still the real safety net for
  anything already executed.** If your media filesystem takes frequent
  snapshots, a deletion that did run is recoverable from the snapshot store
  within the retention window. The confirm screen's fine print states both:
  the cancellable window first, the snapshot path for after it closes.

This supersedes the deferred delayed-execution queue formerly at [[Backlog]]
`P3-4`, which was operator-cancel-only and was deferred on the grounds that ZFS
covered the same risk. It doesn't: ZFS recovery needs the member to notice, ask
the operator, and the operator to act — a self-service undo needs none of that.

### D-8 — The audit log is **append-only** and covers every state change.

One row per state-changing action, written in the same transaction as the change
where the change is local, and immediately before/after where it is remote (with
the remote response recorded). No `UPDATE`, no `DELETE`, no retention policy —
at this scale the table stays tiny. Also mirrored to stdout as structured JSON
so `docker logs seerr-quota` is a second copy, and so the row survives even if
the DB write is what failed.

What gets a row: approve, decline, quota change, protect/unprotect, claim
release, delete (requested / executed / failed, one row each), account
sync action, and every authorization *denial*. Detail in [[Feature-08-Audit-Log]].

### D-9 — Seerr is the identity source of truth (0.2.0); account sync is **surfaced, not automatic**.

**Changed in 0.2.0** — this app previously called Authentik's admin API
directly to determine entitlement (`Authentik → LDAP → Jellyfin → Seerr`,
matched against Seerr's user list). That integration was removed entirely:
Seerr's own user list is now the SOLE roster source. Every current Seerr
user is a member; a Seerr account that disappears flips to `not_entitled`
and the row is kept, never deleted.

Login identity is unrelated to this and unchanged in spirit — it still
comes only from forward-auth headers the reverse proxy sets
([[Feature-01-SSO-Identity]]) — but since 0.2.0 this app no longer cares
which IdP sits behind that proxy, or calls that IdP's API at all.

The reconciler enumerates Seerr's users and upserts a `member` row per
account, re-matching an EXISTING member by `seerr_user_id` (never by
re-deriving a key from Seerr's current username/email) so a member's login
key is stable for life once linked — see [[Feature-02-Account-Sync]] for the
exact algorithm and why that stability matters (it's the PK every `claim`/
`deletion`/`audit`/`quota_policy`/`request_decision` row is keyed on).

Auto-provisioning a Seerr account for someone who doesn't have one yet is
**not** automatic in v1 — it's a per-user button in the admin UI, because
creating a Seerr account correctly means going through Seerr's Jellyfin-
import path and that needs verifying against the live API before it is
allowed to run unattended ([[Backlog]] `P2-3`). What is automatic: applying
the **default quota** to any newly-seen member, so nobody is ever unlimited by
omission.

### D-10 — The UI is entirely **token-driven**, with a Seerr-matched default.

Every colour and structural choice (font, radius, border width, title-bar
visibility, decorative prefixes) comes from a small set of CSS custom
properties, never a hardcoded value in a component. The app ships a
Seerr-matched dark default (and a light variant) out of the box, and a
runtime `THEME_CSS` override hook so a deployment can retint or restructure
the whole UI — including a terminal-style look, achievable entirely through
an override — without rebuilding the image. Full token reference, the
override mechanism, and acceptance criteria are in [[Theming]].

### D-11 — No automated destruction, ever.

The app's only automated writes to another system are approve/decline and the
execution of a deletion a human already confirmed. Every byte deleted traces to
a specific human clicking through `D-7`, and to an audit row naming **them** —
the sweeper (`FR-DEL-25`) acts as the member who scheduled the deletion, never
as `system`. This is the same "a human clicks Apply" rule worth applying to any
no-rollback production deployment.

The timer added in `D-7` does not weaken this. No rule, timer, or heuristic
**selects** media for deletion — that remains forbidden, and is what age-out
(scoped to Maintainerr) would have been. The timer only controls *when* an
already-chosen deletion happens, and exists precisely to give the human a
window to change their mind.

## Request lifecycle (the interesting path)

```
member clicks Request in Seerr
   └─► Seerr creates request, status = PENDING  (AUTO_APPROVE off for members)
         ├─► webhook  ──► POST /api/seerr/webhook ─┐
         └─► (or, up to RECONCILE_INTERVAL later)  │
             poller sweeps pending requests ───────┤
                                                    ▼
                                    decide(member, request) — pure
                                    usage = attributed bytes (D-2/D-3)
                                    quota = policy for member (D-4)
                                             │
                        ┌────────────────────┴───────────────────┐
                    under quota                              at/over quota
                        │                                         │
              POST …/approve                             POST …/decline
              audit: approve                       audit: decline + reason
                        │                                         │
                        │                          member gets Seerr's decline
                        │                          notice → visits quota.example.com
                        │                          → sees their titles → deletes
                        │                          → next reconcile clears them
                        ▼
              Radarr/Sonarr grab → file lands
                        │
              next reconcile: sizeOnDisk read, attributed (D-3),
              member's usage rises
```

## Reconciler

One interval job (`RECONCILE_INTERVAL`, default 15m) doing, in order:

1. **Member sync** — Seerr's own user list → member table (0.2.0; see `D-9`).
   New members get `DEFAULT_QUOTA_BYTES`.
2. **Library + request sync** — Radarr movies, Sonarr series (`sizeOnDisk`,
   paths) and Seerr requests + requesters. Originally specced as two steps;
   they share a failure boundary and a `sync_run` entry in the implementation
   (`runLibraryAndRequestSync`, step key `library_requests`), so this is **five
   steps in total, not six**. Doc corrected to match working code rather than
   the reverse.
3. **Playback sync** — Jellyfin played/last-played per item.
4. **Attribution** — join the above into per-title, per-member claims (`D-3`),
   write the snapshot.
5. **Pending sweep** — decide every pending request (`D-4`).

Each step is independently retryable and failure-isolated: if Jellyfin is down,
playback data goes stale and the UI says so, but quotas and enforcement keep
working off the last good snapshot. **The pending sweep must not run on a stale
attribution snapshot older than `STALE_SNAPSHOT_MAX_AGE`** — if it is, skip
enforcement and alert rather than approve or decline on bad data. Failing open
(leaving requests pending for a human) is the correct failure mode; failing
closed would decline everyone the moment Radarr hiccups.

## Interaction with Maintainerr

Maintainerr is not deployed and is out of scope here. If it is ever stood up,
the two must not both hold delete authority over the same titles — the
combination of "an automated rule deleted it" and "a member deleted it" makes
the audit log a liar and makes quota numbers jump for reasons nobody can
explain. The intended split, when that day comes:

- Maintainerr: age-out of media **nobody requested** or that has aged past
  policy, in report-only mode first.
- seerr-quota: everything attributable to a member.
- A title covered by both is Maintainerr's, and this app must mark it
  `protected` so no member can race it.

## Security posture

- No public surface except through the reverse proxy + whatever forward-auth
  IdP it's configured with (any of them, since 0.2.0). Loopback bind is the
  backstop.
- Identity comes **only** from the configured username header (default
  `Remote-User`); a request without it is 401, including on loopback
  (`FR-SSO-2`).
- Admin routes re-check role server-side on every request, never from a
  client-supplied hint (`FR-SSO-5`).
- All four upstream API keys live in `.env` (git-ignored), never in the DB,
  never in a committed file, never rendered to the client.
- The Seerr webhook endpoint is unauthenticated by nature — it must verify a
  shared secret (`SEERR_WEBHOOK_SECRET`, sent as a header from Seerr's webhook
  config) and must be treated as untrusted input: it is a *trigger to
  re-evaluate*, never a source of truth. The decision is always recomputed from
  the APIs, never taken from the webhook payload.
