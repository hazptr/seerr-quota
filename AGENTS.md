# AGENTS.md

Guidance for AI agents (Claude Code, Codex, etc.) working in this directory.
Humans should start at [README.md](README.md) and [`wiki/Home.md`](wiki/Home.md).

## What this is

A per-user **disk quota, self-service cleanup, and audit** sidecar for Seerr
(Jellyseerr). It also talks to Radarr, Sonarr, and Jellyfin, and sits behind
whatever forward-auth reverse proxy/IdP your deployment uses (it has no
identity-provider integration of its own — see
[`wiki/Feature-01-SSO-Identity.md`](wiki/Feature-01-SSO-Identity.md)). See
[`wiki/Backlog.md`](wiki/Backlog.md) for the current build status and open
decisions. The `wiki/` is the source of truth for every requirement, default,
and decision; where the code and the wiki disagree, that is a bug in one of
them, so fix it rather than working around it.

Seerr, Radarr, Sonarr, and Jellyfin remain the source of truth for requests,
library, and playback. This app owns only what none of them do: attribution of
bytes to people, quota policy, and the audit log.

## Non-negotiable rules

1. **Read the wiki before writing code.** `wiki/Architecture.md` §"Design
   decisions" (`D-1` … `D-11`) exists so the same eleven arguments aren't had
   twice. If you disagree with one, say so and get it changed — don't quietly
   build something else.
2. **A human chooses every deletion.** No rule, timer, or heuristic in this
   app may *select* media for deletion. If you are about to add a background
   job that decides what to remove, you are building the wrong project —
   age-out policies belong in a separate tool (e.g. Maintainerr), not here.

   A confirmed deletion is not performed inline, either. It is scheduled,
   stays cancellable by its owner or an operator for `DELETE_GRACE_PERIOD`,
   and is then executed by a sweeper (`FR-DEL-22`…`FR-DEL-28`, `D-7`). That
   sweeper is the one background job permitted to delete, and only because it
   selects nothing: it executes a specific decision a specific human already
   made and declined to undo, acts as that human in the audit log, and
   re-checks every guard before it does (`FR-DEL-26`). Automated writes to
   other systems are therefore limited to: Seerr request approve/decline, and
   these already-confirmed deletions.
3. **Deletion is three explicit user actions, always** (`D-7`, `FR-DEL-5`).
   No single-click delete may exist in the UI *or the API*. Server-side
   authorization is re-checked at execute time against freshly read state
   (`FR-DEL-1`, `FR-DEL-14`) — never trusted from the client. **Cancelling is
   deliberately the opposite**: one click, no ceremony (`FR-DEL-24`). The
   friction exists to protect against destruction, so applying it to an undo
   would invert the point.
4. **Every state change writes an audit row, including denials** (`FR-AUD-1`,
   `FR-AUD-4`). The `audit` table is append-only; the codebase must contain no
   `UPDATE audit` / `DELETE FROM audit`, and there is a test for that.
5. **Enforcement fails open** (`FR-ENF-4`). On stale data, an unknown member, or
   an upstream error, **skip** — leave the request pending for a human. Never
   approve or decline on bad data.
6. **This is meant to run in production with no built-in rollback.** Treat
   container restarts, schema migrations, and changes to the reverse-proxy /
   SSO configuration as operations that need care — read whatever your
   deployment's own runbook says before doing any of those.
7. **Secrets live in `.env` only** — never in `config.yaml`, the DB, a commit,
   an audit row, or an error message (`FR-AUD-11`). Don't read another service's
   config file at runtime to get its key; copy it into `.env`.
8. **Read the APIs, not other services' SQLite files.** Direct reads of
   `db.sqlite3` / `jellyfin.db` are a documented fallback only, and must be
   marked as such where used (`wiki/Architecture.md`).
9. **Pure core, impure shell.** The attribution split (`D-3`) and the
   enforcement decision (`FR-ENF-1`) are pure functions with hand-calculated
   tests. Both the webhook and the poller call the *same* decision function so
   they cannot disagree.
10. **Additive schema changes only**, applied idempotently at boot.
11. **Never retry a `DELETE`.** A retried delete against a re-used id could
    destroy the wrong thing. Report the failure instead.
12. **Verify via the Docker `test` stage**, keep `tsc --noEmit` clean, never
    mask a failing check.
13. **Semantic versioning, release notes in `CHANGELOG.md` first.** A release
    moves the `[Unreleased]` section into a dated `[X.Y.Z]` entry before
    tagging; images publish as `X.Y.Z`, `X.Y`, `X`, and `latest` (plus a
    rolling `edge` off `main`). There is no rollback step — if a release
    ships something broken, cut a new patch release rather than re-pointing
    tags.

## Stack (decided — see `wiki/Architecture.md` §Stack)

Next.js 15 App Router + TypeScript `strict` + Drizzle + `better-sqlite3` +
Tailwind. No component library (`FR-UI-4`) — small hand-written primitives
rather than a UI framework.

## Where things are

```
README.md              what this is, status
app/                   the Next.js app
AGENTS.md              this file
wiki/Home.md           reading order — start here
wiki/Architecture.md   system map + the eleven decisions
wiki/Data-Model.md     the ten tables
wiki/Features.md       index → Feature-01 … Feature-10
wiki/Configuration.md  every setting + default
wiki/Deployment.md     compose, reverse proxy, SSO, backups
wiki/Backlog.md        the build plan (P0 → P4) + open decisions
examples/              reverse-proxy / SSO / terraform snippets referenced by wiki/Deployment.md
```

## Before you finish

- Docker `test` stage passes; `tsc --noEmit` clean.
- Every new state-changing path writes an audit row (rule 4). Check this
  explicitly — it is the easiest requirement to forget and the most expensive
  to retrofit.
- No new single-click destructive path (rule 3).
- Nothing secret is logged, rendered, or committed.
- If you changed behaviour the wiki describes, update the wiki in the same
  change. A spec that lies is worse than no spec.
