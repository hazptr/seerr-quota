# Features

Ten features. Each has its own page with numbered, independently testable
requirements. This index gives the intent, the requirement-ID prefix, and where
the heavy lifting actually happens — the recurring theme being that this app
delegates to Seerr/Radarr/Sonarr/Jellyfin wherever they already solve the
problem, and owns only what none of them do.

| # | Feature | Intent | Prefix | Heavy lifting |
|---|---|---|---|---|
| 1 | [[Feature-01-SSO-Identity]] | Same login as every other service | `SSO` | Any forward-auth reverse proxy/IdP (0.2.0: no IdP integration of its own) |
| 2 | [[Feature-02-Account-Sync]] | Member roster, from Seerr's own user list | `SYNC` | Seerr API |
| 3 | [[Feature-03-Usage-Accounting]] | Turn "requests" into "bytes this person is responsible for" | `ACCT` | **This app** (the join Seerr can't do) |
| 4 | [[Feature-04-Quota-Policy]] | A size quota per person, set by the operator | `POL` | **This app** |
| 5 | [[Feature-05-Enforcement]] | Over quota ⇒ new requests **held**, with an obvious reason | `ENF` | Seerr approval API + **this app's** decision fn |
| 6 | [[Feature-06-Self-Service-Deletion]] | Members reclaim their own space; strictly scoped, multi-step | `DEL` | Radarr/Sonarr delete + **this app's** authz |
| 7 | [[Feature-07-Admin-Dashboard]] | Operator sees everything and sets everything | `ADM` | **This app** |
| 8 | [[Feature-08-Audit-Log]] | Every state change attributable, forever | `AUD` | **This app** |
| 9 | [[Theming]] | Looks professional out of the box, and is fully re-themeable | `UI` | Token-driven CSS, overridable via `THEME_CSS` |
| 10 | [[Feature-10-In-Seerr-Banner]] | Tell members they're out of room **inside Seerr**, where they are | `BAN` | reverse-proxy `sub_filter` |

## How they compose

```
 login ──► SSO (1) says who you are
   │
   └─► Account Sync (2) creates/links your member row from Seerr's user list
         │      (operator sees anyone not yet matched)
         │
         ├─► Quota Policy (4) says how many bytes you get
         └─► Usage Accounting (3) says how many you're using
               │   requests × sizeOnDisk × playback, each requester charged IN FULL
               │
               ├──────────────► Enforcement (5)
               │                  you request in Seerr → pending
               │                  under quota → approved
               │                  over quota  → HELD (nothing written to Seerr)
               │                       │
               │                       ├─► banner in Seerr (10)  ← primary signal
               │                       └─► email (5)             ← backstop
               │                       │
               │                  free space → next poll approves it
               │                       │
               │                       ▼
               └──────────────► Self-Service Deletion (6)
                                  "here's your 340 GB, here's what nobody
                                   has ever watched" → select → review →
                                   type-to-confirm → gone → back under
                                        │
 (operator, any time) Admin Dashboard (7): quotas, drift, protect a title,
                      delete anything, watch the whole fleet.
                                        │
 (always, everything above) ──► Audit Log (8): who, what, before, after,
                                  outcome — including every denial.

 (throughout) Theme (9): a token-driven UI, Seerr-matched default, overridable.
 (in Seerr)   Banner (10): injected by the reverse proxy's sub_filter, so the member finds out
              where they are rather than only in their inbox.
```

## Requirement conventions

Every feature page uses the same layout:

- **Summary** — what and why, in two sentences.
- **User stories** — `As a <role>, I want <capability>, so that <benefit>`.
- **Functional requirements** — numbered `FR-<prefix>-N`, each independently
  testable. `MUST` / `MUST NOT` / `SHOULD` are used in the RFC-2119 sense.
- **Interactions** — the exact endpoints, grounded in what's actually been
  verified against the live instances. Anything *not* yet verified says so.
- **Acceptance criteria** — Given/When/Then. The definition of done.
- **Edge cases & failure modes** — what must not break.
- **Open questions** — decisions still owed.

## Roles

- **Member** — any Seerr user (0.2.0) who isn't the operator. Sees only their
  own data.
- **Operator** — `admin`. Sees and sets everything; exempt from enforcement.
- **System** — the reconciler and webhook receiver acting without a human.

## Verification status of the interactions cited

Because a spec that quietly invents an endpoint is worse than one that admits a
gap, each feature page marks its API claims:

- **✓ verified** — confirmed against a live instance of the upstream service,
  or read out of its live DB/config.
- **~ documented** — in the upstream project's docs/API schema, not yet
  exercised here.
- **? unverified** — assumed, and carrying a spike in the [[Backlog]] before
  anything depends on it.
