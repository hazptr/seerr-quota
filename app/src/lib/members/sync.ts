/**
 * Account sync — the reconciler entry point (`wiki/Backlog.md`,
 * `wiki/Feature-02-Account-Sync.md`). Since 0.2.0 the roster comes straight
 * from `./seerrUsers.ts` (Seerr's own user list) — there is no second,
 * independent IdP-entitlement source to reconcile against any more (the
 * Authentik integration was removed; see `CHANGELOG.md` 0.2.0). Wires that
 * list into the pure `classifyMembers` (`./classify.ts`), then upserts
 * `member` (and seeds `quota_policy` for a brand-new row), writing an audit
 * row only for an actual classification/entitlement CHANGE (`FR-SYNC-9`) and
 * always recording one `sync_run` row (`FR-SYNC-9`'s other half — every run,
 * no matter the outcome).
 *
 * **Failure isolation (`FR-SYNC-10`).** The Seerr user fetch (`seerr_users`
 * step) is wrapped in `runStep` (`src/lib/http/syncStep.ts`, never throws).
 * If it fails, the classify+upsert phase is skipped ENTIRELY this cycle —
 * `member` is not touched at all, not even read for a diff. An empty/partial
 * Seerr list would otherwise flip every `matched` member to `not_entitled`
 * — exactly the silent mass-revocation `FR-SYNC-10` exists to prevent. A
 * `sync.failed` audit row records the failure; `sync_run.ok` is `false`;
 * nothing else changes. See `test/members-sync.test.ts`'s "Seerr down"
 * suite.
 *
 * **`quota_policy.quota_bytes` is seeded `null` for every new member
 * (`FR-SYNC-5`/`FR-POL-2a`), never the resolved default.** Inheritance is
 * resolved at READ time, never materialised (`wiki/Data-Model.md`
 * §`quota_policy`'s inheritance table) — a brand-new member's row starts out
 * inheriting whatever `default_quota_bytes` currently resolves to, and stays
 * that way forever unless an operator sets an explicit override. This is
 * what lets `src/lib/quota/policy.ts`'s `setGlobalDefaultQuota` change every
 * such member's effective quota with a single `app_setting` write and no
 * fan-out. `resolveDefaultQuotaBytes` below is kept only to record what the
 * default resolved to AT CREATION TIME in this member's `member.created`
 * audit row (`after.defaultQuotaBytes`, for operator context) — it is never
 * written into `quota_policy` itself. See `./quota.ts`'s
 * `resolveEffectiveQuota` for the three-state distinction a consumer (this
 * file's own tests, and the enforcement engine) must respect.
 */
import { eq } from 'drizzle-orm';
import type { SeerrQuotaDbOrTx } from '../audit/db-handle';
import { newCorrelationId, withAudit, writeAuditRow, type AuditAction } from '../audit';
import { getConfig } from '../config';
import { getDb, type SeerrQuotaDb } from '../db';
import { appSetting, member, quotaPolicy, syncRun } from '../db/schema';
import { runStep, type StepResult } from '../http/syncStep';
import { createSeerrUsersClient, type SeerrUsersClient } from './seerrUsers';
import { classifyMembers, type OperatorConfig } from './classify';
import type { ClassifiedMember, ExistingMemberSnapshot } from './types';

export interface MemberSyncResult {
  seerrUsers: StepResult;
  classify: StepResult;
  syncRunId: number;
  classified: ClassifiedMember[];
}

/** Test seam, same shape as `src/lib/library/sync.ts`'s `LibraryAndRequestSyncDeps` — any client injected is used as-is; anything omitted is built from `getConfig()`. */
export interface MemberSyncDeps {
  seerrUsers?: SeerrUsersClient;
}

function resolveClients(deps: MemberSyncDeps): { seerrUsers: SeerrUsersClient; operatorConfig: OperatorConfig } {
  const config = getConfig();
  return {
    seerrUsers:
      deps.seerrUsers ??
      createSeerrUsersClient(
        config.upstreams.seerrUrl,
        config.secrets.seerrApiKey,
        config.scheduling.upstreamTimeoutMs,
        config.scheduling.upstreamRetries,
      ),
    operatorConfig: { adminUsers: config.identity.adminUsers },
  };
}

function loadExistingMembers(db: SeerrQuotaDb): Map<string, ExistingMemberSnapshot> {
  const rows = db.select().from(member).all();
  const snapshot = new Map<string, ExistingMemberSnapshot>();
  for (const row of rows) {
    snapshot.set(row.ssoUsername, {
      ssoUsername: row.ssoUsername,
      authentikUuid: row.authentikUuid,
      displayName: row.displayName,
      email: row.email,
      entitled: row.entitled,
      seerrUserId: row.seerrUserId,
      jellyfinUserId: row.jellyfinUserId,
      syncStatus: row.syncStatus,
      syncNote: row.syncNote,
      firstSeenAt: row.firstSeenAt,
      isOperator: row.isOperator,
    });
  }
  return snapshot;
}

