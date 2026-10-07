import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// DB_PATH/SEERR_WEBHOOK_SECRET must be set BEFORE `@/lib/db`/`@/lib/config`
// are first touched — same isolated-throwaway-file pattern as every other
// test in this suite.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-webhook-route-test-'));
const tmpDbPath = path.join(tmpDir, 'test.sqlite');
process.env.DB_PATH = tmpDbPath;
process.env.SEERR_WEBHOOK_SECRET = 'test-webhook-secret-abc123';

/**
 * Mocks `@/lib/enforcement`'s `processPendingRequest` — this suite is about
 * the ROUTE's own responsibilities (secret check, payload parsing, wiring),
 * not re-proving the decision engine itself (`test/enforcement-process.test.ts`
 * already covers duplicate-webhook/idempotency and FR-ENF-8's "payload can't
 * redirect the verdict" at that layer, deterministically, without needing a
 * fake `fetch`). Recording every call's exact arguments is what lets this
 * suite prove the route reads ONLY `request_id` from the body: a payload
 * carrying spoofed `requestedBy_email`/`media`/etc. fields must never affect
 * what's passed through.
 */
const processPendingRequestMock = vi.fn(async (seerrRequestId: number, _source: string, _deps?: unknown) => ({
  kind: 'decided' as const,
  seerrRequestId,
  decision: 'approve' as const,
  reason: 'under_quota' as const,
}));

/**
 * `createEnforcementNotifier` (P2-9) is mocked too, so this suite stays about
 * the ROUTE's own wiring (secret check, payload parsing, passing a notifier
 * through) rather than re-proving the real SMTP notifier's own behaviour
 * (`test/enforcement-notify-real.test.ts` owns that). Returns a distinct,
 * recognisable object per call so the assertions below can confirm the route
 * actually constructs and forwards ONE, not that it merely didn't crash.
 */
const createEnforcementNotifierMock = vi.fn((opts: { source: string }) => ({
  __fakeNotifier: true,
  source: opts.source,
  notifyHeld: vi.fn(),
  notifyApproved: vi.fn(),
  notifyDeclined: vi.fn(),
}));

vi.mock('@/lib/enforcement', () => ({
  processPendingRequest: (...args: [number, string, unknown?]) => processPendingRequestMock(...args),
  createEnforcementNotifier: (opts: { source: string }) => createEnforcementNotifierMock(opts),
}));

const { POST } = await import('@/app/api/seerr/webhook/route');
const { getDb } = await import('@/lib/db');
const { audit } = await import('@/lib/db/schema');
const { _resetConfigCacheForTests } = await import('@/lib/config');
const { NextRequest } = await import('next/server');

const ORIGINAL_ENV = { ...process.env };
const WEBHOOK_URL = 'http://seerr-quota:3000/api/seerr/webhook';
const SECRET_HEADER = 'X-Seerr-Webhook-Secret';
const REAL_SECRET = 'test-webhook-secret-abc123';

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  processPendingRequestMock.mockClear();
  createEnforcementNotifierMock.mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV, DB_PATH: tmpDbPath, SEERR_WEBHOOK_SECRET: REAL_SECRET };
  _resetConfigCacheForTests();
});

