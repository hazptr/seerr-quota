# seerr-quota — design spec

Per-user disk quotas, self-service cleanup, and a full audit trail for Seerr.

**Status: built, and in production use (current version `0.1.0`).** This
wiki is the source of truth for requirements and defaults. The code defers to
these pages; if a page and the code disagree, one of them is a bug — say
which.

## Reading order

1. **[[Architecture]]** — the system map, the data sources, and the eleven
   design decisions (`D-1` … `D-11`) that shape everything else. Read this
   first; most "why is it like that?" questions are answered here.
2. **[[Data-Model]]** — the sidecar's own SQLite schema. Small on purpose:
   everything derivable from Seerr/Radarr/Sonarr/Jellyfin is derived, not
   duplicated. The exceptions are quota policy, attribution, and the audit log.
3. **[[Features]]** — the index of the nine features, their requirement-ID
   prefixes, and how they compose.
4. **[[Configuration]]** — every setting, its default, and where it's read from.
5. **[[Deployment]]** — compose, nginx, Authentik/terraform, Gatus, backups.
6. **[[Backlog]]** — the ordered build plan, in four phases.

## The nine features

| # | Feature | Prefix |
|---|---|---|
| 1 | [[Feature-01-SSO-Identity]] | `SSO` |
| 2 | [[Feature-02-Account-Sync]] | `SYNC` |
| 3 | [[Feature-03-Usage-Accounting]] | `ACCT` |
| 4 | [[Feature-04-Quota-Policy]] | `POL` |
| 5 | [[Feature-05-Enforcement]] | `ENF` |
| 6 | [[Feature-06-Self-Service-Deletion]] | `DEL` |
| 7 | [[Feature-07-Admin-Dashboard]] | `ADM` |
| 8 | [[Feature-08-Audit-Log]] | `AUD` |
| 9 | [[Theming]] | `UI` |
| 10 | [[Feature-10-In-Seerr-Banner]] | `BAN` |

## What this is not

- **Not an age-out / retention bot.** No rule ever deletes media on a timer.
  That job is deliberately left to a separate tool (e.g.
  [Maintainerr](https://maintainerr.info/)) if you want one. If both ever run
  against the same library, they must not both be allowed to delete; see
  [[Architecture]] §"Interaction with Maintainerr".
- **Not a replacement for Seerr.** Users still browse and request in Seerr.
  This app is where they go when they're told they're out of room.
- **Not a replacement for Seerr's count quotas.** Those stay live (5 movies/7d,
  10 TV seasons/14d) as a burst limiter. See `D-1`.

## Terminology

- **Operator** — the Authentik admin / Seerr admin / server owner running the
  deployment, identified via `ADMIN_USERS` or `ADMIN_GROUP`.
- **Member** — any other Authentik user with the Seerr service binding.
- **Attribution** — the mapping from bytes on disk to the member(s) responsible
  for them. The core concept of this project; defined in [[Feature-03-Usage-Accounting]].
- **Claim** — one member's share of one title. Releasing a claim is not the same
  as deleting a file; see `D-6`.
