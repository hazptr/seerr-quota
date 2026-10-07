import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * `FR-AUD-10` end to end, through the REAL `loadOwnAuditHistory` loader
 * (`@/app/history/_data/history.ts`) and a REAL SQLite `audit` table — not
 * just `toMemberSafeAuditRow` in isolation (`test/audit-member-safe.test.ts`
 * already covers that thoroughly). This is the explicit proof this task
 * asks for: "Test it with a real `delete.blocked` row containing another
 * member's username and assert that username appears nowhere in the
 * member's response, at any nesting depth" — done here against the actual
 * insert -> query -> allow-list -> JSON-serialize pipeline a real request
 * would go through, plus proof that a DIFFERENT member's OWN rows never
 * appear at all (scope), not just that their username is stripped from rows
 * that do appear.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-history-data-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const { getDb, _resetDbForTests } = await import('@/lib/db');
const { audit } = await import('@/lib/db/schema');
const { loadOwnAuditHistory } = await import('@/app/history/_data/history');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  _resetDbForTests();
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(`${tmpDbPath}-wal`, { force: true });
  fs.rmSync(`${tmpDbPath}-shm`, { force: true });
});

function insertDeleteBlockedRow(): void {
  // Shaped EXACTLY like `src/lib/deletion/execute.ts` writes a real
  // `delete.blocked` row for the `guard` branch: `detail.guards[]` carries
  // `operatorMessage`/`operatorDetail`, which can name OTHER members
  // (whoever's recent playback fired the `recently_played` guard).
  getDb()
    .insert(audit)
    .values({
      ts: 1_800_000_000_000,
      actor: 'dana',
      actorRole: 'member',
      onBehalfOf: null,
      action: 'delete.blocked',
      targetType: 'title',
      targetId: 'movie-42',
      outcome: 'denied',
      source: 'ui',
      correlationId: 'corr-1',
      detail: JSON.stringify({
        requestedMode: 'delete_files',
        reason: 'guard',
        guards: [
          {
            guardId: 'recently_played',
            operatorMessage: 'Played within the last 14 days by frank, erin.',
            operatorDetail: { lastPlayedAnyAt: 1_799_000_000, playedBy: ['frank', 'erin'] },
          },
        ],
      }),
    })
    .run();
}

function insertOtherMembersOwnRow(): void {
  // `frank`'s OWN delete.requested row — must never appear in `dana`'s
  // history at all (scope, not just field-content).
  getDb()
    .insert(audit)
    .values({
      ts: 1_800_000_001_000,
      actor: 'frank',
      actorRole: 'member',
      onBehalfOf: null,
      action: 'delete.requested',
      targetType: 'title',
      targetId: 'movie-99',
      outcome: 'ok',
      source: 'ui',
      correlationId: 'corr-2',
      detail: JSON.stringify({ requestedMode: 'delete_files', path: '/data/media/movies/frank-private-thing', sizeBytes: 5_000_000_000 }),
    })
    .run();
}

describe('loadOwnAuditHistory — FR-AUD-10 x FR-DEL-4a: a real delete.blocked row leaks nothing', () => {
  beforeEach(() => {
    insertDeleteBlockedRow();
    insertOtherMembersOwnRow();
  });

  it("dana's own history contains her delete.blocked row, with neither frank nor erin appearing anywhere in the JSON-serialized response", async () => {
    const history = await loadOwnAuditHistory('dana', 1);
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0].action).toBe('delete.blocked');

    const wholeResponse = JSON.stringify(history);
    expect(wholeResponse).not.toContain('frank');
    expect(wholeResponse).not.toContain('erin');
    expect(wholeResponse).not.toContain('operatorMessage');
    expect(wholeResponse).not.toContain('operatorDetail');
    expect(wholeResponse).not.toContain('playedBy');
    expect(wholeResponse).not.toContain('guards');
  });

  it('the allow-listed safe field (reason) still comes through, so the response is not simply empty', () => {
    return loadOwnAuditHistory('dana', 1).then((history) => {
      expect(history.rows[0].detail).toEqual({ reason: 'guard' });
    });
  });

  it("frank's own row (a DIFFERENT member's history) never appears in dana's history at all — scope, not just field redaction", async () => {
    const history = await loadOwnAuditHistory('dana', 1);
    expect(history.rows.some((r) => r.targetId === 'movie-99')).toBe(false);
    expect(JSON.stringify(history)).not.toContain('movie-99');
    expect(JSON.stringify(history)).not.toContain('frank-private-thing');
  });

  it("conversely, frank's own history contains HER row and not dana's delete.blocked row", async () => {
    const history = await loadOwnAuditHistory('frank', 1);
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0].targetId).toBe('movie-99');
  });

  it('an unrelated member with no rows at all gets an empty, non-throwing result', async () => {
    const history = await loadOwnAuditHistory('nobody-like-this', 1);
    expect(history.rows).toEqual([]);
    expect(history.meta.totalCount).toBe(0);
  });
});

describe('loadOwnAuditHistory — server-side pagination', () => {
  it('never returns more than one page of rows', async () => {
    for (let i = 0; i < 40; i++) {
      getDb()
        .insert(audit)
        .values({
          ts: 1_800_000_000_000 + i,
          actor: 'dana',
          actorRole: 'member',
          action: 'access.denied',
          targetType: 'route',
          targetId: '/x',
          outcome: 'denied',
          source: 'ui',
          correlationId: `corr-${i}`,
        })
        .run();
    }
    const page1 = await loadOwnAuditHistory('dana', 1);
    expect(page1.meta.totalCount).toBe(40);
    expect(page1.rows.length).toBeLessThan(40);
    expect(page1.rows.length).toBe(page1.meta.pageSize);
  });
});
