import { describe, expect, it } from 'vitest';
import { noopNotifier } from '@/lib/enforcement/notify';

/**
 * The P2-9 integration point's shipped default (`src/lib/enforcement/notify.ts`).
 * P2-6 does not implement member notifications — this pins the one contract
 * that matters until it does: `noopNotifier` never reports `sent: true`, so
 * `src/lib/enforcement/process.ts` never records a notification that didn't
 * happen (see that file's `notifiedAt`/`request.notified` call sites).
 */
describe('noopNotifier — the P2-6 shipped default (P2-9 integration point)', () => {
  it('notifyHeld always reports sent: false', async () => {
    await expect(
      noopNotifier.notifyHeld({ ssoUsername: 'frank', seerrRequestId: 1, usageBytes: 600, quotaBytes: 500, shortfallBytes: 100 }),
    ).resolves.toEqual({ sent: false });
  });

  it('notifyApproved always reports sent: false', async () => {
    await expect(noopNotifier.notifyApproved({ ssoUsername: 'frank', seerrRequestId: 1 })).resolves.toEqual({ sent: false });
  });

  it('notifyDeclined always reports sent: false', async () => {
    await expect(noopNotifier.notifyDeclined({ ssoUsername: 'frank', seerrRequestId: 1, reason: 'hold_expired' })).resolves.toEqual({
      sent: false,
    });
  });
});
