import { describe, expect, it } from 'vitest';
import { buildApprovedEmail, buildDeclinedEmail, buildHeldEmail } from '@/lib/mail/templates';

/**
 * `FR-ENF-3`: "The app MUST deliver the reason itself ... current usage,
 * quota, shortfall and held count" — never a bare "you are over your limit."
 * These tests grep for the actual formatted figures, not just that some text
 * came back, so a future edit that drops a number is caught here rather than
 * in production.
 */
describe('buildHeldEmail — FR-ENF-3: concrete numbers, not a generic message', () => {
  it('contains the formatted usage, quota, shortfall, held count, and app link', () => {
    const email = buildHeldEmail({
      usageBytes: 600_000_000_000,
      quotaBytes: 500_000_000_000,
      shortfallBytes: 100_000_000_000,
      heldRequestCount: 3,
      appUrl: 'https://quota.example.com',
    });

    expect(email.text).toContain('600.00 GB'); // current usage
    expect(email.text).toContain('500.00 GB'); // quota
    expect(email.text).toContain('100.00 GB'); // shortfall — how much to free
    expect(email.text).toContain('3 requests are waiting'); // held count
    expect(email.text).toContain('https://quota.example.com'); // link built from APP_URL
  });

  it('never says only "you are over your limit" with no figures', () => {
    const email = buildHeldEmail({
      usageBytes: 1_000_000_000,
      quotaBytes: 500_000_000,
      shortfallBytes: 500_000_000,
      heldRequestCount: 1,
      appUrl: 'https://quota.example.com',
    });
    expect(email.text.toLowerCase()).not.toMatch(/^you are over your limit\.?$/);
    // The four required data points are present even in the smallest case.
    expect(email.text).toContain('1.00 GB'); // usage: 1,000,000,000 bytes
    expect(email.text).toContain('0.50 GB'); // quota + shortfall: 500,000,000 bytes each
  });

  it('singularises "request is" for exactly one held request', () => {
    const email = buildHeldEmail({ usageBytes: 1, quotaBytes: 1, shortfallBytes: 0, heldRequestCount: 1, appUrl: 'https://quota.example.com' });
    expect(email.text).toContain('1 request is waiting');
  });

  it('names this app in the subject, not Seerr, so a hold does not read as a Seerr bug', () => {
    const email = buildHeldEmail({ usageBytes: 1, quotaBytes: 1, shortfallBytes: 0, heldRequestCount: 1, appUrl: 'https://quota.example.com' });
    expect(email.subject.toLowerCase()).toContain('seerr-quota');
  });
});

describe('buildApprovedEmail — FR-ENF-15', () => {
  it('names the request id and links to the app', () => {
    const email = buildApprovedEmail({ seerrRequestId: 97, appUrl: 'https://quota.example.com' });
    expect(email.text).toContain('#97');
    expect(email.text).toContain('https://quota.example.com');
    expect(email.text.toLowerCase()).toContain('approved');
  });
});

describe('buildDeclinedEmail — FR-ENF-12', () => {
  it('names the request id, explains the hold-expired reason, and links to the app', () => {
    const email = buildDeclinedEmail({ seerrRequestId: 55, appUrl: 'https://quota.example.com' });
    expect(email.text).toContain('#55');
    expect(email.text.toLowerCase()).toContain('declined');
    expect(email.text).toContain('https://quota.example.com');
  });
});
