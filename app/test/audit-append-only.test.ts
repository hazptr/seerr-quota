import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Static guard for AGENTS.md rule 4 / FR-AUD-2: "The `audit` table is
 * append-only; the codebase must contain no `UPDATE audit` / `DELETE FROM
 * audit`, and this MUST be asserted by a test that greps the built output,
 * not merely by convention." The audit WRITER (`src/lib/audit/**`, P1-7)
 * now exists, so this file (extended from the P1-1 scaffold version) is
 * where that rule is actually exercised against real code, not just
 * asserted ahead of time.
 *
 * Three layers, from weakest to strongest:
 *   1. Raw-source scan of `src/` (the original P1-1 guard, kept as-is).
 *   2. A scan of the `typescript` compiler's TRANSPILED output for the same
 *      files — this is "the built output" FR-AUD-2 asks for literally: what
 *      `tsc`/Next's compiler actually emits, not the TypeScript source a
 *      human reads. Uses `ts.transpileModule` per file (no bundling, no
 *      cross-file resolution needed — and no new dependency: `typescript`
 *      is already a devDependency for `tsc --noEmit`).
 *   3. A fixture-based round-trip proof: writes a REAL file containing a
 *      genuine violation to a throwaway temp directory and asserts the same
 *      scanning logic used against `src/` actually flags it — i.e. these
 *      checks are demonstrated to be capable of failing, not merely
 *      asserted never to. (This was also verified by hand once against a
 *      real `src/` file during development: a temporary `db.update(audit)`
 *      call was added to `src/lib/audit/write.ts`, `docker run --rm
 *      seerr-quota-test` was confirmed RED, then the line was reverted.)
 *
 * Scans every `.ts`/`.tsx` file under `src/` (the shipped app, not `test/`
 * or generated `drizzle/*.sql`) for:
 *   - raw SQL: `UPDATE audit` / `DELETE FROM audit` (case-insensitive)
 *   - Drizzle query-builder calls against the `audit` table/schema export:
 *     `.update(audit)`, `.delete(audit)`, `.update(schema.audit)`, etc.
 */
const SRC_ROOT = path.join(process.cwd(), 'src');

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const RAW_SQL_MUTATION = /(UPDATE|DELETE\s+FROM)\s+audit\b/i;
const DRIZZLE_MUTATION = /\.(update|delete)\(\s*(schema\.)?audit\s*\)/;