function postWebhook(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return POST(
    new NextRequest(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function latestWebhookRejectedRow() {
  const rows = getDb().select().from(audit).where(eq(audit.action, 'webhook.rejected')).all();
  return rows[rows.length - 1];
}

describe('POST /api/seerr/webhook — FR-SSO-7: shared-secret authentication', () => {
  it('401s and writes a webhook.rejected audit row when the secret header is missing', async () => {
    const res = await postWebhook({ request_id: '42' });
    expect(res.status).toBe(401);
    expect(processPendingRequestMock).not.toHaveBeenCalled();
    const row = latestWebhookRejectedRow();
    expect(row.outcome).toBe('denied');
    expect(row.source).toBe('webhook');
  });

  it('401s and writes a webhook.rejected audit row when the secret header is wrong', async () => {
    const res = await postWebhook({ request_id: '42' }, { [SECRET_HEADER]: 'not-the-real-secret' });
    expect(res.status).toBe(401);
    expect(processPendingRequestMock).not.toHaveBeenCalled();
    expect(latestWebhookRejectedRow().outcome).toBe('denied');
  });

  it('never leaks the real secret value into the audit row (FR-AUD-11)', async () => {
    await postWebhook({ request_id: '42' }, { [SECRET_HEADER]: 'bogus' });
    const row = latestWebhookRejectedRow();
    expect(row.detail).not.toContain(REAL_SECRET);
  });

  it('proceeds (200, calls processPendingRequest) when the secret is correct', async () => {
    const res = await postWebhook({ request_id: '42' }, { [SECRET_HEADER]: REAL_SECRET });
    expect(res.status).toBe(200);
    expect(processPendingRequestMock).toHaveBeenCalledTimes(1);
    // P2-9: a third arg is now forwarded — the real notifier's deps, built
    // via `createEnforcementNotifier({ source: 'webhook' })` (asserted
    // separately below). Not `undefined` and not a bare `{}` — the route
    // must actually inject a notifier, not just leave room for one.
    expect(processPendingRequestMock).toHaveBeenCalledWith(42, 'webhook', { notifier: expect.objectContaining({ __fakeNotifier: true }) });
  });

  it('builds the notifier via createEnforcementNotifier with source: "webhook"', async () => {
    await postWebhook({ request_id: '42' }, { [SECRET_HEADER]: REAL_SECRET });
    expect(createEnforcementNotifierMock).toHaveBeenCalledTimes(1);
    expect(createEnforcementNotifierMock).toHaveBeenCalledWith({ source: 'webhook' });
  });
});

describe('POST /api/seerr/webhook — FR-ENF-8: only request_id is ever read from the payload', () => {
  it('extracts a numeric request_id and discards every other field, even ones that look like an identity spoof', async () => {
    await postWebhook(
      {
        request_id: '97',
        // Everything below is exactly the kind of field a forged/untrimmed
        // Seerr webhook payload could carry — the route must not read any of
        // it. (`processPendingRequest` itself re-fetches the real request
        // from Seerr regardless — see test/enforcement-process.test.ts.)
        requestedBy_email: 'attacker@example.com',
        requestedBy_username: 'not-the-real-requester',
        requestedBy_settings_discordId: '12345',
        media: { media_type: 'movie', tmdbId: '9999' },
        notification_type: 'MEDIA_PENDING',
      },
      { [SECRET_HEADER]: REAL_SECRET },
    );

    expect(processPendingRequestMock).toHaveBeenCalledTimes(1);
    // The numeric id, the fixed 'webhook' source, and the injected notifier
    // deps — nothing else from the body was forwarded downstream (the
    // notifier itself is a fixed, source-only construction, not derived from
    // the body at all).
    expect(processPendingRequestMock).toHaveBeenCalledWith(97, 'webhook', { notifier: expect.objectContaining({ __fakeNotifier: true }) });
  });

  it('accepts request_id as a JSON number too (not just Seerr\'s usual string-templated form)', async () => {
    await postWebhook({ request_id: 123 }, { [SECRET_HEADER]: REAL_SECRET });
    expect(processPendingRequestMock).toHaveBeenCalledWith(123, 'webhook', { notifier: expect.objectContaining({ __fakeNotifier: true }) });
  });

  it('400s without calling processPendingRequest when request_id is missing', async () => {
    const res = await postWebhook({}, { [SECRET_HEADER]: REAL_SECRET });
    expect(res.status).toBe(400);
    expect(processPendingRequestMock).not.toHaveBeenCalled();
  });

  it('400s without calling processPendingRequest when request_id is non-numeric', async () => {
    const res = await postWebhook({ request_id: 'not-a-number' }, { [SECRET_HEADER]: REAL_SECRET });
    expect(res.status).toBe(400);
    expect(processPendingRequestMock).not.toHaveBeenCalled();
  });

  it('400s without calling processPendingRequest when request_id is zero/negative', async () => {
    expect((await postWebhook({ request_id: '0' }, { [SECRET_HEADER]: REAL_SECRET })).status).toBe(400);
    expect((await postWebhook({ request_id: '-5' }, { [SECRET_HEADER]: REAL_SECRET })).status).toBe(400);
    expect(processPendingRequestMock).not.toHaveBeenCalled();
  });

  it('400s on a malformed JSON body, checked AFTER the secret (secret check never leaks on body-parse ordering)', async () => {
    const res = await POST(
      new NextRequest(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SECRET_HEADER]: REAL_SECRET },
        body: '{not valid json',
      }),
    );
    expect(res.status).toBe(400);
    expect(processPendingRequestMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/seerr/webhook — duplicate delivery reaches processPendingRequest, which owns idempotency', () => {
  it('two identical deliveries both call through (the route itself does not de-dupe; test/enforcement-process.test.ts proves the underlying function does)', async () => {
    await postWebhook({ request_id: '55' }, { [SECRET_HEADER]: REAL_SECRET });
    await postWebhook({ request_id: '55' }, { [SECRET_HEADER]: REAL_SECRET });
    expect(processPendingRequestMock).toHaveBeenCalledTimes(2);
    expect(processPendingRequestMock).toHaveBeenNthCalledWith(1, 55, 'webhook', { notifier: expect.objectContaining({ __fakeNotifier: true }) });
    expect(processPendingRequestMock).toHaveBeenNthCalledWith(2, 55, 'webhook', { notifier: expect.objectContaining({ __fakeNotifier: true }) });
  });
});
