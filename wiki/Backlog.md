# Backlog

Four phases. Each item has an ID, a size (**S** ≈ half a day, **M** ≈ 1–2 days,
**L** ≈ 3–5 days), dependencies, and a definition of done. IDs are stable —
the feature pages reference them.

---

## Current status

P0, P1, and most of P2 are done. The remaining P2 items are two
operator-gated switches (`P2-1`, `P2-8`) that are deliberately the *last*
things turned on in any deployment, plus Seerr account provisioning
(`P2-3`) and the in-Seerr banner's nginx half (`P2-10`), which are
per-deployment install steps rather than app code. The full test suite
passes in the Docker `test` stage and `tsc --noEmit` is clean.

The app is designed to run safely in "observe only" mode indefinitely:
deploy it with `ENFORCEMENT_ENABLED=false` and no `DEFAULT_QUOTA_BYTES`
and it reconciles and reports without changing anything. Turning on
self-service deletion and then enforcement are deliberate, later steps —
see `wiki/Deployment.md` §7 for the recommended order.

**The one thing blocking enforcement on any given deployment** is deciding
the actual quota numbers (`P0-5`) for that deployment — there's no
universal default that makes sense across different libraries and
household sizes. Until that call is made, running with enforcement off and
watching the accounting numbers is the recommended state.

**Known gaps outside the tables below:**

- No database backup pre-step is wired into any particular backup tool —
  see `wiki/Deployment.md` §6 for the general approach (an online SQLite
  `.backup` before whatever snapshots your host).
- A request whose matching title is missing from Radarr/Sonarr logs
  `attribution.unresolved_request` on every reconcile pass until it's
  resolved — cosmetic, but worth knowing about if you see it repeatedly in
  the logs for the same request.

---

## The shape of the plan, and why

Two ordering constraints drive everything:

1. **Nothing destructive ships until the audit log and the admin dashboard
   exist.** You cannot safely give members a delete button on a no-rollback
   production host before you can see what they did with it.
2. **Enforcement is enabled *last*, after self-service deletion works.**
   Blocking someone's requests before they have any way to get back under quota
   is just a wall. The whole premise of this project is *"give each member
   their own size quota and let them delete requests they don't want if they
   run out."* The second half has to be real before the first half is turned
   on.

So Phase 1 ships something genuinely useful with **zero** destructive
capability: everyone can see exactly what they're using. That alone may change
behaviour, and it costs nothing to find out.

```
P0 de-risk  ──►  P1 observe  ──►  P2 control  ──►  P3 harden  ──►  P4 deferred
   spikes         read-only        quota +          monitoring,     per-season,
   only           accounting       delete +         estimation,     pools,
                  + dashboard      enforcement      digests         coexistence
                                        ▲
                                  first production
                                  behaviour change
```

---

## P0 — De-risk

No production change. Every item here exists because a feature page marks an
API claim `~ documented` or `? unverified`, and building on an assumption that
turns out wrong is the expensive failure mode.

| ID | Item | Size | Done when |
|---|---|---|---|
| **P0-1** ✅ | **DONE.** **Verify the Seerr API surface.** `GET /api/v1/request` pagination + field shape, `GET /api/v1/user`, `POST /request/{id}/approve\|decline`. | S | Each endpoint called read-only against live Seerr, response shapes recorded in [[Feature-03-Usage-Accounting]] / [[Feature-05-Enforcement]], `~` upgraded to `✓` |
| **P0-2** ✅ | **DONE.** **Verify Radarr/Sonarr delete semantics — without deleting anything.** Confirm param names (`deleteFiles`, `addImportExclusion`), confirm the response shape, and confirm a ZFS (or equivalent snapshot) recovery path by restoring one file to a scratch location. | S | Params confirmed against running Radarr/Sonarr versions; a real file demonstrably recoverable from a snapshot; recovery steps written into [[Feature-06-Self-Service-Deletion]] |
| **P0-3** ✅ | **DONE.** **Verify the Authentik entitlement query.** Which endpoint reliably answers "does user X hold the Seerr application binding" — policy bindings by target, or a per-user check. Create the dedicated read-only service token. | S | Query returns exactly the entitled set; token declared and applied cleanly |
| **P0-4** ◐ | **Answered from source, not live capture.** The webhook template, the full variable list (incl. `request_id`), the "Request Pending Approval" type (`MEDIA_PENDING = 2`), and **two** usable secret-header mechanisms (`authHeader` and `customHeaders`) are all confirmed by reading Seerr's `webhook.js`. A live capture is deliberately deferred to whenever the webhook is actually enabled on a real deployment, since that's a production Seerr settings change needing an operator's sign-off (`P2-1`). | S | ✅ for design purposes; live delivery confirmed during `P2-1` on any given deployment |
| **P0-5** ◐ | **Per-deployment operator decision, not a build task.** **Decide the quota numbers.** Informed by your own disk-usage data and the two approaches in [[Feature-04-Quota-Policy]]. Can run in parallel with all of P1. | S | A default and any per-member overrides written down for your deployment. Blocks `P2-8` only |

