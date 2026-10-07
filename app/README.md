# seerr-quota — app

Next.js 15 (App Router) + TypeScript (`strict: true`) + Drizzle ORM +
`better-sqlite3` + Tailwind sidecar. See [`../wiki/`](../wiki/Home.md) for the
full design spec and [`../AGENTS.md`](../AGENTS.md) for the non-negotiable
rules. See [`../wiki/Backlog.md`](../wiki/Backlog.md) for current build
status.

## Quick start (development)

```bash
cd app
npm install
npm run dev
```

## Docker — the real verification path

Per `AGENTS.md` rule 12, "done" is measured by the Docker `test` stage, not a
host shortcut:

```bash
# Unit tests — no DB, no network required
docker build --target test -t seerr-quota-test ./app
docker run --rm seerr-quota-test

# Strict typecheck, same test-stage image (already has node_modules + source)
docker run --rm seerr-quota-test npx tsc --noEmit
```

## Smoke-testing `/healthz`

`/healthz` is unauthenticated, does no identity resolution, and makes no
upstream call — it only proves the Node process is up
(`src/app/healthz/route.ts`). To check it against a real built image without
touching any production network:

```bash
docker build -t seerr-quota:local ./app
docker run -d --rm --name seerr-quota-smoke --network none --user 1000:1000 \
  -e SEERR_API_KEY=x -e RADARR_API_KEY=x -e SONARR_API_KEY=x \
  -e JELLYFIN_API_KEY=x -e AUTHENTIK_TOKEN=x -e SEERR_WEBHOOK_SECRET=x \
  seerr-quota:local
docker exec seerr-quota-smoke node -e \
  "fetch('http://localhost:3000/healthz').then(r=>r.text()).then(console.log)"
docker stop seerr-quota-smoke
```

(`--network none` — no `-p`; publishing a port is meaningless with no
network attached anyway — plus every unconditionally-required secret set to
a placeholder is enough to pass boot validation and reach the liveness route
without touching any real Docker network or upstream; see `src/lib/config.ts`
and `src/instrumentation.ts`. `SMTP_USER`/`SMTP_PASS` are NOT needed here
since `ENFORCEMENT_ENABLED` defaults to `false` — see "Conditionally-required
secrets" below. The health check itself uses Node's built-in `fetch`
(stable since Node 18), not `wget`/`curl` — the runner image ships neither,
deliberately (see `Dockerfile`'s runner-stage comment).)

### Conditionally-required secrets

Six secrets (`SEERR_API_KEY`, `RADARR_API_KEY`, `SONARR_API_KEY`,
`JELLYFIN_API_KEY`, `AUTHENTIK_TOKEN`, `SEERR_WEBHOOK_SECRET`) are always
required — the app has no per-upstream enable/disable flag. `SMTP_USER` /
`SMTP_PASS` are required ONLY when `ENFORCEMENT_ENABLED=true`: pure
accounting sends no mail, but enforcement's over-quota "hold" outcome (`D-4a`,
`wiki/Feature-05-Enforcement.md`) can only be explained to the member via this
app's own email — Seerr's approve/decline API carries no reason — so boot
refuses to start enforcement-enabled with no working mail path
(`src/lib/config.ts`'s `validateConfig`).

## Regenerating migrations

Schema changes are **additive-only** now that this app has shipped
(`AGENTS.md` rule 10): every schema change gets a new numbered migration,
never a hand-edited or regenerated existing one — including `0000`, which is
frozen as of the first release.

```bash
npm run db:generate   # drizzle-kit generate, per drizzle.config.ts
```

This writes a new numbered SQL file under `drizzle/` — never hand-edit a
generated migration's SQL directly. `getDb()` (`src/lib/db/index.ts`)
applies every not-yet-applied migration idempotently on first DB open.

## npm install / `npm ci` gotcha: `EBADPLATFORM` on a fresh lockfile regen

If you ever need to regenerate `package-lock.json` from scratch (e.g. a
dependency bump) and hit `npm error code EBADPLATFORM` /
`Unsupported platform for @esbuild/...` during `npm ci`, this is why, and
here's the fix:

1. **The actual blocker**: `npm@10.9.8` (the version bundled in the
   `node:22-slim` image this Dockerfile builds on) crashes with
   `TypeError: Cannot read properties of null (reading 'edgesOut')` inside
   `@npmcli/arborist` when resolving `vitest@4.1.x`'s peer-dependency graph
   from scratch (no existing lockfile). This is a real npm bug, not a project
   misconfiguration — reproducible with nothing but
   `npm install vitest@4.1.10` in an empty project on that npm version.
2. **The workaround used to generate the current lockfile**: run the install
   in a throwaway container with npm upgraded first —
   `docker run --rm -v "$PWD":/app -w /app node:22-slim bash -c "npm install -g npm@11 && npm install"`.
   npm 11 doesn't hit the arborist bug.
3. **The trap**: npm 11's lockfile *writer* has its own bug — it silently
   dropped `"optional": true` on 26 nested platform-specific package entries
   (`node_modules/vitest/node_modules/@esbuild/<platform>/*` — every OS/arch
   variant vitest pulls in transitively). Those entries kept
   their `cpu`/`os` platform constraints but lost the flag marking them
   skippable, so a later `npm ci` under the image's *own* bundled npm
   (10.9.8, no arborist bug for `ci` since it's deterministic from the
   lockfile, not a fresh resolve) hard-failed with `EBADPLATFORM` on the
   *host's* platform trying to install e.g. `@esbuild/aix-ppc64` as if it
   were required.
4. **The fix, already applied**: after generating the lockfile with npm 11,
   every `packages["*"]` entry that has a `cpu` or `os` field but is missing
   `"optional": true` gets it added back before the lockfile is used. One-off
   Python snippet (adjust the path if regenerating again):
   ```bash
   python3 -c "
   import json
   d = json.load(open('package-lock.json'))
   for v in d['packages'].values():
       if (v.get('cpu') or v.get('os')) and v.get('optional') is not True:
           v['optional'] = True
   json.dump(d, open('package-lock.json', 'w'), indent=2)
   "
   ```
5. **How to tell it's needed**: after any `npm install`/`npm install -g
   npm@<newer>` step, run
   `python3 -c "import json; d=json.load(open('package-lock.json')); print(sum(1 for v in d['packages'].values() if (v.get('cpu') or v.get('os')) and v.get('optional') is not True))"`
   — a non-zero count means the fix above needs re-running before `npm ci`
   will work in the Dockerfile's `deps` stage (which uses the image's stock
   npm, not an upgraded one).

`npm ci` itself (what the Dockerfile actually runs) works fine once the
lockfile is correct — this is purely a lockfile-*generation*-time issue, not
a runtime or build issue with the correct lockfile in place.

## Deploying (do not do this without reading `../wiki/Deployment.md` first)

```bash
cd ..
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

If you're pointing this at a real environment, treat it the way `AGENTS.md`
rule 6 describes: no built-in rollback, so changes should be deliberate.
