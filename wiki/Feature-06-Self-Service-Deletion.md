# Feature 6 — Self-Service Deletion

## Summary

A member can reclaim their own space: see everything attributed to them, sorted
by "most bytes nobody has ever watched", select what to remove, and delete it
through a three-step confirmation. Authority is strictly scoped — a member can
only act on titles they are an attributed requester of, and files are only
actually deleted when they are the *sole* requester.

**Confirming does not delete.** It *schedules* a deletion for
`DELETE_GRACE_PERIOD` (default 24h) later, during which the member who
scheduled it — or the operator — can cancel it outright (`FR-DEL-22`,
`FR-DEL-24`). The space is credited back to the member immediately so they are
not stuck waiting a day to request again (`FR-DEL-27`); the counterweight is
that cancelling is refused if they have since spent that headroom
(`FR-DEL-28`). When the grace period elapses, a sweeper re-runs every
authorization and guard check against fresh state and executes — or, if the
picture changed, cancels (`FR-DEL-26`).

This is the feature with real destructive power, so it is specified defensively:
every rule below is enforced **server-side at execute time**, against freshly
read state, regardless of what the client sends.

## User stories

- As a **member** who's out of room, I want to delete things I asked for and
  never watched, so I can request something new without asking anyone.
- As a **member**, I want to be certain I can't accidentally delete something
  someone else is watching.
- As a **member** who has just realised I deleted the wrong thing, I want to
  take it back myself, immediately, without messaging anyone.
- As the **operator**, I want a window in which I can stop a deletion that is
  about to happen — and to be able to undo a member's mistake even when they
  can't undo it themselves.
- As the **operator**, I want it to be impossible for a member to delete
  anything that isn't theirs, and I want to be able to pin things nobody may
  touch.
- As the **operator**, I want every deletion permanently attributable.

## Authority model

| Actor | Title state | Offered action | Effect on disk |
|---|---|---|---|
| Member | sole active claimant | **Delete** | Deletion scheduled; files + Seerr request removed when it runs, unless cancelled first |
| Member | one of several claimants | **Release claim** | **Nothing removed.** Their charge ends; every other claimant is unaffected — no re-split, nobody's usage rises (`D-3`) |
| Member | not a claimant | *(nothing offered)* | 403 if attempted directly |
| Member | `protected` | *(blocked, with reason shown)* | — |
| Member | anyone **watching** it — recently played, part-way through, or streaming now (`FR-DEL-4`) | *(blocked, naming which guard, never naming who)* | — |
| Operator | any | **Delete** or **Release** | As above, same three-step flow |
| Member | owns a pending deletion | **Cancel** | Nothing removed; their bytes go back on their books — refused if that would exceed their quota (`FR-DEL-28`) |
| Operator | any pending deletion | **Cancel** | As above, and never refused on quota grounds |

The delete/release distinction is the single most important thing for the UI to
get right. A member clicking "remove this from my usage" on a shared title and
believing they deleted a file — or worse, believing they *hadn't* — is the
failure mode to design against. The two actions must use different words,
different colours, and different confirmation copy.

## The three-step flow (`D-7`)