describe('audit table append-only guard (AGENTS.md rule 4)', () => {
  it('src/ contains no raw SQL UPDATE/DELETE against the audit table', () => {
    const offenders: string[] = [];
    for (const file of listTsFiles(SRC_ROOT)) {
      const content = fs.readFileSync(file, 'utf-8');
      if (RAW_SQL_MUTATION.test(content)) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('src/ contains no Drizzle .update(audit)/.delete(audit) query-builder calls', () => {
    const offenders: string[] = [];
    for (const file of listTsFiles(SRC_ROOT)) {
      const content = fs.readFileSync(file, 'utf-8');
      if (DRIZZLE_MUTATION.test(content)) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the guard pattern actually detects a violation (proves the regexes are not vacuously passing)', () => {
    expect(RAW_SQL_MUTATION.test('await db.run(sql`UPDATE audit SET outcome = 1`)')).toBe(true);
    expect(RAW_SQL_MUTATION.test("await db.run(sql`DELETE FROM audit WHERE id = 1`)")).toBe(true);
    expect(DRIZZLE_MUTATION.test('db.update(audit).set({ outcome: "ok" })')).toBe(true);
    expect(DRIZZLE_MUTATION.test('db.delete(schema.audit).where(...)')).toBe(true);
    // Sanity: a plain insert (the only allowed write) must NOT trip either pattern.
    expect(RAW_SQL_MUTATION.test('db.insert(audit).values({...}).run()')).toBe(false);
    expect(DRIZZLE_MUTATION.test('db.insert(audit).values({...}).run()')).toBe(false);
  });
});

/**
 * FR-AUD-2 literally: "greps THE BUILT OUTPUT, not merely by convention."
 * This scans what the TypeScript compiler actually EMITS for every `src/`
 * file (via `ts.transpileModule`, one file at a time — no bundling, no
 * cross-file resolution, so this can't fail because some *other* module
 * under active development elsewhere in the repo doesn't yet type-check),
 * rather than the human-authored source. `typescript` is already a
 * devDependency (used for `npm run typecheck`), so this adds no new
 * dependency.
 */
function transpileForScan(filePath: string, source: string): string {
  const result = ts.transpileModule(source, {
    fileName: filePath,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: filePath.endsWith('.tsx') ? ts.JsxEmit.React : undefined,
    },
  });
  return result.outputText;
}

describe('audit table append-only guard — scans the tsc-TRANSPILED output, not just the TS source (FR-AUD-2)', () => {
  it('the compiled JS for every src/ file contains no UPDATE/DELETE against audit', () => {
    const offenders: string[] = [];
    for (const file of listTsFiles(SRC_ROOT)) {
      const source = fs.readFileSync(file, 'utf-8');
      const emitted = transpileForScan(file, source);
      if (RAW_SQL_MUTATION.test(emitted) || DRIZZLE_MUTATION.test(emitted)) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the transpiled-output scan itself would catch a real violation (not vacuous)', () => {
    const violatingSource = `
      import { audit } from '@/lib/db/schema';
      export function bad(db: any) {
        db.update(audit).set({ outcome: 'ok' }).run();
      }
    `;
    const emitted = transpileForScan('fixture.ts', violatingSource);
    expect(RAW_SQL_MUTATION.test(emitted) || DRIZZLE_MUTATION.test(emitted)).toBe(true);
  });
});

/**
 * End-to-end proof that the exact scanning logic used against `src/` above
 * is capable of failing: writes REAL files containing genuine violations to
 * a throwaway temp directory (not `src/` — this stays a permanent,
 * non-destructive test) and asserts `listTsFiles` + the same regexes flag
 * them, the same way they would if such a file ever landed in `src/`.
 */
describe('audit table append-only guard — fixture proof that a real violation gets flagged', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-audit-guard-fixture-'));

  afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('flags a fixture file containing a real Drizzle .update(audit) call', () => {
    const violatingFile = path.join(fixtureDir, 'violation-drizzle.ts');
    fs.writeFileSync(
      violatingFile,
      [
        "import { audit } from '@/lib/db/schema';",
        "import { getDb } from '@/lib/db';",
        '',
        'export function badMutateAudit() {',
        '  const db = getDb();',
        "  db.update(audit).set({ outcome: 'ok' }).run();",
        '}',
        '',
      ].join('\n'),
    );

    const offenders = listTsFiles(fixtureDir).filter((file) => DRIZZLE_MUTATION.test(fs.readFileSync(file, 'utf-8')));
    expect(offenders).toEqual([violatingFile]);
  });

  it('flags a fixture file containing raw UPDATE/DELETE SQL against audit', () => {
    const violatingFile = path.join(fixtureDir, 'violation-sql.ts');
    fs.writeFileSync(
      violatingFile,
      [
        "import { sql } from 'drizzle-orm';",
        '',
        'export function badRawSql(db: any) {',
        "  db.run(sql`UPDATE audit SET outcome = 'ok' WHERE id = 1`);",
        '}',
        '',
      ].join('\n'),
    );

    const offenders = listTsFiles(fixtureDir).filter((file) => RAW_SQL_MUTATION.test(fs.readFileSync(file, 'utf-8')));
    expect(offenders).toContain(violatingFile);
  });

  it('a fixture file that only INSERTs is NOT flagged (sanity: the guard does not over-fire)', () => {
    const cleanFile = path.join(fixtureDir, 'clean-insert.ts');
    fs.writeFileSync(
      cleanFile,
      ["import { audit } from '@/lib/db/schema';", '', 'export function ok(db: any) {', '  db.insert(audit).values({}).run();', '}', ''].join(
        '\n',
      ),
    );

    const content = fs.readFileSync(cleanFile, 'utf-8');
    expect(RAW_SQL_MUTATION.test(content)).toBe(false);
    expect(DRIZZLE_MUTATION.test(content)).toBe(false);
  });
});
