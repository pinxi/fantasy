import { describe, expect, it } from 'vitest';
import { optimalWeekLineup, type LineupPlayer } from './lineup';

function p(playerId: string, pos: string, pts: number): LineupPlayer {
  return { playerId, pos, pts };
}

describe('optimalWeekLineup', () => {
  it('beats first-fit greedy on the overlapping-flex trap', () => {
    // Greedy seats WR20 in FLEX and strands RB19 (38). Optimal reseats WR20
    // into REC_FLEX so RB19 starts (39).
    const result = optimalWeekLineup([p('a', 'WR', 20), p('b', 'RB', 19), p('c', 'WR', 18)], ['FLEX', 'REC_FLEX']);
    expect(result.total).toBe(39);
  });

  it('spills the second QB into SUPER_FLEX', () => {
    const result = optimalWeekLineup([p('a', 'QB', 25), p('b', 'QB', 20), p('c', 'RB', 12)], ['QB', 'SUPER_FLEX']);
    expect(result.total).toBe(45);
  });

  it('fills IDP_FLEX from DL/LB/DB', () => {
    const result = optimalWeekLineup([p('a', 'LB', 11), p('b', 'DB', 9), p('c', 'DL', 8)], ['LB', 'IDP_FLEX']);
    expect(result.total).toBe(20);
  });

  it('benches zero-point players (byes) and marks unfillable slots null', () => {
    const result = optimalWeekLineup([p('a', 'RB', 0), p('b', 'WR', 7)], ['RB', 'WR']);
    expect(result.total).toBe(7);
    const rbFill = result.fills.find((f) => f.slot === 'RB')!;
    expect(rbFill.playerId).toBeNull();
  });

  it('matches brute force on random instances', () => {
    const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
    const SLOT_CHOICES = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'SUPER_FLEX', 'REC_FLEX', 'WRRB_FLEX'];
    const FLEX_ACCEPTS: Record<string, string[]> = {
      FLEX: ['RB', 'WR', 'TE'],
      SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
      REC_FLEX: ['WR', 'TE'],
      WRRB_FLEX: ['WR', 'RB'],
    };

    // Deterministic LCG so failures reproduce.
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;

    function bruteForce(players: LineupPlayer[], slots: string[]): number {
      let best = 0;
      const used = new Array(players.length).fill(false) as boolean[];
      const recurse = (slotIndex: number, total: number): void => {
        if (slotIndex === slots.length) {
          best = Math.max(best, total);
          return;
        }
        const accepts = FLEX_ACCEPTS[slots[slotIndex]!] ?? [slots[slotIndex]!];
        recurse(slotIndex + 1, total); // leave slot empty
        for (let i = 0; i < players.length; i++) {
          if (used[i] || !accepts.includes(players[i]!.pos)) continue;
          used[i] = true;
          recurse(slotIndex + 1, total + players[i]!.pts);
          used[i] = false;
        }
      };
      recurse(0, 0);
      return best;
    }

    for (let trial = 0; trial < 500; trial++) {
      const playerCount = 1 + Math.floor(rand() * 8);
      const slotCount = 1 + Math.floor(rand() * 5);
      const players: LineupPlayer[] = Array.from({ length: playerCount }, (_, i) =>
        p(`p${i}`, POSITIONS[Math.floor(rand() * POSITIONS.length)]!, Math.round(rand() * 30 * 10) / 10),
      );
      const slots = Array.from({ length: slotCount }, () => SLOT_CHOICES[Math.floor(rand() * SLOT_CHOICES.length)]!);
      const expected = bruteForce(players, slots);
      const actual = optimalWeekLineup(players, slots).total;
      expect(actual, `trial ${trial}: slots=${slots.join(',')} players=${players.map((x) => `${x.pos}:${x.pts}`).join(',')}`).toBeCloseTo(
        expected,
        6,
      );
    }
  });
});
