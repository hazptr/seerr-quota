/**
 * `GET /api/admin/audit/export?format=csv|jsonl&...filters` — `FR-AUD-9`'s
 * export half. Operator-only, re-checked server-side on THIS request
 * (`requireOperatorForRoute`, `FR-ADM-1`) — a hidden export link on
 * `/admin/audit` is not authorization; a direct GET from a member's browser
 * (or `curl`) must 403 the same way every other operator-only route does,
 * with its own `access.denied` audit row.
 *
 * **Bounded memory, by construction.** This route never calls `.all()` (or
 * anything unbounded) against `audit` — `forEachAuditRowBatch`
 * (`@/lib/audit`) reads `EXPORT_BATCH_SIZE` rows at a time and this handler
 * writes each batch straight to the response `ReadableStream` before asking
 * for the next one, so the filtered set's TOTAL size never determines how
 * much this process holds in memory at once (the project's design: "never
 * build an export that materialises the whole table in memory").
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { forEachAuditRowBatch, type AuditBrowseFilter } from '@/lib/audit';
import { csvHeaderLine, csvRowLine, jsonlRowLine, parseAuditFilterQuery, type AuditFilterQuery } from '@/components/admin/auditLogic';
import { requireOperatorForRoute } from '../../_shared/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Rows read (and streamed) per batch — small enough to bound memory, large enough that this app's actual scale ("tens of actions a day", `wiki/Feature-08-Audit-Log.md`) exports in one or two batches in practice. */
const EXPORT_BATCH_SIZE = 500;

function filterFromSearchParams(sp: URLSearchParams): AuditBrowseFilter {
  const query: AuditFilterQuery = {
    actor: sp.get('actor') ?? undefined,
    action: sp.get('action') ?? undefined,
    targetType: sp.get('targetType') ?? undefined,
    targetId: sp.get('targetId') ?? undefined,
    outcome: sp.get('outcome') ?? undefined,
    from: sp.get('from') ?? undefined,
    to: sp.get('to') ?? undefined,
  };
  return parseAuditFilterQuery(query);
}

export async function GET(req: NextRequest): Promise<Response> {
  const guard = await requireOperatorForRoute(req);
  if (guard.kind === 'denied') return guard.response;

  const format = req.nextUrl.searchParams.get('format');
  if (format !== 'csv' && format !== 'jsonl') {
    return NextResponse.json({ error: 'format must be "csv" or "jsonl"' }, { status: 400 });
  }

  const filter = filterFromSearchParams(req.nextUrl.searchParams);
  const db = getDb();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (format === 'csv') controller.enqueue(encoder.encode(csvHeaderLine()));
        await forEachAuditRowBatch(db, filter, EXPORT_BATCH_SIZE, (rows) => {
          const chunk = rows.map((row) => (format === 'csv' ? csvRowLine(row) : jsonlRowLine(row))).join('');
          controller.enqueue(encoder.encode(chunk));
        });
      } finally {
        controller.close();
      }
    },
  });

  const filename = format === 'csv' ? 'audit-export.csv' : 'audit-export.jsonl';
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
}
