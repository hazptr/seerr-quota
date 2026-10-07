/**
 * `FR-ADM-11` — settings editing. Two distinct write paths, deliberately
 * separate:
 *
 *   - `setNumericSetting`: the six plain `app_setting` values named in this
 *     task's brief (`grace_bytes`, `delete_recent_play_days`,
 *     `stale_snapshot_max_age_s`, `delete_max_per_hour`, `hold_max_days`,
 *     `notify_cooldown_s`). One `setting.changed` audit row each, matching
 *     the vocabulary (`wiki/Feature-08-Audit-Log.md`).
 *   - `setEnforcementEnabled`: `enforcement_enabled` gets its OWN action
 *     (`enforcement.toggled`, not `setting.changed`) and its own guard —
 *     "the switch that changes production behaviour for real people" per
 *     the project's design. Turning it ON is refused outright when
 *     `default_quota_bytes` is unset, the same rule
 *     `src/lib/config.ts`'s `validateConfig` enforces at boot (`FR-POL-2a`) —
 *     this module doesn't import that boot check (out of this task's scope
 *     to touch `src/lib/config.ts`), it re-applies the identical rule via
 *     `getGlobalDefaultQuotaBytes(db) === null`, so the running app can never
 *     reach a state its own boot validator would refuse to start in.
 *
 * `default_quota_bytes` itself is NOT handled here — that's
 * `setGlobalDefaultQuota` in `@/lib/quota/policy.ts` (`FR-ADM-6`'s "quota
 * set/clear", called directly from
 * `src/app/api/admin/quota/default/route.ts`), not part of `FR-ADM-11`'s
 * list.
 *
 * Lives under `app/src/app/admin/_actions/`, not `src/lib/quota/**` — that
 * module's own header comment says the `enforcement_enabled`/generic-setting
 * writers were deliberately not built there.
 */
import { eq } from 'drizzle-orm';
import { withAudit } from '@/lib/audit';
import { getConfig } from '@/lib/config';
import type { SeerrQuotaDb } from '@/lib/db';
import { appSetting } from '@/lib/db/schema';
import { getGlobalDefaultQuotaBytes, validateGraceBytes } from '@/lib/quota';
import { resolveNumericRuntimeSetting } from '@/components/member/logic';
import {
  countMembersCurrentlyOverQuota,
  resolveBooleanRuntimeSetting,
  validateNonNegativeIntegerSetting,
  type EditableNumericSettingKey,
} from '@/components/admin/logic';
import { loadAdminDashboard } from '../_data/dashboard';

function configFallbackFor(key: EditableNumericSettingKey): number {
  const runtime = getConfig().runtime;
  switch (key) {
    case 'grace_bytes':
      return runtime.graceBytes;
    case 'delete_recent_play_days':
      return runtime.deleteRecentPlayDays;
    case 'stale_snapshot_max_age_s':
      return runtime.staleSnapshotMaxAgeS;
    case 'delete_max_per_hour':
      return runtime.deleteMaxPerHour;
    case 'hold_max_days':
      return runtime.holdMaxDays;
    case 'notify_cooldown_s':
      return runtime.notifyCooldownS;
  }
}

function readCurrentNumericSetting(db: SeerrQuotaDb, key: EditableNumericSettingKey): number {
  const row = db.select().from(appSetting).where(eq(appSetting.key, key)).get();
  return resolveNumericRuntimeSetting(row, configFallbackFor(key));
}

export type SettingWriteOutcome = { kind: 'ok'; before: number; after: number } | { kind: 'invalid'; reason: string };

