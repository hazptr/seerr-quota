/**
 * Attribution sync — the P1-6 reconcile step (`wiki/Architecture.md`
 * §Reconciler step 5: "join the above into per-title, per-member claims
 * (`D-3`), write the snapshot"). The impure shell around `./compute.ts`'s
 * pure core: reads the current `title`/`member` rows and the current Seerr
 * request list, resolves requesters (`./resolveMembers.ts`), computes the
 * claim set, and persists it to `claim` — mirroring the shape
 * `../library/sync.ts` (`runLibraryAndRequestSync`) and `../playback/sync.ts`
 * (`runPlaybackSync`) already established: `runStep`-wrapped, one `sync_run`
 * row per cycle.
 *
 * **`FR-ACCT-10` — partial-upstream tolerance.** Two distinct failure
 * surfaces, handled differently:
 *
 *   1. **Seerr itself is unreachable** (the `requests` step, wrapping
 *      `../seerr/sync.ts`'s `syncRequests`, already `runStep`-wrapped there
 *      and never throws). When it fails, attribution is SKIPPED ENTIRELY
 *      this cycle — `claim` is left completely untouched. This mirrors
 *      `../members/sync.ts`'s "either upstream step fails -> skip the whole
 *      classify+upsert phase" discipline, for the same reason: recomputing
 *      the FULL active-claim set from a request list this app knows is
 *      incomplete would deactivate every claim whose backing request didn't
 *      happen to be in whatever partial data came back — silently zeroing
 *      real usage. That's exactly the failure the project's design calls a
 *      quota-bypass risk ("your usage dropped to 0 would let an over-quota
 *      member straight through the enforcement gate"). See
 *      `test/attribution-sync.test.ts`'s "Seerr down" suite.
 *   2. **Radarr/Sonarr/Jellyfin were unreachable during an EARLIER sync
 *      cycle** (`../library/sync.ts`/`../playback/sync.ts`, out of this
 *      task's scope). This never surfaces here as a failure at all: those
 *      modules leave an affected `title` row's `size_bytes` and
 *      `last_synced_at` completely untouched on a partial failure (never
 *      zeroed, never deleted — see their own header comments), so this
 *      step, which only ever reads the CURRENT `title` table, automatically
 *      keeps charging a title's last-known real size. No special-casing
 *      needed here — see `test/attribution-sync.test.ts`'s
 *      "stale-but-nonzero title" case, which pins this without needing to
 *      simulate an actual Sonarr outage.
 *
 * **`invariant.violated` (`FR-ACCT-3`).** Before persisting, every computed
 * claim is checked against `./compute.ts`'s `findInvariantViolations`
 * (`charged_bytes == title.size_bytes`). This can never actually fire from
 * `computeAttribution`'s own construction — it is a defensive safety net,
 * per the project's design ("Assert ... Write audit rows only where the spec
 * calls for them — notably `invariant.violated` if the assertion ever
 * fails"). A violating claim is EXCLUDED from persistence (fail safe: never
 * write a byte count that fails its own invariant) and one `invariant.violated`
 * audit row is written per violation, `target_type: 'title'` (matching
 * `wiki/Feature-08-Audit-Log.md`'s vocabulary table exactly).
 *
 * **`FR-ACCT-4` — unresolved requests, "visible to the operator."**
 * `wiki/Data-Model.md`'s ten tables have no dedicated table for this, and
 * schema changes are out of scope. There is also no fitting entry in the
 * FIXED 21-action audit vocabulary (`src/lib/audit/actions.ts`) — an
 * unresolved request is a data-quality observation, not a state-changing
 * action, so misusing e.g. `sync.failed` for it would be wrong (nothing
 * failed; the join is legitimately empty) and would corrupt that action's
 * meaning for its real callers. So this is surfaced three ways: (a)
 * returned in full on `AttributionSyncResult.unresolved`/
 * `unmatchedRequesters`; (b) one structured `console.warn` JSON line per
 * unresolved request, the same "stdout is a second, independent copy"
 * discipline `wiki/Data-Model.md` §audit documents for audit rows; and (c)
 * PERSISTED as `unresolvedCount`/`unmatchedRequesterCount` on the
 * `attribution` step written into `sync_run.steps` — additively, alongside
 * the standard `{ok,count,ms,error}` shape, and read defensively by
 * `src/components/admin/logic.ts`'s `readAttributionStepExtras` (which was
 * already written to expect exactly this shape). This is what makes the
 * count durable across a process restart and visible to the admin "needs
 * attention" panel (`FR-ADM-4`), not just to a synchronous caller of this
 * function. Only written when the attribution step actually ran
 * (`requestsStep.ok`) — never a misleading `0` on a skipped/failed cycle,
 * where there is no real count to report.
 */
