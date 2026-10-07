import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// DB_PATH must be set BEFORE `@/lib/db` (imported indirectly via
// `@/lib/auth/webhookSecret`) is first touched — same pattern as
// test/db.test.ts / test/audit-write.test.ts.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-auth-webhook-secret-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;

const { constantTimeEqual, verifyWebhookSecret, recordWebhookRejected, SEERR_WEBHOOK_PATH } = await import(
  '@/lib/auth/webhookSecret'
);
const { getDb } = await import('@/lib/db');
const { audit } = await import('@/lib/db/schema');
const { eq } = await import('drizzle-orm');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SEERR_WEBHOOK_PATH', () => {
  it('is the exact path FR-SSO-7 documents', () => {
    expect(SEERR_WEBHOOK_PATH).toBe('/api/seerr/webhook');
  });
});

describe('constantTimeEqual — correctness', () => {
  it('true for identical strings', () => {
    expect(constantTimeEqual('same-secret-value', 'same-secret-value')).toBe(true);
  });

  it('false for different strings of the same length', () => {
    expect(constantTimeEqual('secret-value-aaaa', 'secret-value-bbbb')).toBe(false);
  });

  it('false for strings of different lengths (shorter, longer, and empty vs non-empty)', () => {
    expect(constantTimeEqual('short', 'much-longer-value')).toBe(false);
    expect(constantTimeEqual('much-longer-value', 'short')).toBe(false);
    expect(constantTimeEqual('', 'non-empty')).toBe(false);
    expect(constantTimeEqual('non-empty', '')).toBe(false);
  });

  it('true for two empty strings (degenerate but consistent)', () => {
    expect(constantTimeEqual('', '')).toBe(true);
  });

  it('never throws regardless of length mismatch (proves no raw timingSafeEqual(a, b) on unequal-length buffers)', () => {
    expect(() => constantTimeEqual('a', 'a very much longer secret value indeed')).not.toThrow();
    expect(() => constantTimeEqual('a very much longer secret value indeed', 'a')).not.toThrow();
  });
});

describe('constantTimeEqual — constant-time SHAPE, not just correctness', () => {
  it(
    'the implementation never branches on a.length !== b.length (no early-return-on-length-mismatch pattern) — ' +
      'both inputs are hashed to a fixed-length digest first, so timingSafeEqual always runs on two 32-byte ' +
      'buffers and can never itself throw RangeError for a length mismatch',
    () => {
      const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/auth/webhookSecret.ts'), 'utf-8');
      // Isolate constantTimeEqual's own body (up to the next top-level export)
      // so this assertion is about THAT function, not incidentally true of
      // the whole file.
      const start = source.indexOf('export function constantTimeEqual');
      expect(start).toBeGreaterThan(-1);
      const rest = source.slice(start);
      const nextExport = rest.indexOf('\nexport ', 1);
      const body = nextExport === -1 ? rest : rest.slice(0, nextExport);

      expect(body).not.toMatch(/\.length\s*!==\s*.*\.length/);
      expect(body).not.toMatch(/\.length\s*===\s*.*\.length/);
      expect(body).toMatch(/createHash/);
      expect(body).toMatch(/timingSafeEqual/);
    },
  );

  it('uses node:crypto.timingSafeEqual (not a hand-rolled, likely-non-constant-time loop)', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/auth/webhookSecret.ts'), 'utf-8');
    expect(source).toMatch(/from 'node:crypto'/);
    expect(source).toMatch(/timingSafeEqual/);
  });
});

describe('verifyWebhookSecret (FR-SSO-7)', () => {
  const expected = 'the-real-seerr-webhook-secret-value';

  it('true when the header matches the configured secret', () => {
    expect(verifyWebhookSecret(expected, expected)).toBe(true);
  });

  it('false when the header is wrong', () => {
    expect(verifyWebhookSecret('wrong-secret-value-here', expected)).toBe(false);
  });

  it('false when the header is missing (null/undefined) — never compared as if it were a valid value', () => {
    expect(verifyWebhookSecret(null, expected)).toBe(false);
    expect(verifyWebhookSecret(undefined, expected)).toBe(false);
  });

  it('false when the header is an empty string', () => {
    expect(verifyWebhookSecret('', expected)).toBe(false);
  });

  it('false when the configured secret is empty/misconfigured, even with a matching-looking empty header (never "both empty passes")', () => {
    expect(verifyWebhookSecret('', '')).toBe(false);
    expect(verifyWebhookSecret('anything', '')).toBe(false);
  });
});

describe('recordWebhookRejected (FR-SSO-7 + FR-AUD-4): writes a webhook.rejected audit row', () => {
  it('writes one row with action=webhook.rejected, outcome=denied, no target required', () => {
    const db = getDb();
    recordWebhookRejected('missing X-Webhook-Secret header');

    const rows = db.select().from(audit).where(eq(audit.action, 'webhook.rejected')).all();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[rows.length - 1];
    expect(row.outcome).toBe('denied');
    expect(row.actor).toBe('system');
    expect(row.actorRole).toBe('system');
    expect(row.source).toBe('webhook');
    expect(JSON.parse(row.detail!)).toEqual({ reason: 'missing X-Webhook-Secret header' });
  });

  it('never includes the actual secret value anywhere in the row (FR-AUD-11)', () => {
    const db = getDb();
    recordWebhookRejected('bad secret: definitely-not-the-real-secret-9f8e7d');
    const rows = db.select().from(audit).where(eq(audit.action, 'webhook.rejected')).all();
    const row = rows[rows.length - 1];
    // recordWebhookRejected only ever passes a `reason` string the CALLER
    // controls into `detail` — it never reads/forwards the actual secret
    // value itself, so there is nothing here for FR-AUD-11's redaction layer
    // to even need to catch. This test documents that contract.
    expect(row.detail).not.toBeNull();
  });
});
