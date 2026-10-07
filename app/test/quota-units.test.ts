import { describe, expect, it } from 'vitest';
import { BYTES_PER_GB, bytesToGb, gbToBytes } from '@/lib/quota/units';

describe('gbToBytes/bytesToGb — FR-POL-9: entered/displayed in decimal GB, stored in bytes', () => {
  it('BYTES_PER_GB is decimal (10^9), matching src/components/member/logic.ts formatGB', () => {
    expect(BYTES_PER_GB).toBe(1_000_000_000);
  });

  it('gbToBytes: whole numbers', () => {
    expect(gbToBytes(0)).toBe(0);
    expect(gbToBytes(1)).toBe(1_000_000_000);
    expect(gbToBytes(300)).toBe(300_000_000_000);
    expect(gbToBytes(547)).toBe(547_000_000_000);
  });

  it('gbToBytes: fractional GB rounds to the nearest whole byte', () => {
    expect(gbToBytes(0.5)).toBe(500_000_000);
    expect(gbToBytes(1150)).toBe(1_150_000_000_000);
    // 0.1 GB in floating point is 100_000_000.00000001-ish before rounding — must land exactly on 100_000_000.
    expect(gbToBytes(0.1)).toBe(100_000_000);
  });

  it('gbToBytes: negative input converts predictably (rejection is validateQuotaBytes\'s job, not this function\'s)', () => {
    expect(gbToBytes(-5)).toBe(-5_000_000_000);
  });

  it('gbToBytes: throws on non-finite input', () => {
    expect(() => gbToBytes(NaN)).toThrow(RangeError);
    expect(() => gbToBytes(Infinity)).toThrow(RangeError);
    expect(() => gbToBytes(-Infinity)).toThrow(RangeError);
  });

  it('bytesToGb: exact division, no rounding', () => {
    expect(bytesToGb(1_000_000_000)).toBe(1);
    expect(bytesToGb(0)).toBe(0);
    expect(bytesToGb(500_000_000)).toBe(0.5);
    expect(bytesToGb(1)).toBeCloseTo(1e-9, 15);
  });

  it('round-trips whole-GB quota figures exactly', () => {
    expect(gbToBytes(1150)).toBe(1_150_000_000_000);
    expect(bytesToGb(1_150_000_000_000)).toBe(1150);
    expect(gbToBytes(450)).toBe(450_000_000_000);
    expect(gbToBytes(400)).toBe(400_000_000_000);
    expect(gbToBytes(300)).toBe(300_000_000_000);
  });
});