import { eq } from 'drizzle-orm';
import { newCorrelationId, writeAuditRow } from '../audit';
import { getConfig } from '../config';
import { getDb, type SeerrQuotaDb } from '../db';
import { claim, member, syncRun, title } from '../db/schema';
import { runStep, type StepResult } from '../http/syncStep';
import { createSeerrClient, type SeerrClient } from '../seerr/client';
import { syncRequests } from '../seerr/sync';
import { createSonarrEpisodeFileClient, type SonarrEpisodeFileClient } from '../library/sonarrEpisodeFiles';
import { buildTitlesById, computeAttribution, computeFleetDistinctTitleTotal, findInvariantViolations } from './compute';
import { resolveRequestMembers, type UnmatchedSeerrRequester } from './resolveMembers';
import type { AttributionClaim, AttributionTitleInput, UnresolvedRequest } from './types';

export interface AttributionSyncDeps {
  seerr?: SeerrClient;
  /** `FR-ACCT-8` — injectable so tests never reach a real Sonarr. */
  sonarrEpisodeFiles?: SonarrEpisodeFileClient;
}

function resolveEpisodeFileClient(deps: AttributionSyncDeps): SonarrEpisodeFileClient {
  if (deps.sonarrEpisodeFiles) return deps.sonarrEpisodeFiles;
  const config = getConfig();
  return createSonarrEpisodeFileClient(config.upstreams.sonarrUrl, config.secrets.sonarrApiKey, config.scheduling.upstreamTimeoutMs, config.scheduling.upstreamRetries);
}

/**
 * `FR-ACCT-4`: the `attribution` `sync_run.steps` entry, additively extended
 * with the two counts `src/components/admin/logic.ts`'s
 * `readAttributionStepExtras` already reads defensively (`unresolvedCount`/
 * `unmatchedRequesterCount`, both optional numeric fields). Only ever built
 * when the attribution step actually ran — see `runAttributionSync` below.
 */
interface AttributionStepPersisted extends StepResult {
  unresolvedCount?: number;
  unmatchedRequesterCount?: number;
}

export interface AttributionSyncResult {
  requests: StepResult;
  attribution: StepResult;
  /** `FR-ACCT-4` — never dropped. See this file's header comment for how "visible to the operator" is satisfied today. */
  unresolved: UnresolvedRequest[];
  /** Should never be non-empty in practice — see `./resolveMembers.ts`'s header comment. Surfaced, never dropped, for the same reason `unresolved` is. */
  unmatchedRequesters: UnmatchedSeerrRequester[];
  /** `FR-ACCT-3` — the number that must never come from summing per-member totals. */
  fleetDistinctTitleBytes: number;
  syncRunId: number;
}

function resolveSeerrClient(deps: AttributionSyncDeps): SeerrClient {
  if (deps.seerr) return deps.seerr;
  const config = getConfig();
  return createSeerrClient(
    config.upstreams.seerrUrl,
    config.secrets.seerrApiKey,
    config.scheduling.upstreamTimeoutMs,
    config.scheduling.upstreamRetries,
  );
}

function loadTitles(db: SeerrQuotaDb): AttributionTitleInput[] {
  return db
    .select()
    .from(title)
    .all()
    .map((t) => ({
      id: t.id,
      mediaType: t.mediaType,
      tmdbId: t.tmdbId,
      tvdbId: t.tvdbId,
      sizeBytes: t.sizeBytes,
      addedAt: t.addedAt,
      arrInstance: t.arrInstance,
      arrId: t.arrId,
      lastSyncedAt: t.lastSyncedAt,
    }));
}

