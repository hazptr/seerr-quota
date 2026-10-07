import { describe, expect, it } from 'vitest';
import { REDACTED, redactValue, serializeAuditBlob, summarizeError } from '@/lib/audit/redact';

describe('redactValue — key-based redaction (FR-AUD-11)', () => {
  it('redacts an apiKey field regardless of casing/punctuation in the key name', () => {
    for (const key of ['apiKey', 'api_key', 'API_KEY', 'ApiKey', 'x-api-key']) {
      const result = redactValue({ [key]: 'super-secret-value-123' }) as Record<string, unknown>;
      expect(result[key]).toBe(REDACTED);
    }
  });

  it('redacts an Authorization header value, nested inside a headers object', () => {
    const upstreamRequestLog = {
      method: 'DELETE',
      url: 'http://radarr:7878/api/v3/movie/42',
      headers: { Authorization: 'Bearer eyJhbGciOiJI.something.else', 'Content-Type': 'application/json' },
    };
    const result = redactValue(upstreamRequestLog) as any;
    expect(result.headers.Authorization).toBe(REDACTED);
    expect(result.headers['Content-Type']).toBe('application/json'); // non-secret fields pass through
    expect(result.method).toBe('DELETE');
  });

  it('redacts webhookSecret / token / password / bearer / cookie fields', () => {
    const obj = {
      webhookSecret: 'shh',
      seerrWebhookSecret: 'shh2',
      token: 'shh3',
      accessToken: 'shh4',
      password: 'shh5',
      smtpPass: 'shh6',
      cookie: 'session=abc',
    };
    const result = redactValue(obj) as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      expect(result[key]).toBe(REDACTED);
    }
  });

  it('does NOT redact ordinary, non-secret fields (no false-positive over-redaction)', () => {
    const obj = { movieId: 42, title: 'The Godfather Part II', year: 1974, path: '/mnt/media/movies/foo' };
    expect(redactValue(obj)).toEqual(obj);
  });

  it('redacts inside arrays of objects', () => {
    const rows = [{ token: 'a-secret' }, { token: 'another-secret' }];
    const result = redactValue(rows) as Array<Record<string, unknown>>;
    expect(result[0].token).toBe(REDACTED);
    expect(result[1].token).toBe(REDACTED);
  });

  it('handles circular references without throwing', () => {
    const obj: any = { name: 'cyclic' };
    obj.self = obj;
    expect(() => redactValue(obj)).not.toThrow();
    const result = redactValue(obj) as any;
    expect(result.self).toBe('[CIRCULAR]');
  });

  it('flattens Error instances to { name, message } so the message (and any secret substring in it) survives redaction', () => {
    const err = new Error('Invalid API key: sekrit-value-000');
    const result = redactValue(err, ['sekrit-value-000']) as any;
    expect(result.message).toBe('Invalid API key: [REDACTED]');
    expect(result.name).toBe('Error');
  });
});

describe('redactValue — known-secret-VALUE redaction (smuggling attempts)', () => {
  it('redacts a known secret value embedded inside an unrelated string field (e.g. an upstream error body)', () => {
    const knownSecrets = ['RADARR-REAL-API-KEY-abcdef123456'];
    const upstreamErrorBody = { message: 'Unauthorized — bad key RADARR-REAL-API-KEY-abcdef123456 supplied' };
    const result = redactValue(upstreamErrorBody, knownSecrets) as any;
    expect(result.message).not.toContain('RADARR-REAL-API-KEY-abcdef123456');
    expect(result.message).toBe('Unauthorized — bad key [REDACTED] supplied');
  });

  it('redacts a known secret value smuggled into a URL query string', () => {
    const knownSecrets = ['topsecretwebhookvalue987654'];
    const detail = { call: 'GET http://radarr:7878/api/v3/system/status?apikey=topsecretwebhookvalue987654' };
    const result = redactValue(detail, knownSecrets) as any;
    expect(result.call).not.toContain('topsecretwebhookvalue987654');
  });

  it('redacts a known secret value that appears under an innocuous-looking key name', () => {
    // The key "note" gives no hint it's sensitive — only value-based redaction catches this.
    const knownSecrets = ['sneaky-secret-in-a-note-field'];
    const detail = { note: 'operator pasted sneaky-secret-in-a-note-field by mistake' };
    const result = redactValue(detail, knownSecrets) as any;
    expect(result.note).not.toContain('sneaky-secret-in-a-note-field');
  });

  it('does not redact trivially short strings even if they coincidentally match a very short "secret"', () => {
    // Guards against a pathological empty/placeholder secret ('' or 'x') mangling unrelated text.
    const result = redactValue({ msg: 'the cat sat on the mat' }, ['a', '']) as any;
    expect(result.msg).toBe('the cat sat on the mat');
  });
});

describe('serializeAuditBlob — redact-then-serialize-then-truncate, in that order (FR-AUD-11 + the "very large blob" edge case)', () => {
  it('returns null for undefined (nothing recorded)', () => {
    expect(serializeAuditBlob(undefined)).toBeNull();
  });

  it('returns valid JSON with secrets already redacted', () => {
    const json = serializeAuditBlob({ apiKey: 'x', ok: true }, []);
    expect(json).not.toBeNull();
    const parsed = JSON.parse(json!);
    expect(parsed.apiKey).toBe(REDACTED);
    expect(parsed.ok).toBe(true);
  });

  it('caps a very large blob and stores a valid-JSON truncation marker instead of the full payload', () => {
    const huge = { blob: 'x'.repeat(50_000) };
    const json = serializeAuditBlob(huge, [], 1000);
    expect(json).not.toBeNull();
    const parsed = JSON.parse(json!); // must still be valid JSON
    expect(parsed.truncated).toBe(true);
    expect(typeof parsed.originalBytes).toBe('number');
    expect(parsed.originalBytes).toBeGreaterThan(1000);
    expect(Buffer.byteLength(json!, 'utf-8')).toBeLessThanOrEqual(1000 + 300); // envelope overhead only, not the full 50k payload
  });

  it('redacts a known secret BEFORE truncating, even when the secret sits past where truncation would otherwise cut', () => {
    const secret = 'must-not-survive-truncation-000000';
    const huge = { padding: 'x'.repeat(5000), secret };
    const json = serializeAuditBlob(huge, [secret], 200);
    expect(json).not.toBeNull();
    expect(json).not.toContain(secret);
  });
});

describe('summarizeError', () => {
  it('flattens an Error to a plain { name, message } object', () => {
    expect(summarizeError(new Error('boom'))).toEqual({ name: 'Error', message: 'boom' });
  });

  it('stringifies a non-Error throw value', () => {
    expect(summarizeError('plain string throw')).toEqual({ message: 'plain string throw' });
  });
});
