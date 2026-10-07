/**
 * Pure logic behind the operator audit browse page + export (`FR-AUD-9`,
 * P2-7): turning raw `?query=string` params into a validated
 * `AuditBrowseFilter` (`@/lib/audit`), and turning a raw audit row into a
 * CSV line / JSONL line. No I/O, no `Date.now()` (AGENTS.md rule 9) — the
 * impure shells are `src/app/admin/audit/_data/auditBrowse.ts` (the page)
 * and `src/app/api/admin/audit/export/route.ts` (the export), both of which
 * just call these.
 */
import type { AuditBrowseFilter } from '@/lib/audit';
import { AUDIT_ACTIONS, type AuditAction } from '@/lib/audit';

// ---------------------------------------------------------------------------
// Filter form option lists. `TARGET_TYPES`/`OUTCOMES` are hand-transcribed
// from `src/lib/db/schema.ts`'s `audit.target_type`/`audit.outcome` column
// enums (same "duplicate with a comment pinning the source of truth"
// convention this codebase already uses — e.g. this file's own sibling
// `./logic.ts`'s `AdminMemberSyncStatus` mirroring `member.sync_status`)
// rather than importing them, since neither is exported as a runtime value
// from `schema.ts` (Drizzle enums are TS-level only) and this module has no
// other reason to depend on the schema module.
// ---------------------------------------------------------------------------

export const TARGET_TYPES = ['member', 'title', 'request', 'setting', 'route'] as const;
export type FilterTargetType = (typeof TARGET_TYPES)[number];

export const OUTCOMES = ['ok', 'denied', 'error'] as const;
export type FilterOutcome = (typeof OUTCOMES)[number];

function isAuditAction(value: string): value is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(value);
}

function isTargetType(value: string): value is FilterTargetType {
  return (TARGET_TYPES as readonly string[]).includes(value);
}

function isOutcome(value: string): value is FilterOutcome {
  return (OUTCOMES as readonly string[]).includes(value);
}

/** Raw string form of every filter field, exactly as it round-trips through a `<form method="get">` query string — every field optional/blank-tolerant. */
export interface AuditFilterQuery {
  actor?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  outcome?: string;
  /** `YYYY-MM-DD`, interpreted as a UTC calendar-day boundary (see `dateStringToMsBound`'s doc comment) — not `wiki/Feature-08-Audit-Log.md`'s `America/New_York` RENDER convention, which is a display concern, not a filter-boundary one. */
  from?: string;
  to?: string;
}

/**
 * `YYYY-MM-DD` -> Unix ms at that UTC day's start (`edge: 'start'`) or end
 * (`edge: 'end'`, 23:59:59.999). Returns `undefined` for a blank/malformed
 * string — a bad date filters nothing rather than throwing. Deliberately UTC
 * calendar days, not `America/New_York` ones: `FR-AUD-9` only requires a
 * time-range filter to EXIST, and a one-time-zone-offset day-boundary
 * imprecision is an acceptable simplification for a forensic filter (the
 * export always carries the exact `ts` anyway).
 */
export function dateStringToMsBound(value: string | undefined, edge: 'start' | 'end'): number | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const ms = Date.parse(`${value}T${edge === 'start' ? '00:00:00.000' : '23:59:59.999'}Z`);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Validates + narrows an `AuditFilterQuery` into the `AuditBrowseFilter` `@/lib/audit`'s reads accept. An invalid/unrecognised `action`/`targetType`/`outcome` is DROPPED (ignored), not an error — matches this codebase's "display code degrades, never throws" convention for user-suppliable query params. */
export function parseAuditFilterQuery(query: AuditFilterQuery): AuditBrowseFilter {
  const filter: AuditBrowseFilter = {};
  const actor = query.actor?.trim();
  if (actor) filter.actor = actor;
  const action = query.action?.trim();
  if (action && isAuditAction(action)) filter.action = action;
  const targetType = query.targetType?.trim();
  if (targetType && isTargetType(targetType)) filter.targetType = targetType;
  const targetId = query.targetId?.trim();
  if (targetId) filter.targetId = targetId;
  const outcome = query.outcome?.trim();
  if (outcome && isOutcome(outcome)) filter.outcome = outcome;
  const fromTs = dateStringToMsBound(query.from, 'start');
  if (fromTs !== undefined) filter.fromTs = fromTs;
  const toTs = dateStringToMsBound(query.to, 'end');
  if (toTs !== undefined) filter.toTs = toTs;
  return filter;
}

