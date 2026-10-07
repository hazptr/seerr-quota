/**
 * `FR-ADM-11` read half: the current value of every operator-editable
 * runtime setting this task's `SettingsPane` renders. Same DB-row-or-
 * config-fallback precedence every other reader in this codebase uses
 * (`wiki/Configuration.md`: "once a value is written to `app_setting`, the
 * DB wins"). Read-only — no writes here; see
 * `@/app/admin/_actions/settingsActions.ts` for the writes themselves.
 */
import { eq } from 'drizzle-orm';
import { getConfig } from '@/lib/config';
import { getDb } from '@/lib/db';
import { appSetting } from '@/lib/db/schema';
import { getGlobalDefaultQuotaBytes } from '@/lib/quota';
import { resolveNumericRuntimeSetting } from '@/components/member/logic';
import { resolveBooleanRuntimeSetting, type EditableNumericSettingKey } from '@/components/admin/logic';

export interface CurrentSettings {
  defaultQuotaBytes: number | null;
  enforcementEnabled: boolean;
  numeric: Record<EditableNumericSettingKey, number>;
}

export function loadCurrentSettings(): CurrentSettings {
  const db = getDb();
  const config = getConfig();

  const read = (key: string) => db.select().from(appSetting).where(eq(appSetting.key, key)).get();

  const enforcementEnabled = resolveBooleanRuntimeSetting(read('enforcement_enabled'), config.runtime.enforcementEnabled);

  return {
    defaultQuotaBytes: getGlobalDefaultQuotaBytes(db),
    enforcementEnabled,
    numeric: {
      grace_bytes: resolveNumericRuntimeSetting(read('grace_bytes'), config.runtime.graceBytes),
      delete_recent_play_days: resolveNumericRuntimeSetting(read('delete_recent_play_days'), config.runtime.deleteRecentPlayDays),
      stale_snapshot_max_age_s: resolveNumericRuntimeSetting(read('stale_snapshot_max_age_s'), config.runtime.staleSnapshotMaxAgeS),
      delete_max_per_hour: resolveNumericRuntimeSetting(read('delete_max_per_hour'), config.runtime.deleteMaxPerHour),
      hold_max_days: resolveNumericRuntimeSetting(read('hold_max_days'), config.runtime.holdMaxDays),
      notify_cooldown_s: resolveNumericRuntimeSetting(read('notify_cooldown_s'), config.runtime.notifyCooldownS),
    },
  };
}
