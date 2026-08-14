import { describe, expect, it } from 'vitest';
import { percentile, recenter, seededRng } from './samples';

// Pool-dependent behavior (scaling, threshold recompute) is verified against
// the live DB by scripts/verify-distributions.ts; these tests cover the pure
// pieces.

describe('seededRng', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a1 = seededRng('4034:1');
    const a2 = seededRng('4034:1');
    const b = seededRng('4034:2');
    const seqA1 = [a1(), a1(), a1()];
    const seqA2 = [a2(), a2(), a2()];
    const seqB = [b(), b(), b()];
    expect(seqA1).toEqual(seqA2);
    expect(seqA1).not.toEqual(seqB);
    for (const v of seqA1) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('percentile', () => {
  it('interpolates linearly', () => {
    const sorted = new Float64Array([0, 10, 20, 30, 40]);
    expect(percentile(sorted, 0)).toBe(0);
    expect(percentile(sorted, 1)).toBe(40);
    expect(percentile(sorted, 0.5)).toBe(20);
    expect(percentile(sorted, 0.25)).toBe(10);
    expect(percentile(sorted, 0.1)).toBeCloseTo(4, 10);
  });
});

describe('recenter', () => {
  it('shifts samples so the mean equals the target, clamped at zero', () => {
    const pts = new Float64Array([5, 10, 15]);
    const shifted = recenter(pts, 20); // mean 10 -> shift +10
    expect([...shifted]).toEqual([15, 20, 25]);
    const clamped = recenter(new Float64Array([1, 2, 30]), 2); // shift -9
    expect(clamped[0]).toBe(0);
    expect(clamped[1]).toBe(0);
    expect(clamped[2]).toBe(21);
  });
});