/** True iff `filter` carries at least one constraint — used to decide whether to show "no filter applied" copy. */
export function hasAnyFilter(filter: AuditBrowseFilter): boolean {
  return Object.keys(filter).length > 0;
}

// ---------------------------------------------------------------------------
// CSV / JSONL export (`FR-AUD-9`). Hand-written, no dependency (this task's
// constraint) — CSV/JSONL are both simple enough that a library buys
// nothing, and the one real trap (CSV formula/quote injection) is a few
// lines to get right explicitly.
// ---------------------------------------------------------------------------

/** The exact row shape both export formats serialize — a plain projection of `@/lib/audit`'s `RawAuditRow`, kept separate so this module doesn't need to import the Drizzle-inferred type. */
export interface AuditExportRow {
  id: number;
  ts: number;
  actor: string;
  actorRole: string;
  onBehalfOf: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  outcome: string;
  source: string;
  correlationId: string;
  before: string | null;
  after: string | null;
  detail: string | null;
}

const CSV_COLUMNS: readonly (keyof AuditExportRow)[] = [
  'id',
  'ts',
  'actor',
  'actorRole',
  'onBehalfOf',
  'action',
  'targetType',
  'targetId',
  'outcome',
  'source',
  'correlationId',
  'before',
  'after',
  'detail',
];

/**
 * One CSV field, escaped. Two independent steps, in order:
 *   1. **Formula-injection neutralisation** (this task's explicit trap):
 *      Excel/Sheets/LibreOffice treat a cell whose TEXT starts with
 *      `=`/`+`/`-`/`@` as a formula when the CSV is opened, regardless of
 *      the column's actual data type. An audit `detail` blob can contain
 *      arbitrary operator/upstream-echoed text (`before`/`after`/`detail`
 *      are free-form JSON), so any of those four leading characters gets a
 *      literal leading apostrophe prepended — the standard mitigation
 *      (spreadsheet apps render a leading `'` as "force text" and drop it
 *      from the displayed value; it is NOT itself CSV-special so it needs no
 *      quoting of its own).
 *   2. **Standard CSV quoting**: wrap in `"…"` and double any embedded `"`
 *      if the field contains a comma, quote, or newline — RFC 4180.
 */
export function csvEscapeField(raw: string | number | null): string {
  const text = raw === null ? '' : String(raw);
  const neutralized = /^[=+\-@]/.test(text) ? `'${text}` : text;
  if (/[",\n\r]/.test(neutralized)) {
    return `"${neutralized.replace(/"/g, '""')}"`;
  }
  return neutralized;
}

/** `\r\n` line endings, matching RFC 4180 (and what Excel expects). */
export function csvHeaderLine(): string {
  return CSV_COLUMNS.join(',') + '\r\n';
}

export function csvRowLine(row: AuditExportRow): string {
  return CSV_COLUMNS.map((col) => csvEscapeField(row[col] as string | number | null)).join(',') + '\r\n';
}

/** `before`/`after`/`detail` are ALREADY-serialized JSON text (redacted + size-capped by `serializeAuditBlob` at write time) — parsed back here so a JSONL consumer gets real nested JSON, not a JSON string containing an escaped JSON string. Falls back to the raw text if it somehow isn't valid JSON (defensive; never throws). */
function parseBlobForExport(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function jsonlRowLine(row: AuditExportRow): string {
  const expanded = {
    ...row,
    before: parseBlobForExport(row.before),
    after: parseBlobForExport(row.after),
    detail: parseBlobForExport(row.detail),
  };
  return JSON.stringify(expanded) + '\n';
}