/**
 * `FR-ACCT-8` — attach per-file acquisition dates, but only where they can
 * possibly change the answer.
 *
 * A claim can only contain bytes the requester didn't cause if the title was
 * already on disk BEFORE they asked. `title.added_at < earliest request` is
 * therefore a complete pre-filter, and a cheap one: it is already in the local
 * DB. Everything it excludes is a title acquired at or after the request, i.e.
 * one the requester is fully answerable for — no upstream call needed.
 *
 * That matters. Fetching episode files for the whole library would be ~97
 * extra Sonarr calls every reconcile; in practice this fetches for a handful
 * of series, and usually none. Movies need no call at all: a movie is a single
 * acquisition, so `added_at` alone settles it.
 *
 * Any upstream failure is swallowed per-title and simply leaves `files`
 * unset — which falls back to charging the full size, the pre-FR-ACCT-8
 * behaviour. A Sonarr hiccup must never silently zero somebody's usage.
 */
async function attachPreexistingFileData(
  titles: AttributionTitleInput[],
  latestCutoffByTitleId: Map<string, number>,
  getEpisodeFiles: () => SonarrEpisodeFileClient,
): Promise<void> {
  // Constructed lazily and at most once. On a normal run NOTHING needs file
  // data, and building an upstream client (which resolves config and would
  // fail on an incomplete one) for a fetch that never happens is both wasteful
  // and a needless failure mode for the whole attribution step.
  let episodeFiles: SonarrEpisodeFileClient | undefined;

  for (const t of titles) {
    const latest = latestCutoffByTitleId.get(t.id);
    if (latest === undefined) continue;
    // The LATEST cutoff among this title's claimants: if even the most recent
    // requester predates the title, nobody's charge can contain pre-existing
    // bytes and the fetch is pointless.
    if (t.addedAt === null || t.addedAt === undefined || t.addedAt >= latest) continue;

    // MOVIES ARE DELIBERATELY EXCLUDED. It is tempting to say "the movie was
    // added before the request, so none of it is theirs" — that is wrong.
    // `title.added_at` is the *arr's* add date, not the file's: a movie can
    // sit in Radarr monitored-but-missing for years and only download when
    // somebody finally requests it. Answering this for a movie needs the
    // movieFile's own `dateAdded`, which this pre-filter doesn't have.
    //
    // Not worth fetching for: a movie is a single acquisition, Seerr marks an
    // already-present movie Available rather than letting it be re-requested,
    // and a sweep of real-world claims found zero affected movies against a
    // small number of affected series. Movies keep the full-size charge.
    if (t.mediaType !== 'tv') continue;

    try {
      episodeFiles ??= getEpisodeFiles();
      const files = await episodeFiles.listEpisodeFiles(t.arrId ?? 0);
      t.files = files.map((f: { dateAdded: number | null; size: number }) => ({
        // A file with no parseable date is treated as pre-existing (epoch 0),
        // never as caused-by-them — the direction that can't invent a charge.
        addedAt: f.dateAdded ?? 0,
        sizeBytes: f.size,
      }));
    } catch {
      // Leave `files` unset -> full-size charge, as before.
    }
  }
}

function loadMembersForResolve(db: SeerrQuotaDb): { ssoUsername: string; seerrUserId: number | null }[] {
  return db
    .select({ ssoUsername: member.ssoUsername, seerrUserId: member.seerrUserId })
    .from(member)
    .all();
}

interface ExistingClaimRow {
  id: number;
  titleId: string;
  ssoUsername: string;
}