### What P0 found

Three findings invalidated design assumptions rather than merely confirming them —
which is the entire justification for running this phase before writing code:

1. **Seerr cannot carry a decline reason** (`P0-1`).
   `POST /request/{id}/{approve|decline}` takes no body; no reason field exists
   anywhere in the API. The design therefore **holds** over-quota requests rather
   than declining them, and this app owns member notification end to end — see
   `D-4a` in [[Feature-05-Enforcement]]. Consequences: an SMTP relay dependency,
   and item `P2-9`.
2. **Sonarr's delete parameter is not Radarr's**
   (`P0-2`). Sonarr wants
   `addImportListExclusion`, Radarr wants `addImportExclusion`. Copying one onto
   the other silently does the wrong thing. Corrected in
   [[Feature-06-Self-Service-Deletion]] `FR-DEL-10`.
3. **The even-split attribution model was reversed**
   (`P0-5`, measured against a real deployment). Co-requested titles turned out
   to be rare, so splitting shared titles was correcting a small rounding error
   with a large amount of machinery — and it was exploitable: under an even
   split, *N* members who agree to co-request everything each pay 1/*N*, so the
   library could grow to *N*× the sum of their quotas. `D-3` now charges every
   requester the **full** size. This deletes the re-split logic, the
   passive-overage case, and an explanation requirement, and makes `P1-6`
   materially smaller. Cost: per-member usage overlaps, so fleet totals must go
   over distinct titles (`FR-ACCT-3`).
4. **`GET /core/applications/?slug=` is unreliable**
   (`P0-3`) — the list endpoint filters to what the
   *caller* may launch, and returned a wrong/empty result on two of two tries.
   Use detail-by-slug, or pass the UUID in directly (e.g. a terraform output, if
   you manage Authentik as code). Also: an Authentik token can't be scoped by
   itself, so the "read-only token" is really a dedicated service account with
   three view permissions.

`P0-3` found zero drift between Authentik's live bindings and a terraform-managed
declaration of them, on the deployment this was built against.

`P0-2` also confirmed the ZFS safety story, and found it stronger than specced:
a media dataset with auto-snapshot active across multiple tiers (frequent,
hourly, daily, weekly, monthly) keeps recovery realistic for weeks, not just
"under an hour". One genuine hole: a file imported and deleted inside the same
frequent-snapshot window has no snapshot coverage at all.

---

## P1 — Observe

**Ships read-only.** No approve, no decline, no delete. At the end of this phase
every member can see their own usage and the operator can see the fleet.

| ID | Item | Size | Deps | Done when |
|---|---|---|---|---|
| **P1-1** ✅ | **DONE.** **Scaffold.** Next.js 15 + TS strict + Drizzle + better-sqlite3, `app/Dockerfile` with a `test` stage, `/healthz`, `docker-compose.yml` + `.build.yml` overlay, `.env.example`, config resolver per [[Configuration]] incl. boot validation. | M | — | `docker build --target test` passes, `tsc --noEmit` clean, `curl localhost:8101/healthz` returns ok |
| **P1-2** ✅ | **DONE.** **SSO & identity** ([[Feature-01-SSO-Identity]]). Middleware, role resolution, 401/403 behaviour, `/healthz` exemption, webhook secret check. | S | P1-1 | All FR-SSO acceptance criteria pass, including the header-spoofing and loopback cases |
| **P1-3** ✅ | **DONE.** **Account sync** ([[Feature-02-Account-Sync]]). Authentik + Seerr enumeration, matching, classification, `member` upsert, default-quota assignment. | M | P1-1, P0-1, P0-3 | Produces the expected classification split against live data (matched / `no_seerr_account` / `not_entitled`) |
| **P1-4** ✅ | **DONE** — REST was initially blocked on credentials; shipped against the documented read-only `jellyfin.db` fallback first, validated against the reference script, then moved to REST once a Jellyfin API key existed (see `P3-7`). **Playback sync + the Jellyfin spike.** Try the REST path (`/Users`, `/Items?isPlayed=true`); if impractical, fall back to a documented read-only `jellyfin.db` open. Decide and record which. | M | P1-1 | Per-(title, user) playback rows land; watched-by-anyone matches the reference output |
| **P1-5** ✅ | **DONE.** **Library & request sync** + the shared upstream HTTP client. Radarr movies, Sonarr series, Seerr requests. Note "the request projection" is **not** a table — there is no request cache in the ten-table model; `request_decision` keys on the Seerr id and requests are fetched fresh each reconcile. | M | P1-1, P0-1 | Title count and total `size_bytes` reconcile against an independent reference computation on the same day's data |
| **P1-6** ✅ | **DONE.** **Attribution engine** ([[Feature-03-Usage-Accounting]]). Full-charge claim model as a **pure function** with hand-calculated tests, plus the distinct-title fleet total (`FR-ACCT-3`). **Downgraded L→M** by the `D-3` reversal — no shares, no re-splits. | M | P1-4, P1-5 | Per-member totals reproduce an independent full-charge reference computation; fleet total is over distinct titles; unresolved requests surfaced not dropped |
| **P1-7** ✅ | **DONE.** **Audit log foundation** ([[Feature-08-Audit-Log]]). Table, writer, correlation ids, stdout JSON mirror, the no-`UPDATE`/`DELETE` test. | M | P1-1 | Every action taken so far produces a row; the append-only test fails if someone adds a mutation |
| **P1-8** ✅ | **DONE.** **Member view.** "My usage": quota, usage, %, my titles sorted by charged-bytes-descending, with size, watched state, and last played. Read-only — no buttons. | M | P1-6, P1-10 | A member sees only their own data, with a snapshot timestamp and staleness indicator |
| **P1-9** ✅ | **DONE.** **Admin dashboard, read-only** ([[Feature-07-Admin-Dashboard]] FR-ADM-1..5, 9, 10, 13). Fleet totals, member table, needs-attention panel, member drill-down, manual reconcile. | L | P1-6, P1-10 | Operator sees the fleet; a member gets 403 with an audit row |
| **P1-10** ✅ | **DONE.** **Theme system** ([[Theming]]). Tokens, primitives, light/dark, responsive, no external assets. | M | P1-1 | Looks professional at-home alongside Seerr, in both themes, at 375px |
| **P1-11** ◐ | **Mostly done, per-deployment.** Reverse-proxy vhost (with the `/healthz` and webhook bypasses), IdP app + read-only service account, and an uptime-monitor endpoint are all documented and exercised. **Outstanding on any given deployment**: a database backup pre-step — see `wiki/Deployment.md` §6 — and opening access up to the full member list, deliberately, pending `P0-5`. | M | P1-2 | Vhost gated and live; uptime monitor green; a backup run completes clean |

**End of P1:** the app is live, useful, and cannot break anything. Let it run and
watch the numbers before changing anything — the step a bare count-quota
rollout is easy to skip.

---

## P2 — Control

First production behaviour change. **Execution order within this phase is not
the ID order:** build P2-2 → P2-4 → P2-11 → P2-5 → P2-6 → P2-9 → P2-7, and only
then execute P2-1 and P2-8 together in one window. P2-9 is not optional before P2-8 —
enforcement without a way to tell members *why* they're held is exactly the
failure that `D-4a` exists to prevent.

| ID | Item | Size | Deps | Done when |
|---|---|---|---|---|
| **P2-1** ❌ | **Per-deployment operator action, deliberately last.** **Seerr-side prerequisites.** Configure the webhook; remove `AUTO_APPROVE` from member accounts. **Execute last**, in the same window as P2-8 — done early, every request sits pending awaiting a manual click. | S | P2-6 | Webhook delivers; member requests land pending and are decided within one interval |
| **P2-2** ✅ | **DONE** (backend; UI wiring is P2-5). **Quota policy** ([[Feature-04-Quota-Policy]]). Global default, per-member overrides, `0` = unlimited, the "what would this do" preview, below-usage confirmation, audit. | M | P1-9 | All FR-POL acceptance criteria pass; `null` vs `0` visibly distinct |
| **P2-3** ❌ | **Not built.** No provisioning route exists; the Seerr-user reader reads users but never creates one. Blocked on an open decision (provision vs revoke, per deployment). **Seerr account provisioning button** (`FR-SYNC-8`). Operator-triggered creation for entitled members with no Seerr account. Needs the Seerr import path verified first. | M | P1-3, P0-1 | One entitled-but-unmatched member provisioned end-to-end and reclassified `matched` |
| **P2-4** ✅ | **DONE**, and since extended by `P2-11`. Deletion module (authorize, guards, plan, execute, store, rate limit, arr + Seerr clients) behind the three-step `/delete` → `/review` → `/confirm` flow, with a large unit-test suite. **Self-service deletion** ([[Feature-06-Self-Service-Deletion]]) — authority model, delete-vs-release, all guards, the three-step flow, per-title batch outcomes, rate limit, full audit. Was flagged as the highest-risk item in the project, and still is. | L | P1-8, P1-7, P0-2 | Every FR-DEL acceptance criterion passes, including the partial-batch and stale-state re-validation cases |
| **P2-5** ✅ | **DONE.** Title protect/unprotect, settings actions, admin request-decide and quota endpoints. **Operator actions** (FR-ADM-6..8, 11, 14). Protect/unprotect, manual approve/decline, act-on-behalf with `on_behalf_of`, settings editing. | M | P2-2, P2-4 | Each action audited; act-on-behalf uses the same three-step flow |
| **P2-6** ✅ | **DONE, and switched off as specified** (`ENFORCEMENT_ENABLED=false`). Pure `decide()`, poller, webhook receiver with secret check, idempotency, hold age-out. **Enforcement, switched off** ([[Feature-05-Enforcement]]). Pure decision function (approve / **hold** / decline / skip per `D-4a`), poller, webhook receiver with secret check, idempotency, skip-on-stale, hold age-out. `enforcement_enabled = false` by default. Records what it *would* do. | L | P1-6, P2-2, P0-1 | Decisions recorded for real pending requests with zero Seerr writes; the dashboard shows "would have held" |
| **P2-9** ✅ | **DONE — mail delivery should be smoke-tested against your own relay before enabling enforcement.** Uses `nodemailer`. **Member notifications** (`FR-ENF-13`…`15`). SMTP via whatever relay you configure, hold/approved templates carrying usage + quota + shortfall + link, per-member cooldown, and the no-email-on-record case surfaced to the operator. Needs outbound access to your SMTP relay. | M | P2-6 | A held member receives one clear, actionable email; freeing space produces an approval email; a second hold in the cooldown window sends nothing |
| **P2-10** ◐ | **App half done; nginx half is a per-deployment install step.** `GET /api/quota-status` ships, and the banner script and an nginx snippet example are provided in `examples/` — but wiring them into your own Seerr vhost is a per-deployment step (see `wiki/Deployment.md` §2). **In-Seerr quota banner** ([[Feature-10-In-Seerr-Banner]]). `GET /api/quota-status` in the app, plus the static script and the `sub_filter` + status-endpoint blocks in your Seerr vhost config. | M | P2-6 | An over-quota member sees the banner with real numbers on any Seerr page; a member in good standing sees nothing; stopping `seerr-quota` leaves Seerr completely unaffected |
| **P2-7** ✅ | **DONE.** Audit browse page with filters + CSV/JSONL export; members see their own history. **Audit browse & export** (`FR-AUD-9`, `FR-AUD-10`). Filters on actor/action/target/outcome/time, CSV + JSONL export, member-visible own history. | M | P1-7 | Operator can answer "who deleted what, when" from the UI alone |
| **P2-8** ❌ | **Not done — the last switch, and rightly still off until an operator decides it's time.** **Enable enforcement** + tell the members. Set the quotas from P0-5, flip `enforcement_enabled`, verify with one real request, then message everyone with a link to their dashboard and how to free space. **Pre-flight: send one real test email through your configured SMTP relay first.** Enforcement without working mail is the failure `D-4a` exists to prevent. | S | P2-1, P2-4, P2-6, P2-9, P2-10, P0-5 | One real over-quota request declined with a correct, actionable reason; members informed **before** they hit it |
| **P2-11** ✅ | **DONE — supersedes `P3-4`.** **Scheduled deletion with self-service undo** (`FR-DEL-22`…`FR-DEL-28`, revised `D-7`). Confirming a file deletion now writes a `scheduled` row with `scheduled_for = now + DELETE_GRACE_PERIOD` (24h) instead of deleting; a sweeper on `DELETE_SWEEP_INTERVAL` (5m) executes what is due, re-running every authorization and guard check against fresh state and **cancelling** anything that has become unsafe. The owner or the operator can cancel from the UI at any point in the window. Bytes are credited at schedule time, with a member's cancel refused if it would exceed their quota (the operator is exempt). Releases still execute inline. | L | P2-4 | Every FR-DEL-22…28 acceptance case passes with a large dedicated test suite; confirming issues no arr call; a guard that fires during the window cancels rather than deletes; the Docker `test` stage is green |

---

## P3 — Harden

| ID | Item | Size | Deps | Notes |
|---|---|---|---|---|
| **P3-1** ❌ | Not built — `/healthz` is liveness-only and says so in a comment. **Deep health + freshness monitoring.** `/healthz?deep=1` reporting snapshot age; an uptime-monitor endpoint so a wedged reconciler is visible. Must leak no member data. | S | P1-11 | A silent reconciler is the failure mode most likely to go unnoticed |
| **P3-2** | **Request-time size estimation** (`D-5`). Estimate the pending item from quality profile bitrate × runtime; gate on `usage + estimate`. **Default off.** | L | P2-6 | Closes the "one huge multi-season request from a member near their limit" gap. Only worth it if that gap actually bites |
| **P3-3** | **Trends & growth charts** (`FR-ADM-12`). Library growth by month, attributed growth per member. | M | P1-9 | Answers "are the quotas bending the curve" |
| **P3-4** ⛔ | **SUPERSEDED by `P2-11`** — do not build this. A wider self-service-undo scope was requested than this item originally had: cancellable by **the member who scheduled it** as well as the operator, and on by default rather than optional. The deferral reasoning below turned out to be wrong on its own terms: a filesystem snapshot covers the same *data*, but only via a path that needs the member to notice, ask, and the operator to act. | M | P2-4 | ~~Deferred deliberately: filesystem snapshots already cover the same risk, and a queue adds a class of partial-state bugs~~ |
| **P3-5** | **Notification digest of destructive actions.** Daily summary of deletions and denials via whatever notification channel you already use for the rest of your stack; immediate message on `invariant.violated` or a partially-failed deletion. | S | P2-4 | Cheap, high value — operator-only is the right audience |
| **P3-6** | **Reassign a claim** (`claim.reassigned`). Operator moves attribution between members. | S | P2-5 | Needed when someone leaves, or for an `ambiguous` resolution |
| **P3-7** ✅ | **DONE** — a dedicated Jellyfin API key was issued; `JELLYFIN_PLAYBACK_SOURCE=rest`, verified against the SQLite reader. **Move playback from the `jellyfin.db` read to the REST API.** Needs a dedicated Jellyfin API key (an operator action — `P1-4` deliberately did not create one unasked). The `JellyfinPlaybackSource` interface already exists so this is a drop-in; then remove the read-only DB bind mount and `JELLYFIN_DB_PATH`. | S | P1-4 | REST implementation reproduces the same agreement the DB reader achieves |
| **P3-8** ❌ | Not built, but **not blocked** once `P3-7` is done — a Jellyfin API key unblocks it. The guard module documents exactly where it slots in. More valuable with `P2-11`'s grace period in place, since this guard gets re-evaluated at execution time, so it would catch someone who started streaming *after* the deletion was scheduled. **`active_session` deletion guard** (`FR-DEL-4`). Block deleting a title someone is streaming **right now** — the worst-case deletion. Live sessions exist only in Jellyfin's memory, not in `jellyfin.db`, so this needs `GET /Sessions` and therefore a Jellyfin API key. Until it exists the guard is simply unavailable and must fail safe. | S | P3-7 | Deleting a title with an active session on it is refused |

---

## P4 — Deferred

Real, but not now. Each is here with the reason it was deferred, so the decision
isn't re-litigated from scratch.

| ID | Item | Why deferred |
|---|---|---|
| **P4-1** | **Per-season accounting and deletion.** Needs `episodeFile`-level size attribution and per-season Sonarr deletion. A staged 6-wave plan exists; an initial verification spike (Sonarr/Seerr/Jellyfin) resolved bulk-vs-per-file delete in favor of per-file. **Wave 1 shipped**: `title.split_into_seasons` (additive, default `false`), a Sonarr episode-file client and byte-by-season aggregator, and library sync upserting season rows only once a series is flagged split — no trigger exists yet, so every series today is byte-for-byte unchanged. Waves 2–5 (playback, attribution + split trigger, deletion, UI) remain unbuilt. | What counts as "watched" for partial TV progress needed thought before building — the plan's answer: per-season `watchedByAnyone` (same any-episode rule, one level down) plus a new `later_season_at_risk` guard for the actually-new risk (an earlier season mid-watch) |
| **P4-2** | **Household / shared quota pools.** | Needs a group concept — revisit if any household ends up wanting shared rather than per-member quotas |
| **P4-3** | **Theme drift check.** A test that fails when a deployment's custom theme override diverges badly from the token contract. | Low value until a deployment actually themes it; but the divergence would be silent, so it's worth doing eventually |
| **P4-4** | **Maintainerr coexistence.** If age-out is ever deployed, define the split so both don't hold delete authority over the same titles. | Maintainerr isn't deployed by default. See [[Architecture]] §"Interaction with Maintainerr" for the intended split |
| **P4-5** | **Rolling-window size quota** (X GB per 30 days) as an alternative to a standing cap. | The default intent modelled here is a standing footprint cap. Revisit after real data if your deployment wants otherwise |
| **P4-6** | **Member-visible fleet view.** Everyone sees everyone's usage. | A social decision, not a technical one — easy to add, impossible to un-share |
| **P4-7** | **Re-check `experimental.authInterrupts` on every Next major bump.** `forbidden()`/`unauthorized()` are what give admin routes a real 403 from a Server Component. | Not urgent: if the flag disappears the build breaks or the status degrades — it can't silently grant access (`FR-ADM-1`) |

---

## Critical path

```
P0-1 ─┬─► P1-3 ─┐
P0-3 ─┘         ├─► P1-6 ──► P1-8 ──► P2-4 ──┐
P1-1 ─┬─► P1-4 ─┤                            ├─► P2-8
      ├─► P1-5 ─┘                            │   (enforcement on)
      ├─► P1-7 ──────────────► P2-7          │
      └─► P1-10 ─► P1-9 ─► P2-2 ─► P2-6 ─────┘
                                    ▲
                              P0-4 ─┘
```

The long pole is **P1-6 (attribution) → P2-4 (deletion) → P2-8**. Everything
else can be parallelised around it. P0-5 (deciding the numbers) is the one item
with no engineering dependency at all and gates only the final switch — start
that conversation early, per deployment.

**The engineering is done; what's left on any given deployment is operator
decisions.** The recommended sequence:

1. **Decide the quota numbers** (`P0-5`) — everything else waits on this.
2. **Open access** to the full member list, and add a database backup pre-step
   (`P1-11`) before members can create state worth losing.
3. **Let members use the read-only view and the delete flow.** Deletion works
   and is undoable; enforcement is still off, so nothing can bite anyone.
4. **Send one real test email** through your SMTP relay (`P2-8`'s pre-flight).
5. **`P2-1` + `P2-8` together**: configure the Seerr webhook, drop
   `AUTO_APPROVE`, set the quotas, flip enforcement, tell everyone.

## Open decisions owed by the operator

Collected from the feature pages, in the order they need answering, on any
given deployment:

1. **The quota numbers** (`P0-5`) — a per-deployment decision, not a build
   task. The two approaches in [[Feature-04-Quota-Policy]] are: grandfather
   each member's current usage plus a fixed headroom, or set one flat
   default for everyone. Either way, re-run the numbers after a few weeks
   of observation before committing — any analysis done before enforcement
   existed won't reflect post-rollout behaviour.
2. **Members who hold entitlement but have never logged in** — provision
   Seerr accounts for them, or revoke access? [[Feature-02-Account-Sync]].
3. **Should any member be exempt from quota entirely** (e.g. near-zero
   unwatched backlog, long-inactive requester)? [[Feature-04-Quota-Policy]].
4. **Standing cap vs rolling window** (`P4-5`) — specced as a standing cap
   based on the default stated intent; confirm for your own deployment.
5. **Member-visible fleet view** (`P4-6`) — currently no.
6. **The logo in the title bar** — one nginx alias line away, if you want the
   family resemblance with your other services obvious. [[Theming]].
7. **Issue a Jellyfin API key for this app?** Recommended — it's what
   `JELLYFIN_PLAYBACK_SOURCE=rest` needs, and unblocks `P3-8` (the
   `active_session` guard) once issued. Without it, playback stays on the
   `jellyfin.db` fallback, which has its own sharp edges (see
   [[Configuration]]).