export function setNumericSetting(db: SeerrQuotaDb, input: { key: EditableNumericSettingKey; value: number; actor: string }): SettingWriteOutcome {
  if (input.key === 'grace_bytes') {
    const check = validateGraceBytes(input.value, getGlobalDefaultQuotaBytes(db));
    if (!check.valid) return { kind: 'invalid', reason: check.reason };
  } else {
    const check = validateNonNegativeIntegerSetting(input.value, input.key);
    if (!check.valid) return { kind: 'invalid', reason: check.reason };
  }

  const before = readCurrentNumericSetting(db, input.key);
  const now = Math.floor(Date.now() / 1000);

  withAudit(db, ({ tx, audit }) => {
    tx.insert(appSetting)
      .values({ key: input.key, value: JSON.stringify(input.value), updatedAt: now, updatedBy: input.actor })
      .onConflictDoUpdate({ target: appSetting.key, set: { value: JSON.stringify(input.value), updatedAt: now, updatedBy: input.actor } })
      .run();
    audit({
      actor: input.actor,
      actorRole: 'operator',
      action: 'setting.changed',
      targetType: 'setting',
      targetId: input.key,
      before: { value: before },
      after: { value: input.value },
      outcome: 'ok',
      source: 'ui',
    });
  });

  return { kind: 'ok', before, after: input.value };
}

export interface EnforcementPreview {
  currentlyEnabled: boolean;
  defaultQuotaConfigured: boolean;
  /** Members currently over their effective quota, right now — `FR-ADM-11`'s "how many members would be affected right now", reusing the FR-POL-4 preview machinery (`@/components/admin/logic`'s `countMembersCurrentlyOverQuota`, see its own header comment for why it's built on the member table's already-correct `state`, not a bare re-run of `isOverQuota`). */
  affectedCount: number;
  affectedUsernames: string[];
}

/** Read-only — computes the confirmation data `POST .../enforcement` also embeds in its audit row, so the preview a caller showed and the row that lands can never disagree (both call this same function). */
export async function previewEnforcementToggle(db: SeerrQuotaDb): Promise<EnforcementPreview> {
  const enforcementRow = db.select().from(appSetting).where(eq(appSetting.key, 'enforcement_enabled')).get();
  const currentlyEnabled = resolveBooleanRuntimeSetting(enforcementRow, getConfig().runtime.enforcementEnabled);
  const defaultQuotaConfigured = getGlobalDefaultQuotaBytes(db) !== null;

  const dashboard = await loadAdminDashboard();
  const { count, usernames } = dashboard.kind === 'ok' ? countMembersCurrentlyOverQuota(dashboard.members) : { count: 0, usernames: [] };

  return { currentlyEnabled, defaultQuotaConfigured, affectedCount: count, affectedUsernames: usernames };
}

export type EnforcementToggleOutcome =
  | { kind: 'ok'; before: boolean; after: boolean; affectedCount: number; affectedUsernames: string[] }
  | { kind: 'invalid'; reason: string };

export async function setEnforcementEnabled(db: SeerrQuotaDb, input: { enabled: boolean; actor: string }): Promise<EnforcementToggleOutcome> {
  const preview = await previewEnforcementToggle(db);

  // FR-ADM-11: "must also refuse to enable when default_quota_bytes is
  // unset — the same rule boot validation enforces." Only the ON direction
  // is gated — disabling never needs a decided default.
  if (input.enabled && !preview.defaultQuotaConfigured) {
    return {
      kind: 'invalid',
      reason:
        'default_quota_bytes is not set — enforcement cannot be enabled until a default quota is configured (the same rule src/lib/config.ts boot validation enforces, FR-POL-2a)',
    };
  }

  const now = Math.floor(Date.now() / 1000);

  withAudit(db, ({ tx, audit }) => {
    tx.insert(appSetting)
      .values({ key: 'enforcement_enabled', value: JSON.stringify(input.enabled), updatedAt: now, updatedBy: input.actor })
      .onConflictDoUpdate({ target: appSetting.key, set: { value: JSON.stringify(input.enabled), updatedAt: now, updatedBy: input.actor } })
      .run();
    audit({
      actor: input.actor,
      actorRole: 'operator',
      action: 'enforcement.toggled',
      targetType: 'setting',
      targetId: 'enforcement_enabled',
      before: { enabled: preview.currentlyEnabled },
      after: { enabled: input.enabled },
      outcome: 'ok',
      source: 'ui',
      detail: { affectedCount: preview.affectedCount, affectedUsernames: preview.affectedUsernames },
    });
  });

  return { kind: 'ok', before: preview.currentlyEnabled, after: input.enabled, affectedCount: preview.affectedCount, affectedUsernames: preview.affectedUsernames };
}