/** Every currently-ACTIVE claim row, indexed `${titleId}::${ssoUsername}` (the pair `claim` is keyed on — `wiki/Data-Model.md` §claim). */
function loadActiveClaims(db: SeerrQuotaDb): Map<string, ExistingClaimRow> {
  const rows = db.select({ id: claim.id, titleId: claim.titleId, ssoUsername: claim.ssoUsername }).from(claim).where(eq(claim.active, true)).all();
  const idx = new Map<string, ExistingClaimRow>();
  for (const r of rows) idx.set(`${r.titleId}::${r.ssoUsername}`, r);
  return idx;
}

/**
 * Persists the desired-state active-claim set for this cycle: upserts every
 * computed claim (updating `charged_bytes`/`seerr_request_id` in place if a
 * claim for this (title, member) pair was already active), then deactivates
 * any PREVIOUSLY-active claim not recomputed this cycle.
 *
 * `FR-ACCT-7`: a claim only ever disappears here because its own backing
 * request stopped resolving/being chargeable, or the title's size changed —
 * never because of another member's action (each pair is independent by
 * construction: `computeAttribution` groups strictly per `(titleId,
 * ssoUsername)`, so recomputing member A's claims can never touch the row
 * this function writes for member B). Deactivation here is a SYSTEM
 * reconciliation, not a member "release" (`D-6`) — `released_at`/`released_by`
 * are deliberately left `null`; those columns are reserved for that
 * feature's own write path (`wiki/Data-Model.md` §claim), not built here.
 */
function persistClaims(db: SeerrQuotaDb, claims: AttributionClaim[], nowSeconds: number): void {
  const existingActive = loadActiveClaims(db);
  const seenPairs = new Set<string>();

  for (const c of claims) {
    const pairKey = `${c.titleId}::${c.ssoUsername}`;
    seenPairs.add(pairKey);
    const existing = existingActive.get(pairKey);
    if (existing) {
      db.update(claim)
        .set({ chargedBytes: c.chargedBytes, seerrRequestId: c.seerrRequestId })
        .where(eq(claim.id, existing.id))
        .run();
    } else {
      db.insert(claim)
        .values({
          titleId: c.titleId,
          ssoUsername: c.ssoUsername,
          seerrRequestId: c.seerrRequestId,
          chargedBytes: c.chargedBytes,
          active: true,
          createdAt: nowSeconds,
        })
        .run();
    }
  }

  for (const [pairKey, existing] of existingActive) {
    if (seenPairs.has(pairKey)) continue;
    db.update(claim).set({ active: false }).where(eq(claim.id, existing.id)).run();
  }
}

/** See this file's header comment ("`FR-ACCT-4` ... 'visible to the operator'"). */
function logUnresolved(unresolved: UnresolvedRequest[], unmatched: UnmatchedSeerrRequester[]): void {
  for (const u of unresolved) {
    console.warn(JSON.stringify({ event: 'attribution.unresolved_request', ...u }));
  }
  for (const u of unmatched) {
    console.warn(JSON.stringify({ event: 'attribution.unmatched_requester', ...u }));
  }
}

function recordSyncRun(steps: Record<string, StepResult>, startedAtSeconds: number, finishedAtSeconds: number): number {
  const db = getDb();
  const ok = Object.values(steps).every((s) => s.ok);
  const row = db
    .insert(syncRun)
    .values({ startedAt: startedAtSeconds, finishedAt: finishedAtSeconds, steps: JSON.stringify(steps), ok })
    .returning({ id: syncRun.id })
    .get();
  return row.id;
}

/**
 * The P1-6 reconcile step. Deps are injectable (test seam, same shape as
 * `../library/sync.ts`/`../playback/sync.ts`); when omitted, a real Seerr
 * client is built from `getConfig()`. Never throws — every failure is
 * captured in the returned `StepResult`s and in the `sync_run` row.
 */
