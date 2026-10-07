/**
 * Secret redaction for anything that ends up in an audit row — FR-AUD-11:
 * "Audit rows MUST NOT contain secrets: no API keys, no webhook secret, no
 * `Authorization` header values. Upstream responses MUST be recorded with
 * these redacted." and AGENTS.md rule 7.
 *
 * Two independent strategies, applied together, because either one alone is
 * evadable:
 *   1. KEY-based: any object key that *looks* secret-shaped (authorization,
 *      apiKey, token, secret, password, bearer, cookie, ...) has its value
 *      replaced outright, regardless of what the value actually is. Catches
 *      the "obviously an auth header/credential field" case even for a
 *      secret this process doesn't know the value of (e.g. a value echoed
 *      back from an upstream we don't hold the literal string for).
 *   2. VALUE-based: every *known* secret value (this app's own
 *      `config.secrets.*`, passed in by the caller) is substring-matched and
 *      replaced anywhere it appears in any string, including deep inside an
 *      unrelated field like an upstream error message
 *      ("Invalid API key: abc123..." → "Invalid API key: [REDACTED]"). This
 *      is what catches a secret smuggled through a field whose *name* gives
 *      no indication it's sensitive.
 *
 * Also handles the "very large before/after blob" edge case
 * (`wiki/Feature-08-Audit-Log.md` "Edge cases & failure modes"):
 * `serializeAuditBlob` caps the serialized size and records a truncation
 * marker instead of storing (or emitting to stdout) an unbounded blob.
 * Redaction always runs BEFORE truncation, so a secret sitting right at the
 * truncation boundary is still caught.
 */

export const REDACTED = '[REDACTED]';

const SENSITIVE_KEY_SUBSTRINGS = [
  'authorization',
  'apikey',
  'token',
  'secret',
  'pass', // covers password, passwd, smtpPass, SMTP_PASS, ...
  'pwd',
  'bearer',
  'cookie',
];

/** Case/punctuation-insensitive: `X-Api-Key`, `api_key`, `apiKey`, `APIKEY` all match. */
function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_KEY_SUBSTRINGS.some((needle) => normalized.includes(needle));
}

/** Skips trivially short "secrets" (e.g. an unset env var resolved to `''`) so redaction can't mangle unrelated short strings that happen to contain a 1-2 char match. */
const MIN_KNOWN_SECRET_LENGTH = 6;

function redactKnownSecretsInString(value: string, knownSecrets: readonly string[]): string {
  let out = value;
  for (const secret of knownSecrets) {
    if (secret.length < MIN_KNOWN_SECRET_LENGTH) continue;
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}

/**
 * Deeply redacts `value`. Safe against circular references (returns
 * `'[CIRCULAR]'` at the cycle point rather than recursing forever/throwing).
 * `Error` instances are flattened to `{ name, message }` first — their
 * enumerable-own-property set is normally empty, so redacting one directly
 * would silently drop the message (and any secret substring inside it).
 */
export function redactValue(value: unknown, knownSecrets: readonly string[] = [], seen: WeakSet<object> = new WeakSet()): unknown {
  if (value instanceof Error) {
    return redactValue({ name: value.name, message: value.message }, knownSecrets, seen);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    return redactKnownSecretsInString(value, knownSecrets);
  }
  if (value === null || typeof value !== 'object') {
    return value; // number, boolean, null, undefined
  }
  if (seen.has(value)) {
    return '[CIRCULAR]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, knownSecrets, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactValue(val, knownSecrets, seen);
  }
  return out;
}

/** Default cap for one serialized `before`/`after`/`detail` blob, in UTF-8 bytes. */
const DEFAULT_MAX_BLOB_BYTES = 8000;

/**
 * Redacts, then JSON-serializes `value` for storage in one of `audit`'s
 * nullable JSON text columns. `undefined` → `null` (nothing recorded — the
 * schema column is nullable, not `"undefined"` the string). Over the size
 * cap, stores a small valid-JSON envelope with a `truncated: true` marker
 * and a preview instead of the full blob, per the wiki's "very large
 * before/after blob" edge case — never throws on size, and never truncates
 * BEFORE redaction (so a secret can't survive by sitting past the cut).
 */
export function serializeAuditBlob(value: unknown, knownSecrets: readonly string[] = [], maxBytes: number = DEFAULT_MAX_BLOB_BYTES): string | null {
  if (value === undefined) return null;
  const redacted = redactValue(value, knownSecrets);
  const json = JSON.stringify(redacted) ?? 'null';
  const byteLength = Buffer.byteLength(json, 'utf-8');
  if (byteLength <= maxBytes) return json;

  const previewChars = Math.max(0, maxBytes - 200);
  return JSON.stringify({
    truncated: true,
    originalBytes: byteLength,
    preview: json.slice(0, previewChars),
  });
}

/** Convenience for `RemoteEffectOutcome.detail` — flattens a caught error to a small, already-redactable plain object. */
export function summarizeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { message: String(err) };
}
