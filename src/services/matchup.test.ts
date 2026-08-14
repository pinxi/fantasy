import { describe, expect, it } from 'vitest';
import { invCdfSampler, seededRng, type PlayerWeekDist } from '@/valuation/samples';

const DIST: PlayerWeekDist = { pts: 12, p10: 5, p25: 8, p75: 16, p90: 21 };

describe('invCdfSampler', () => {
  it('hits the quantile knots exactly', () => {
    const f = invCdfSampler(DIST);
    expect(f(0.1)).toBeCloseTo(5, 10);
    expect(f(0.25)).toBeCloseTo(8, 10);
    expect(f(0.5)).toBeCloseTo(12, 10);
    expect(f(0.75)).toBeCloseTo(16, 10);
    expect(f(0.9)).toBeCloseTo(21, 10);
  });

  it('interpolates linearly between knots', () => {
    const f = invCdfSampler(DIST);
    expect(f(0.375)).toBeCloseTo((8 + 12) / 2, 10); // midway 0.25→0.5
    expect(f(0.175)).toBeCloseTo((5 + 8) / 2, 10);
  });

  it('is monotone nondecreasing across [0,1]', () => {
    const f = invCdfSampler(DIST);
    let prev = -Infinity;
    for (let u = 0; u <= 1.0001; u += 0.001) {
      const v = f(u);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = v;
    }
  });

  it('extends tails beyond p10/p90 and clamps at zero', () => {
    const f = invCdfSampler(DIST);
    expect(f(0)).toBeLessThan(f(0.1)); // lower tail below p10
    expect(f(1)).toBeGreaterThan(f(0.9)); // upper tail above p90
    expect(f(0)).toBeGreaterThanOrEqual(0);
    // A near-zero player: lower tail must clamp at 0, never negative.
    const g = invCdfSampler({ pts: 1, p10: 0, p25: 0.2, p75: 2, p90: 4 });
    expect(g(0)).toBe(0);
    for (let u = 0; u <= 1; u += 0.05) expect(g(u)).toBeGreaterThanOrEqual(0);
  });

  it('degenerates to the constant mean when quantiles are missing', () => {
    const f = invCdfSampler({ pts: 7.5, p10: null, p25: null, p75: null, p90: null });
    expect(f(0)).toBe(7.5);
    expect(f(0.5)).toBe(7.5);
    expect(f(1)).toBe(7.5);
  });

  it('recovers the quantiles from seeded draws (round trip)', () => {
    const f = invCdfSampler(DIST);
    const rng = seededRng('test:roundtrip');
    const n = 20_000;
    const draws = new Float64Array(n);
    for (let i = 0; i < n; i++) draws[i] = f(rng());
    draws.sort();
    const q = (p: number) => draws[Math.floor(p * (n - 1))]!;
    expect(q(0.1)).toBeCloseTo(5, 0);
    expect(q(0.5)).toBeCloseTo(12, 0);
    expect(q(0.9)).toBeCloseTo(21, 0);
  });

  it('handles degenerate equal quantiles without NaN', () => {
    const f = invCdfSampler({ pts: 10, p10: 10, p25: 10, p75: 10, p90: 10 });
    for (let u = 0; u <= 1; u += 0.1) expect(f(u)).toBe(10);
  });
});