/**
 * `default_quota_bytes`: `app_setting` (DB, operator-editable, once the
 * admin-settings UI exists) wins over the `config.ts` env/config.yaml seed
 * value (`wiki/Configuration.md`'s documented precedence — see
 * `src/lib/config.ts`'s header comment). Returns `null` — NOT `0` — when
 * NEITHER is set (`FR-POL-2`): `0` is the operator's own way of saying
 * "unlimited," and silently promoting an absence of a decision into that
 * decision is exactly the conflation `FR-POL-2` warns against. A `null`
 * default is still a valid, resolvable `quota_policy` row (`source:
 * 'default'`, `quota_bytes: null`) — `FR-SYNC-5` only requires the row to
 * exist, not that its value be a number; `./quota.ts`'s
 * `resolveEffectiveQuota` is what turns this into "unconfigured" for a
 * consumer that needs to branch on it.
 */
function resolveDefaultQuotaBytes(db: SeerrQuotaDb): number | null {
  const row = db.select().from(appSetting).where(eq(appSetting.key, 'default_quota_bytes')).get();
  if (row) {
    try {
      const parsed = JSON.parse(row.value);
      if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed;
    } catch {
      // fall through to the config-seed value below
    }
  }
  const configured = getConfig().runtime.defaultQuotaBytes;
  return typeof configured === 'number' ? configured : null;
}

function upsertMemberRow(dbOrTx: SeerrQuotaDbOrTx, next: ClassifiedMember, nowSeconds: number): void {
  dbOrTx
    .insert(member)
    .values({
      ssoUsername: next.ssoUsername,
      authentikUuid: next.authentikUuid,
      displayName: next.displayName,
      email: next.email,
      entitled: next.entitled,
      seerrUserId: next.seerrUserId,
      jellyfinUserId: next.jellyfinUserId,
      syncStatus: next.syncStatus,
      syncNote: next.syncNote,
      firstSeenAt: next.firstSeenAt,
      lastSyncedAt: nowSeconds,
      isOperator: next.isOperator,
    })
    .onConflictDoUpdate({
      target: member.ssoUsername,
      set: {
        authentikUuid: next.authentikUuid,
        displayName: next.displayName,
        email: next.email,
        entitled: next.entitled,
        seerrUserId: next.seerrUserId,
        jellyfinUserId: next.jellyfinUserId,
        syncStatus: next.syncStatus,
        syncNote: next.syncNote,
        lastSyncedAt: nowSeconds,
        isOperator: next.isOperator,
        // firstSeenAt deliberately absent — never overwritten once set.
      },
    })
    .run();
}

/**
 * `FR-SYNC-5`/`FR-POL-2a`: seeds a brand-new member's `quota_policy` row
 * with `quotaBytes: null` — ALWAYS, regardless of what `default_quota_bytes`
 * currently resolves to. Inheritance is resolved at read time (see this
 * file's header comment); materialising today's default here would mean a
 * future default change needs a fan-out write to reach this member, exactly
 * what `FR-POL-2a` forbids.
 */
function ensureDefaultQuotaPolicy(dbOrTx: SeerrQuotaDbOrTx, ssoUsername: string, nowSeconds: number): void {
  dbOrTx
    .insert(quotaPolicy)
    .values({
      ssoUsername,
      quotaBytes: null,
      source: 'default',
      note: null,
      updatedAt: nowSeconds,
      updatedBy: 'system',
    })
    // Never touches an existing row — an operator override must survive
    // untouched (FR-SYNC-5 only requires a quota to exist, never that this
    // sync keeps rewriting it).
    .onConflictDoNothing({ target: quotaPolicy.ssoUsername })
    .run();
}

function hasClassificationChanged(existing: ExistingMemberSnapshot | undefined, next: ClassifiedMember): boolean {
  if (!existing) return true;
  return existing.syncStatus !== next.syncStatus || existing.entitled !== next.entitled;
}

/**
 * `member.created` for a brand-new row; `member.entitlement_changed` when
 * `entitled` flipped; `member.sync_changed` for any other classification
 * change (e.g. `matched` -> `ambiguous` on an orphan-key collision, with
 * `entitled` staying `true` throughout). Exactly one action per changed
 * member per cycle — see this file's header comment on why `withAudit` (one
 * call per member, not a shared batch transaction) is what makes this safe
 * to skip on a no-op cycle without touching `AGENTS.md` rule 4.
 */
function auditActionFor(existing: ExistingMemberSnapshot | undefined, next: ClassifiedMember): AuditAction {
  if (!existing) return 'member.created';
  if (existing.entitled !== next.entitled) return 'member.entitlement_changed';
  return 'member.sync_changed';
}

