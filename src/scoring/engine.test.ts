import { describe, expect, it } from 'vitest';
import { componentBuckets, scoreBreakdown, scoreStatLine } from './engine';

describe('scoreStatLine', () => {
  it('computes a dot product over shared keys', () => {
    expect(scoreStatLine({ rush_yd: 100, rush_td: 1 }, { rush_yd: 0.1, rush_td: 6 })).toBeCloseTo(16, 10);
  });

  it('applies negative weights (turnovers, sacks against QB)', () => {
    expect(scoreStatLine({ pass_int: 2, fum_lost: 1 }, { pass_int: -2, fum_lost: -2 })).toBe(-6);
  });

  it('handles fractional weights like Squidward KR 1/17', () => {
    expect(scoreStatLine({ kr_yd: 34 }, { kr_yd: 1 / 17 })).toBeCloseTo(2, 10);
  });

  it('ignores stats with no scoring weight and weights with no stat', () => {
    expect(scoreStatLine({ rec: 5, rec_yd: 50 }, { rush_yd: 0.1 })).toBe(0);
    expect(scoreStatLine({}, { rec: 1 })).toBe(0);
  });

  it('skips zero weights entirely', () => {
    expect(scoreStatLine({ rec_fd: 4 }, { rec_fd: 0 })).toBe(0);
  });
});

describe('scoreBreakdown + componentBuckets', () => {
  it('buckets FD, returns, bonuses, and base separately', () => {
    const breakdown = scoreBreakdown(
      { rec: 5, rec_yd: 62, rec_fd: 3, kr_yd: 40, bonus_rush_rec_yd_100: 1 },
      { rec: 1, rec_yd: 0.1, rec_fd: 0.5, kr_yd: 0.1, bonus_rush_rec_yd_100: 2 },
    );
    const buckets = componentBuckets(breakdown);
    expect(buckets.base).toBeCloseTo(11.2, 10);
    expect(buckets.fd).toBeCloseTo(1.5, 10);
    expect(buckets.kr_pr).toBeCloseTo(4, 10);
    expect(buckets.bonus).toBe(2);
  });
});