**Step 1 — Select.** The member's title list, default-sorted by
`charged_bytes` descending among titles nobody has ever played. Each row: title,
year, size, their share, watched-by-anyone, last played, and the action they'd
get (Delete / Release / why it's blocked). Ticking rows accumulates a running
"you would free X GB, taking you from 340 GB to 190 GB (quota 200 GB)".

**Step 2 — Review.** A dedicated screen — not a modal — listing exactly what
will happen to each selected item: the real file path, the size, whether files
will be removed or only a claim released, and a prominent per-title warning if
anyone else has ever played it. Separate sections for "files will be deleted"
and "claim released only" so the two can't be visually conflated. Nothing is
executed from this screen.

**Step 3 — Confirm.** Requires all three of:
1. Typing `delete` into a text field (not a title — long titles get
   copy-pasted, which defeats the purpose).
2. Ticking "I understand this schedules the permanent removal of N files
   totalling X GB, and that it will run unless I cancel it first".
3. Clicking the final button, which is the only destructive-styled control on
   the page and is disabled until 1 and 2 are satisfied.

Confirming writes a `deletion` row in state `scheduled` with
`scheduled_for = now + DELETE_GRACE_PERIOD`. **No file is touched and no
upstream call is made at this point.** The response says so in as many words —
a member who believes the files are already gone will never think to use the
window this feature exists to give them.

**Step 4 (optional) — Cancel.** Pending deletions appear at the top of the
member's own usage page, above the quota figures, each with a Cancel button.
Cancelling is a single click by design: `D-7`'s ceremony exists to make
*destruction* deliberate, and making the undo hard to reach would be the wrong
lesson to draw from it. The operator sees the same list fleet-wide.

Fine print on the confirm screen states the honest recovery position. On the
deployment this was verified against (`P0-2`), the media filesystem is a ZFS
dataset with auto-snapshot active across multiple retention tiers — frequent
(every few minutes), hourly, daily, weekly, and monthly — so the real
recovery window is far wider than "ask quickly", assuming your own deployment
is snapshotted similarly. The exact copy to use:

> Deletions are not immediate. What you confirm here is scheduled, and until it
> runs you can cancel it yourself from your usage page. Once it has run there is
> no in-app undo: deleted files are recovered from automatic ZFS
> snapshots, not from this app. If you act fast (within about an hour),
> recovery is close to certain. Snapshots also exist further back — hourly
> for the last day, daily for the last month, and less often for up to a
> year — so it's still worth asking even if it's been a while. **Message the
> operator as soon as you notice a mistake; the sooner you ask, the more
> certain the recovery.**

**One real hole to know about:** a file imported and deleted *within the same
~15-minute window*, before the next frequent snapshot fires, has no snapshot
coverage at all and is genuinely unrecoverable. Rare (it means deleting
something that just landed) but it is the one case where "no undo" is literally
true — worth a line in the operator runbook. The grace period does not help
here either: it delays the deletion, but the import is still the older event.

## Functional requirements

- **FR-DEL-1** — A member MUST only be offered, and MUST only be able to
  execute, actions on titles where they hold an **active claim**. Authorization
  MUST be re-checked server-side at execute time against freshly read
  attribution — never trusted from the client, and never from the list the UI
  was rendered with, which may be minutes stale.
- **FR-DEL-2** — Files MUST only be deleted when the acting member is the
  **sole** active claimant. With more than one claimant, the only member action
  is **release claim**, which MUST NOT touch any file.
- **FR-DEL-3** — A title marked `protected` MUST NOT be deletable by a member,
  and the UI MUST show why rather than hiding the row.
- **FR-DEL-4** — A title someone else is **watching** MUST be blocked from file
  deletion. "Watching" is three separate conditions, each with its own reason so
  the UI can say which one fired, evaluated against **every** viewer **except
  the subject** (the member whose deletion it is — the actor, or whoever the
  operator acts on behalf of). The subject's own playback never blocks their own
  delete — a member should always be able to free space by deleting their own
  unwanted titles, even ones they themselves have watched. (Rationale: a
  prior design that counted the subject's own plays against them was found,
  on a real deployment, to lock a majority of one member's usage behind
  their own watch history — defeating the purpose of self-service deletion.)
  A viewer with no linked member row always counts as someone else, and a
  play the guard can't attribute still fails safe:

  - **`recently_played`** — anyone else played it within `DELETE_RECENT_PLAY_DAYS`
    (default 14).
  - **`in_progress`** — anyone else has it **unfinished**: an item with a resume
    position and not marked played, or a series where some but not all episodes
    are watched — with activity inside `DELETE_IN_PROGRESS_DAYS` (default 90).
  - **`active_session`** — someone is streaming it **right now**. Requires the
    Jellyfin API (`P3-8`); until then this guard is unavailable and MUST fail
    *safe*, i.e. its absence never turns a block into an allow.

  Measured against live data, `recently_played` alone is badly insufficient:
  **169 items are currently in progress, and 132 of them (78%) have no playback
  inside 14 days** — someone paused a series and hasn't come back yet. That is
  exactly the "watched half a season and came back late" case the original
  analysis warned about, and the 14-day window is blind to all of it.

  The operator MAY override any of the three, with an explicit extra
  confirmation naming which guard fired.
- **FR-DEL-4a** — Guard messaging is asymmetric by audience. A **member** is
  told *that* someone else is partway through, never **who** — their viewing is
  not the actor's business. The **operator** sees who, because resolving it is
  their job.
- **FR-DEL-4b** — The guards MUST be evaluated as an extensible set, each
  returning its own reason, so a new guard can be added without restructuring
  the delete path. `active_session` is arriving later precisely this way.
- **FR-DEL-5** — Deletion MUST require three distinct user actions across at
  least two screens (select → review → typed confirmation). A single-click or
  single-screen path MUST NOT exist anywhere in the UI or API.
- **FR-DEL-6** — The review screen MUST show, per item: title, real file path,
  size, whether files are removed or a claim released, and whether anyone else
  has played it.
- **FR-DEL-7** — Every deletion MUST produce audit rows for **requested**,
  **executed** *(or **failed**)*, sharing one `correlation_id`, recording the
  exact Radarr/Sonarr call issued and the response status (`D-8`).
- **FR-DEL-8** — Batch deletions MUST report **per-title outcomes**. A partial
  failure MUST NOT be reported as success, and MUST NOT abort the remaining
  items. Each title's outcome is independent.
- **FR-DEL-9** — File deletion MUST call Radarr/Sonarr's delete-with-files
  endpoint and MUST also remove the corresponding Seerr request, so Seerr does
  not continue to show the title as available. If the Seerr cleanup fails after
  the file deletion succeeded, this MUST be recorded as a partial failure and
  surfaced to the operator — never silently swallowed.
- **FR-DEL-10** — Deletion MUST NOT add an import exclusion, so a member
  deleting something does not permanently prevent it from being re-requested.
  The parameter differs per app and MUST be set correctly for each:
  Radarr `addImportExclusion=false`, Sonarr `addImportListExclusion=false`.
- **FR-DEL-11** — The app MUST NOT delete files from disk directly. All file
  removal goes through Radarr/Sonarr so their databases stay consistent.
- **FR-DEL-15** — **The destructive path MUST fail closed on unrecognised
  input.** Any request whose mode is absent, malformed, or not an exact known
  literal MUST be **refused** and audited as a denial. It MUST NOT fall through
  to `delete_files`. A review found the opposite: a sole claimant sending
  `"release"` instead of `"release_claim"` — a client typo, an unvalidated
  request body — had their files deleted. Defaulting an unknown instruction to
  the irreversible branch is the single most dangerous shape this module can
  take, and no amount of caller-side validation makes it acceptable here.
- **FR-DEL-16** — **The Seerr request cleanup is a remote effect and MUST be
  audited** like any other (`FR-AUD-8`): an intent row before the call, an
  outcome row after, sharing the operation's `correlation_id`. Without it,
  `FR-DEL-9`'s partial-failure surfacing cannot work — a Seerr cleanup that
  fails after the files are already gone leaves no trace at all.
- **FR-DEL-17** — **The rate limit MUST be atomic** (`FR-DEL-12`). Counting
  prior deletions and then acting is a check-then-act race: two concurrent
  batches each read the count before either writes, and the limit is overshot.
  Reserve or count within the same transaction that records the deletion.
- **FR-DEL-21** — **Missing playback data MUST block every playback-dependent
  guard, not silently allow.** If the playback step failed, has never run, or is
  older than `STALE_SNAPSHOT_MAX_AGE`, `watched_by_anyone = false` means **"we
  don't know"**, not "nobody watched it". The guards MUST report
  `unavailable = true, fired = true` in that state.

  This is not hypothetical: on the first real deployment the playback step
  failed outright (`attempt to write a readonly database` — SQLite cannot open
  Jellyfin's WAL database read-only, because it needs to write the `-shm` file).
  Every title therefore had `watched_by_anyone = false`, which the
  `recently_played` guard reads as "safe to delete" — a fail-open across the
  **entire library**, caused by a step failing in exactly the isolated,
  non-fatal way `FR-ACCT-10` asks it to. Failure isolation and fail-safe are
  different properties, and satisfying the first does not give you the second.
- **FR-DEL-19** — **"Played, time unknown" MUST block, not allow.** A guard that
  knows a title was watched but cannot establish *when* is in the
  `unavailable = true, fired = true` state, not `fired = false`. Absence of
  evidence is not evidence nobody is watching (`FR-DEL-4`). This is reachable in
  practice: playback sync can set `watched_by_anyone` from an aggregate whose
  `last_played_at` is null.
- **FR-DEL-20** — **Claimant counting MUST be over distinct members**, not claim
  rows, and `(title_id, sso_username, active)` MUST be unique. Counting rows
  means a duplicate claim row turns a sole claimant into an apparent
  co-claimant, handing them the release that `FR-DEL-2` forbids — the system's
  main gaming vector, reached by a data-integrity accident rather than an
  attack.
- **FR-DEL-18** — **The batch loop MUST be exception-safe.** No exception from
  any per-item work — guard evaluation, DB reads, the remote calls — may escape
  and abort the batch. An escaping exception means earlier items' files are
  already destroyed while the remaining items get neither an outcome nor an
  audit row, which breaks `FR-DEL-8` and leaves destruction unrecorded. Every
  item's entire processing, not just its remote call, belongs inside the
  per-item boundary.
### Scheduled deletion (`FR-DEL-22` … `FR-DEL-28`)

Added at an operator's request to make a confirmed deletion undoable — not
immediate, and cancellable by either an operator or the member who requested
the deletion themselves. This supersedes the deferred `P3-4` queue idea,
which was operator-cancel-only.

- **FR-DEL-22** — Confirming a **file deletion** MUST NOT delete anything. It
  MUST record a pending deletion in state `scheduled` with
  `scheduled_for = now + DELETE_GRACE_PERIOD` (default `24h`) and make no
  upstream call. The confirmation response MUST state plainly that nothing has
  been deleted yet and that it can be cancelled — a member who thinks the files
  are gone will not use the window.
- **FR-DEL-23** — A **claim release** MUST still execute immediately. It
  destroys nothing, changes only this app's own accounting, and is re-claimable
  by the next reconcile, so there is nothing to undo and nothing to schedule.
- **FR-DEL-24** — A pending deletion MUST be cancellable by **the member who
  scheduled it** or by **the operator**, and by nobody else. Authority MUST be
  re-derived from the stored row's own `sso_username`, never from the request.
  An unauthorized cancel and a nonexistent id MUST be reported identically, so
  the endpoint cannot be used to probe which deletion ids exist (`FR-DEL-14`
  restated for this surface). Cancelling is a **single action** — the
  three-step ceremony exists to make destruction deliberate, and applying it to
  an undo would defeat the purpose.
- **FR-DEL-25** — A sweeper MUST execute deletions whose `scheduled_for` has
  passed, on a `DELETE_SWEEP_INTERVAL` (default `5m`) loop. The transition from
  `scheduled` to `executing` MUST be atomic and conditional on the row still
  being `scheduled`, so a cancel landing in the same instant wins or loses
  cleanly and no deletion is ever attempted twice (AGENTS.md rule 11). The
  sweeper MUST act **as the member who scheduled it** — audit rows for the
  execution name that member, not `system` (`D-11`).
- **FR-DEL-26** — The sweeper MUST re-run **every** authorization and guard
  check against state read fresh at execution time. A deletion that is no
  longer permissible — the title became `protected`, somebody started watching
  it during the window, playback data is unavailable (`FR-DEL-21`), or the
  member gained a co-claimant — MUST be **cancelled**, not performed and not
  merely deferred. This is what makes the grace period a genuine safety
  mechanism rather than a delay.
- **FR-DEL-27** — Bytes under a pending deletion MUST be credited to the member
  **immediately at schedule time**, so somebody clearing space can request again
  in the same sitting rather than waiting out the grace period. Effective usage
  is `SUM(active claims) − SUM(bytes_claimed of scheduled deletions)`, clamped
  at zero, and is the figure used by the member dashboard, the admin dashboard,
  and enforcement alike. The `claim` rows themselves MUST NOT be modified — the
  files are still on disk and still attributed — so the member's title list is
  unchanged and the pending-deletions pane is what explains the difference.
- **FR-DEL-28** — Cancelling MUST be refused for a **member** when restoring
  the bytes would put them over their quota, naming the shortfall. Without this,
  `FR-DEL-27`'s immediate credit is a loophole: schedule, spend the headroom,
  cancel, and sit over quota with no new request having been declined. The
  **operator MUST be exempt** — undoing a member's mistaken deletion is exactly
  the case the interlock must not obstruct.

- **FR-DEL-29** — A member MUST NOT delete files from a title whose size exceeds
  their claim's `charged_bytes` — it holds files they didn't cause (seasons that
  predate their request per `FR-ACCT-8`, or the operator's own adds). Being sole
  claimant is not enough: a real deployment hit the case where a later-season
  request (charged 0 B under `FR-ACCT-8`, since the earlier seasons predated
  it) still made that member the sole claimant on the whole series — and sole
  claimant, naively, would have let them delete seasons they never asked for
  and never paid for. The operator is exempt. Deleting just the member's own
  seasons waits on per-season attribution (`P4-1`).

- **FR-DEL-12** — Rate limit: a member MUST NOT be able to execute more than
  `DELETE_MAX_PER_HOUR` (default 25) title deletions per hour. Exceeding it is
  a denial with an audit row.
- **FR-DEL-13** — Releasing a claim MUST be reversible by the operator (re-add
  the claim), because it destroys no data. File deletion MUST NOT pretend to be.
- **FR-DEL-14** — A member MUST NOT be able to delete a title by guessing its
  id. Every id in every request MUST be validated against their own active
  claims (this is FR-DEL-1 restated as the explicit IDOR guard, because it is
  the most likely security bug in this app).

## Interactions

**Radarr** (`✓ verified` against source at the running tag `v6.1.1.10360`):
```
DELETE /api/v3/movie/{id}?deleteFiles=true&addImportExclusion=false
```

**Sonarr** (`✓ verified` against source at the running tag `v4.0.19.2979`) —
> **the parameter name is NOT the same as Radarr's.** Sonarr uses
> `addImportListExclusion`; Radarr uses `addImportExclusion`. Copying Radarr's
> name onto the Sonarr call silently fails to do what you meant.
```
DELETE /api/v3/series/{id}?deleteFiles=true&addImportListExclusion=false
```

`DELETE /api/v3/episodefile/{id}` (deferred, `P4-1`) takes **no** query
parameters — it is unconditional, and 404s cleanly on a missing id.

**Seerr** (`~ documented`):
```
DELETE /api/v1/request/{requestId}       — remove the request
DELETE /api/v1/media/{mediaId}           — clear Seerr's media record if orphaned
```

> **Season-level deletion is not supported in v1.** Sonarr's series delete
> removes the whole series. Deleting individual seasons means
> `DELETE /api/v3/episodefile/{id}` per file, which is a different and much
> fiddlier operation, and it interacts badly with the "one series = one title"
> accounting described in [[Feature-03-Usage-Accounting]] §"Edge cases"
> (multi-season TV). Members delete whole series or nothing.
> Per-season deletion is [[Backlog]] `P4-1`, together with per-season accounting.
> The UI must state this clearly on any multi-season title — someone expecting
> to drop one season and finding the whole show gone would be the worst possible
> outcome of this feature.

## Acceptance criteria

- **Given** `alice` is the sole claimant of a 12 GB unwatched movie, **when**
  they complete all three steps, **then** Radarr deletes the files, the Seerr
  request is removed, their usage drops 12 GB, and audit rows exist for
  requested and executed with the exact API call.
- **Given** `alice` and `bob` both claim a title, **when** `alice` acts,
  **then** the only action offered is "release claim", no file is touched,
  and `bob`'s share rises to the full size at the next reconcile.
- **Given** `alice` POSTs a title id they have no claim on, **when** the
  server handles it, **then** 403, nothing is deleted, and an audit row with
  `outcome = denied` names them and the id.
- **Given** a title played by `bob` four days ago, **when** `alice` (sole
  claimant) tries to delete it, **then** it is blocked with the reason and date
  shown, and the operator can override.
- **Given** a `protected` title, **when** any member tries to delete it, **then**
  blocked with the reason visible.
- **Given** six selected titles where the fourth Radarr call returns 500,
  **when** the batch executes, **then** five succeed, one is reported failed
  with its error, the summary shows 5/6, and per-title audit rows exist for all six.
- **Given** the confirm field contains anything other than `delete`, **when** the
  member submits, **then** the action is refused.
- **Given** a member has deleted 25 titles in the last hour, **when** they try a
  26th, **then** it is denied with an explanatory message and an audit row.
- **Given** Radarr deletes successfully but the Seerr request removal 500s,
  **when** the operation completes, **then** it is recorded as a partial failure
  and appears in the operator's attention list.

## Edge cases & failure modes

- **Title deleted between review and confirm** — re-validate at execute; report
  "already gone" per-title rather than erroring the batch.
- **Claim released between review and confirm** so the member is no longer sole
  claimant — re-validate at execute; downgrade that item from delete to release
  and say so in the result, rather than deleting a file they no longer solely own.
- **The member is the sole claimant but others have watched it** — allowed, with
  the warning prominent on review. Their bytes, their call; but the warning is
  what makes it a considered choice.
- **Radarr succeeds, files remain on disk** (permissions, path mismatch) — the
  usage number will not drop at the next reconcile. Detectable: a `done`
  deletion whose title still reports `sizeOnDisk > 0` two reconciles later
  should raise an operator alert.
- **Deleting the last claim on a title that other members still have requests
  for in Seerr but which never resolved** — orphaned Seerr requests should be
  reported, not silently deleted.

## Open questions

- **Should a member be able to delete something they requested but never
  watched, which someone else *has* watched?** Currently yes (sole claimant =
  authority), with a warning. The alternative — blocking on anyone else's
  playback — makes popular titles undeletable and leaves members stuck over
  quota with no path back. The `DELETE_RECENT_PLAY_DAYS` guard is the compromise:
  recent viewers are protected, historical ones are only warned about.
- **Should releasing a claim on a title nobody else claims be allowed?** No —
  that would let a member drop their usage to zero without freeing a byte, which
  is the one obvious way to game the whole system. If they are the sole
  claimant, the only exit is deletion (or asking the operator to reassign).
  This MUST be enforced, not just omitted from the UI.