/**
 * Persists every classified member. `FR-SYNC-9`: audit only when this
 * member's classification/entitlement actually changed — a routine no-op
 * cycle still refreshes `last_synced_at`/linkage fields via a plain write
 * (no transaction, no audit call), so the log doesn't fill up every 15
 * minutes. A changed member goes through `withAudit` — its own transaction,
 * `audit()` called exactly once — per `FR-AUD-8`/`AGENTS.md` rule 4.
 */
function persistClassifiedMembers(
  db: SeerrQuotaDb,
  classified: ClassifiedMember[],
  existingMembers: Map<string, ExistingMemberSnapshot>,
  defaultQuotaBytes: number | null,
  nowSeconds: number,
): void {
  for (const next of classified) {
    const existing = existingMembers.get(next.ssoUsername);
    const changed = hasClassificationChanged(existing, next);

    if (!changed) {
      upsertMemberRow(db, next, nowSeconds);
      continue;
    }

    withAudit(db, ({ tx, audit }) => {
      upsertMemberRow(tx, next, nowSeconds);
      if (next.isNew) {
        ensureDefaultQuotaPolicy(tx, next.ssoUsername, nowSeconds);
      }
      audit({
        actor: 'system',
        actorRole: 'system',
        action: auditActionFor(existing, next),
        targetType: 'member',
        targetId: next.ssoUsername,
        before: existing ? { entitled: existing.entitled, syncStatus: existing.syncStatus } : null,
        after: {
          entitled: next.entitled,
          syncStatus: next.syncStatus,
          syncNote: next.syncNote,
          ...(next.isNew ? { defaultQuotaBytes } : {}),
        },
        outcome: 'ok',
        source: 'cron',
      });
    });
  }
}

/**
 * The P1-3 reconcile step. Deps are injectable (test seam); when omitted,
 * real clients are built from `getConfig()`. Never throws — every upstream
 * failure is captured in the returned `StepResult`s and in the `sync_run`
 * row, per `runStep`'s contract and this file's header comment.
 */
export async function syncMembers(deps: MemberSyncDeps = {}, nowSeconds: number = Math.floor(Date.now() / 1000)): Promise<MemberSyncResult> {
  const { seerrUsers, operatorConfig } = resolveClients(deps);
  const db = getDb();
  const startedAt = Math.floor(Date.now() / 1000);

  const { result: seerrUsersStep, items: seerrUserList } = await runStep(() => seerrUsers.listAllUsers());

  let classifyStep: StepResult;
  let classified: ClassifiedMember[] = [];

  if (seerrUsersStep.ok) {
    const classifyStart = Date.now();
    try {
      const existingMembers = loadExistingMembers(db);
      classified = classifyMembers(seerrUserList, existingMembers, nowSeconds, operatorConfig);
      const defaultQuotaBytes = resolveDefaultQuotaBytes(db);
      persistClassifiedMembers(db, classified, existingMembers, defaultQuotaBytes, nowSeconds);
      classifyStep = { ok: true, count: classified.length, ms: Date.now() - classifyStart };
    } catch (err) {
      classifyStep = {
        ok: false,
        count: 0,
        ms: Date.now() - classifyStart,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  } else {
    // FR-SYNC-10: an upstream failure aborts classify+upsert entirely — `member` is left completely untouched.
    classifyStep = {
      ok: false,
      count: 0,
      ms: 0,
      error: `skipped: seerr_users step failed (${seerrUsersStep.error})`,
    };
  }

  if (!classifyStep.ok) {
    writeAuditRow(db, {
      actor: 'system',
      actorRole: 'system',
      action: 'sync.failed',
      outcome: 'error',
      source: 'cron',
      correlationId: newCorrelationId(),
      detail: {
        step: !seerrUsersStep.ok ? 'seerr_users' : 'classify',
        error: classifyStep.error,
      },
    });
  }

  const finishedAt = Math.floor(Date.now() / 1000);
  // Step keys deliberately stay as a plain, dynamically-rendered record
  // (`SyncStatusPane` iterates whatever's in this JSON — no hardcoded step
  // name list) — a pre-0.2.0 `sync_run` row's extra `identity` step key
  // still renders fine; new rows simply don't produce one.
  const steps: Record<string, StepResult> = { seerr_users: seerrUsersStep, classify: classifyStep };
  const ok = Object.values(steps).every((s) => s.ok);
  const runRow = db
    .insert(syncRun)
    .values({ startedAt, finishedAt, steps: JSON.stringify(steps), ok })
    .returning({ id: syncRun.id })
    .get();

  return { seerrUsers: seerrUsersStep, classify: classifyStep, syncRunId: runRow.id, classified };
}
