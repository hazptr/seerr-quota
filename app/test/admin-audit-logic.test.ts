import { describe, expect, it } from 'vitest';
import {
  csvEscapeField,
  csvHeaderLine,
  csvRowLine,
  dateStringToMsBound,
  jsonlRowLine,
  parseAuditFilterQuery,
  type AuditExportRow,
} from '@/components/admin/auditLogic';

describe('csvEscapeField — CSV injection / quoting (this task explicit trap)', () => {
  it('neutralises a leading = with a leading apostrophe', () => {
    expect(csvEscapeField('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
  });

  it('neutralises a leading +, -, and @ the same way', () => {
    expect(csvEscapeField('+1234')).toBe("'+1234");
    expect(csvEscapeField('-1234')).toBe("'-1234");
    expect(csvEscapeField('@cmd|calc')).toBe("'@cmd|calc");
  });

  it('leaves an ordinary field untouched', () => {
    expect(csvEscapeField('delete.blocked')).toBe('delete.blocked');
    expect(csvEscapeField(42)).toBe('42');
  });

  it('null becomes an empty field', () => {
    expect(csvEscapeField(null)).toBe('');
  });

  it('quotes a field containing a comma, and doubles embedded quotes', () => {
    expect(csvEscapeField('a,b')).toBe('"a,b"');
    expect(csvEscapeField('say "hi"')).toBe('"say ""hi"""');
  });

  it('quotes a field containing a newline', () => {
    expect(csvEscapeField('line1\nline2')).toBe('"line1\nline2"');
  });

  it('a formula-shaped field that ALSO needs quoting gets both treatments, in order', () => {
    expect(csvEscapeField('=A1,B1')).toBe('"\'=A1,B1"');
  });
});

function sampleRow(overrides: Partial<AuditExportRow> = {}): AuditExportRow {
  return {
    id: 1,
    ts: 1_800_000_000_000,
    actor: 'dana',
    actorRole: 'member',
    onBehalfOf: null,
    action: 'delete.blocked',
    targetType: 'title',
    targetId: 'movie-1',
    outcome: 'denied',
    source: 'ui',
    correlationId: 'corr-1',
    before: null,
    after: null,
    detail: JSON.stringify({ reason: 'guard' }),
    ...overrides,
  };
}

describe('csvHeaderLine / csvRowLine', () => {
  it('header lists every column, \\r\\n terminated', () => {
    expect(csvHeaderLine().endsWith('\r\n')).toBe(true);
    expect(csvHeaderLine()).toContain('correlationId');
  });

  it('a row line renders every field in header order', () => {
    const line = csvRowLine(sampleRow());
    expect(line.endsWith('\r\n')).toBe(true);
    expect(line).toContain('dana');
    expect(line).toContain('delete.blocked');
  });

  it('a detail blob starting with = does not become a live formula when the CSV is opened (still escaped, not raw)', () => {
    const line = csvRowLine(sampleRow({ detail: '=cmd|/c calc' }));
    expect(line).toContain("'=cmd|/c calc");
  });
});

describe('jsonlRowLine', () => {
  it('parses before/after/detail back into real nested JSON, not an escaped string', () => {
    const row = sampleRow({ before: JSON.stringify({ x: 1 }), after: JSON.stringify({ y: 2 }), detail: JSON.stringify({ reason: 'guard' }) });
    const parsed = JSON.parse(jsonlRowLine(row).trim());
    expect(parsed.before).toEqual({ x: 1 });
    expect(parsed.after).toEqual({ y: 2 });
    expect(parsed.detail).toEqual({ reason: 'guard' });
    expect(typeof parsed.before).toBe('object');
  });

  it('a null blob stays null', () => {
    const parsed = JSON.parse(jsonlRowLine(sampleRow({ before: null, after: null, detail: null })).trim());
    expect(parsed.before).toBeNull();
    expect(parsed.after).toBeNull();
    expect(parsed.detail).toBeNull();
  });

  it('a malformed blob falls back to the raw text rather than throwing', () => {
    const parsed = JSON.parse(jsonlRowLine(sampleRow({ detail: 'not json {{' })).trim());
    expect(parsed.detail).toBe('not json {{');
  });

  it('each line is newline-terminated (one JSON object per line)', () => {
    expect(jsonlRowLine(sampleRow()).endsWith('\n')).toBe(true);
  });
});

describe('dateStringToMsBound', () => {
  it('start edge is midnight UTC', () => {
    expect(dateStringToMsBound('2026-08-24', 'start')).toBe(Date.parse('2026-08-24T00:00:00.000Z'));
  });

  it('end edge is 23:59:59.999 UTC', () => {
    expect(dateStringToMsBound('2026-08-24', 'end')).toBe(Date.parse('2026-08-24T23:59:59.999Z'));
  });

  it('undefined/blank/malformed input yields undefined, never throws', () => {
    expect(dateStringToMsBound(undefined, 'start')).toBeUndefined();
    expect(dateStringToMsBound('', 'start')).toBeUndefined();
    expect(dateStringToMsBound('not-a-date', 'start')).toBeUndefined();
    expect(dateStringToMsBound('2026-8-24', 'start')).toBeUndefined();
  });
});

describe('parseAuditFilterQuery', () => {
  it('empty query -> empty filter', () => {
    expect(parseAuditFilterQuery({})).toEqual({});
  });

  it('a known action/outcome/targetType passes through', () => {
    const filter = parseAuditFilterQuery({ action: 'delete.blocked', outcome: 'denied', targetType: 'title', targetId: 'movie-1', actor: 'dana' });
    expect(filter).toEqual({ action: 'delete.blocked', outcome: 'denied', targetType: 'title', targetId: 'movie-1', actor: 'dana' });
  });

  it('an unrecognised action/outcome/targetType is silently dropped, not thrown', () => {
    const filter = parseAuditFilterQuery({ action: 'not.a.real.action', outcome: 'sideways', targetType: 'planet' });
    expect(filter).toEqual({});
  });

  it('blank strings are dropped, not kept as empty-string filters', () => {
    expect(parseAuditFilterQuery({ actor: '   ', targetId: '' })).toEqual({});
  });

  it('from/to become fromTs/toTs day-boundary ms', () => {
    const filter = parseAuditFilterQuery({ from: '2026-08-01', to: '2026-08-24' });
    expect(filter.fromTs).toBe(Date.parse('2026-08-01T00:00:00.000Z'));
    expect(filter.toTs).toBe(Date.parse('2026-08-24T23:59:59.999Z'));
  });
});