export async function runAttributionSync(
  deps: AttributionSyncDeps = {},
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<AttributionSyncResult> {
  const db = getDb();
  const startedAt = Math.floor(Date.now() / 1000);
  const seerr = resolveSeerrClient(deps);

  const { step: requestsStep, requests } = await syncRequests(seerr);

  let attributionStep: StepResult;
  let unresolved: UnresolvedRequest[] = [];
  let unmatchedRequesters: UnmatchedSeerrRequester[] = [];
  let fleetDistinctTitleBytes = 0;

  if (requestsStep.ok) {
    const { result } = await runStep(async () => {
      const titles = loadTitles(db);
      const members = loadMembersForResolve(db);
      const { resolved, unmatched } = resolveRequestMembers(requests, members);
      unmatchedRequesters = unmatched;

      // FR-ACCT-8, pass 1: resolve requests to titles so we know which
      // (title, member) pairs exist and what each one's EARLIEST request was
      // — the cutoff `chargeableBytes` needs. Title matching lives inside the
      // pure core, so there is no cheaper way to learn it.
      const firstPass = computeAttribution(resolved, titles);

      const createdAtByRequestId = new Map(resolved.map((r) => [r.seerrRequestId, r.createdAt]));
      const latestCutoffByTitleId = new Map<string, number>();
      for (const c of firstPass.claims) {
        const cutoff = createdAtByRequestId.get(c.seerrRequestId);
        if (cutoff === undefined) continue;
        const prev = latestCutoffByTitleId.get(c.titleId);
        if (prev === undefined || cutoff > prev) latestCutoffByTitleId.set(c.titleId, cutoff);
      }

      // Fetches per-file dates ONLY for titles that were on disk before
      // somebody requested them. Usually zero calls; today, two series.
      await attachPreexistingFileData(titles, latestCutoffByTitleId, () => resolveEpisodeFileClient(deps));

      // Pass 2: same pure function, same inputs, now with `files` attached
      // where it matters — so a requester is charged only for what they
      // actually caused.
      const attribution = computeAttribution(resolved, titles);
      unresolved = attribution.unresolved;

      const titlesById = buildTitlesById(titles);
      const violations = findInvariantViolations(attribution.claims, titlesById);
      const validClaims = violations.length
        ? attribution.claims.filter((c) => !violations.some((v) => v.titleId === c.titleId && v.ssoUsername === c.ssoUsername))
        : attribution.claims;

      for (const v of violations) {
        writeAuditRow(db, {
          actor: 'system',
          actorRole: 'system',
          action: 'invariant.violated',
          targetType: 'title',
          targetId: v.titleId,
          outcome: 'error',
          source: 'cron',
          correlationId: newCorrelationId(),
          detail: { ssoUsername: v.ssoUsername, chargedBytes: v.chargedBytes, expectedBytes: v.expectedBytes },
        });
      }

      persistClaims(db, validClaims, nowSeconds);
      fleetDistinctTitleBytes = computeFleetDistinctTitleTotal(validClaims, titlesById);
      logUnresolved(unresolved, unmatchedRequesters);

      return validClaims;
    });
    attributionStep = result;
  } else {
    // FR-ACCT-10: Seerr unreachable — see this file's header comment. `claim`
    // is left completely untouched; nothing is deactivated or zeroed.
    attributionStep = { ok: false, count: 0, ms: 0, error: `skipped: requests step failed (${requestsStep.error ?? 'unknown error'})` };
    writeAuditRow(db, {
      actor: 'system',
      actorRole: 'system',
      action: 'sync.failed',
      outcome: 'error',
      source: 'cron',
      correlationId: newCorrelationId(),
      detail: { step: 'requests', error: requestsStep.error },
    });
  }

  // FR-ACCT-4: persist the unresolved/unmatched counts onto the `attribution`
  // step, additively — only when the step actually ran (requestsStep.ok);
  // a skipped/failed step has no real count to report, never a misleading 0.
  const attributionStepForPersist: AttributionStepPersisted | StepResult = requestsStep.ok
    ? { ...attributionStep, unresolvedCount: unresolved.length, unmatchedRequesterCount: unmatchedRequesters.length }
    : attributionStep;

  const finishedAt = Math.floor(Date.now() / 1000);
  const syncRunId = recordSyncRun({ requests: requestsStep, attribution: attributionStepForPersist }, startedAt, finishedAt);

  return { requests: requestsStep, attribution: attributionStep, unresolved, unmatchedRequesters, fleetDistinctTitleBytes, syncRunId };
}
