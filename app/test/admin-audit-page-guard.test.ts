import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `FR-AUD-9`'s "operator-only ... test the direct-URL ... case" for
 * `/admin/audit` (`src/app/admin/audit/page.tsx`).
 *
 * **Why this is a source scan, not a rendered-page test.** This codebase's
 * `tsconfig.json` sets `"jsx": "preserve"` (Next.js does the JSX transform
 * itself, not `tsc`) — vitest/esbuild inherits that setting and refuses to
 * parse ANY `.tsx` file (confirmed directly: importing `page.tsx` here fails
 * with "Failed to parse source ... make sure to not set jsx to preserve").
 * Consistent with that: NO test file anywhere in `test/**` imports a `.tsx`
 * module — this isn't a gap this task introduced, it's this test suite's
 * existing, consistent boundary (every other operator-only PAGE —
 * `/admin`, `/admin/members/[username]` — is likewise untested at the
 * page-component level; only the shared `requireOperator` guard itself
 * (`test/auth-authorize.test.ts`) and operator-only ROUTE HANDLERS, which
 * are plain `.ts`, get direct tests). Adding a JSX-capable transform to
 * `vitest.config.ts` would need a new dependency (`@vitejs/plugin-react` or
 * similar), which this task's constraints forbid; editing `tsconfig.json`'s
 * `jsx` setting risks the real Next.js build. So this file proves the two
 * things that CAN be proven without executing the `.tsx`:
 *
 *   1. `requireOperator` — the actual authorization primitive, already
 *      exhaustively tested in `test/auth-authorize.test.ts` (401/403,
 *      the access.denied audit row, the `target` passthrough) — is what
 *      `admin/audit/page.tsx` really calls, by source inspection, so this
 *      page cannot silently be relying on something weaker.
 *   2. The `/admin/audit/export` ROUTE (a plain `.ts` Route Handler) is
 *      fully, directly tested including its own `requireOperatorForRoute`
 *      call — `test/admin-audit-export-route.test.ts` — which is the
 *      "direct-export" half of this task's explicit ask.
 */
const PAGE_SOURCE = fs.readFileSync(path.join(process.cwd(), 'src/app/admin/audit/page.tsx'), 'utf-8');
const EXPORT_ROUTE_SOURCE = fs.readFileSync(path.join(process.cwd(), 'src/app/api/admin/audit/export/route.ts'), 'utf-8');
const HISTORY_PAGE_SOURCE = fs.readFileSync(path.join(process.cwd(), 'src/app/history/page.tsx'), 'utf-8');

describe('/admin/audit page — source-level proof of the operator guard (FR-ADM-1)', () => {
  it('imports the real requireOperator (not a local re-implementation)', () => {
    expect(PAGE_SOURCE).toMatch(/import\s*\{[^}]*requireOperator[^}]*\}\s*from\s*['"]@\/lib\/auth\/authorize['"]/);
  });

  it('actually calls requireOperator before rendering anything (not merely imported)', () => {
    expect(PAGE_SOURCE).toMatch(/requireOperator\(\s*\{\s*route:/);
  });

  it('translates a 403 to forbidden() and a 401 to unauthorized() — the same next/navigation primitives every other operator-only page uses', () => {
    expect(PAGE_SOURCE).toMatch(/forbidden\(\)/);
    expect(PAGE_SOURCE).toMatch(/unauthorized\(\)/);
  });

  it('the guard check happens BEFORE the data loader is called (auth precedes any DB read)', () => {
    const guardIndex = PAGE_SOURCE.indexOf('requireOperatorOrRespond()');
    const loaderIndex = PAGE_SOURCE.indexOf('loadAuditBrowse(');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(loaderIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(loaderIndex);
  });
});

describe('/api/admin/audit/export route — source-level proof it re-checks operator status on THIS request (this is ALSO proven behaviourally in test/admin-audit-export-route.test.ts)', () => {
  it('calls requireOperatorForRoute before doing anything else', () => {
    const guardIndex = EXPORT_ROUTE_SOURCE.indexOf('requireOperatorForRoute(req)');
    const streamIndex = EXPORT_ROUTE_SOURCE.indexOf('forEachAuditRowBatch(');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(streamIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(streamIndex);
  });
});

describe('/history page — source-level proof it scopes to the CALLER identity, never a client-suppliable id', () => {
  it('calls getIdentity() and passes identity.username (not a route/query param) into the loader', () => {
    expect(HISTORY_PAGE_SOURCE).toMatch(/getIdentity\(\)/);
    expect(HISTORY_PAGE_SOURCE).toMatch(/loadOwnAuditHistory\(\s*identity\.username/);
  });
});
