import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkFreeSpaceWarning, readBulkDriveFreeBytes, validateGraceBytes, validateQuotaBytes } from '@/lib/quota/validation';

describe('validateQuotaBytes — FR-POL-9: reject negatives', () => {
  it('accepts 0 (unlimited — a real decision, not a violation)', () => {
    expect(validateQuotaBytes(0)).toEqual({ valid: true });
  });

  it('accepts a positive integer', () => {
    expect(validateQuotaBytes(500_000_000_000)).toEqual({ valid: true });
  });

  it('rejects a negative value', () => {
    const result = validateQuotaBytes(-1, 'default_quota_bytes');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain('default_quota_bytes');
  });

  it('rejects exactly -1 and very negative alike (boundary at 0)', () => {
    expect(validateQuotaBytes(-1).valid).toBe(false);
    expect(validateQuotaBytes(0).valid).toBe(true);
  });

  it('rejects non-finite input', () => {
    expect(validateQuotaBytes(NaN).valid).toBe(false);
    expect(validateQuotaBytes(Infinity).valid).toBe(false);
  });

  it('rejects a fractional byte count', () => {
    expect(validateQuotaBytes(1.5).valid).toBe(false);
  });
});

describe('validateGraceBytes — FR-POL-9: reject grace_bytes > default_quota_bytes', () => {
  it('accepts grace_bytes == default_quota_bytes exactly (boundary: not "exceeds")', () => {
    expect(validateGraceBytes(500, 500)).toEqual({ valid: true });
  });

  it('rejects grace_bytes one byte over default_quota_bytes', () => {
    expect(validateGraceBytes(501, 500).valid).toBe(false);
  });

  it('accepts grace_bytes below default_quota_bytes', () => {
    expect(validateGraceBytes(0, 500).valid).toBe(true);
    expect(validateGraceBytes(499, 500).valid).toBe(true);
  });

  it('rejects a negative grace_bytes regardless of default', () => {
    expect(validateGraceBytes(-1, 500).valid).toBe(false);
    expect(validateGraceBytes(-1, null).valid).toBe(false);
  });

  it('skips the ceiling check when default_quota_bytes is unset (null) — a valid degraded state, mirrors src/lib/config.ts validateConfig', () => {
    expect(validateGraceBytes(1_000_000, null)).toEqual({ valid: true });
  });

  it('does NOT skip the ceiling check when default_quota_bytes is 0 (0 is a decision, "explicitly unlimited", not "unset")', () => {
    expect(validateGraceBytes(1, 0).valid).toBe(false);
    expect(validateGraceBytes(0, 0).valid).toBe(true);
  });
});

describe('checkFreeSpaceWarning — FR-POL-9: warn (never reject) on exceeding free space', () => {
  it('warns when the proposed value exceeds free space', () => {
    const result = checkFreeSpaceWarning(8_000_000_000_000, 7_800_000_000_000);
    expect(result.warn).toBe(true);
    expect(result.message).toBeDefined();
  });

  it('does not warn at or under free space (boundary: exactly equal does not warn)', () => {
    expect(checkFreeSpaceWarning(7_800_000_000_000, 7_800_000_000_000).warn).toBe(false);
    expect(checkFreeSpaceWarning(1, 7_800_000_000_000).warn).toBe(false);
  });

  it('never warns when free space is unknown (undefined) — no false alarms', () => {
    expect(checkFreeSpaceWarning(999_999_999_999_999, undefined)).toEqual({ warn: false });
  });

  it('this is a warning, not a rejection — the return shape never carries validateQuotaBytes-style "valid: false"', () => {
    const result = checkFreeSpaceWarning(999, 1);
    expect(result).not.toHaveProperty('valid');
  });
});

describe('readBulkDriveFreeBytes — the one filesystem-touching function (mirrors src/lib/config.ts checkDbPathWritable)', () => {
  it('computes bavail * bsize from a real statfs call against a throwaway tmp directory — never the real /mnt/media', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seerr-quota-freespace-test-'));
    try {
      const result = readBulkDriveFreeBytes(tmpDir);
      // A real tmpfs/disk always reports SOME free space as a positive number.
      expect(typeof result).toBe('number');
      expect(result as number).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns undefined (never throws) for a path that does not exist', () => {
    expect(readBulkDriveFreeBytes('/definitely/does/not/exist/on/this/host')).toBeUndefined();
  });

  it('accepts an injected statfs implementation as a test seam, for exact-number assertions', () => {
    const fakeStatfs = () => ({ bavail: 100, bsize: 4096 });
    expect(readBulkDriveFreeBytes('/anything', fakeStatfs)).toBe(409_600);
  });

  it('returns undefined if the injected statfs throws', () => {
    const throwingStatfs = () => {
      throw new Error('boom');
    };
    expect(readBulkDriveFreeBytes('/anything', throwingStatfs)).toBeUndefined();
  });
});
