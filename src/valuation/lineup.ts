import { FLEX_MAP } from './replacement';

// Exact optimal weekly lineup via transversal-matroid greedy (Kuhn's
// augmenting paths). Plain first-fit greedy is provably suboptimal with
// overlapping flexes (FLEX + REC_FLEX trap — see lineup.test.ts). Iterating
// players in descending points and augmenting yields the max-total lineup.
//
// v1 limitation (documented): bench contributes 0 — insurance value arrives
// with the distribution/Monte Carlo phase via league_weekly_points.

export interface LineupPlayer {
  playerId: string;
  pos: string;
  pts: number;
}

export interface WeekLineup {
  total: number;
  fills: Array<{ slot: string; playerId: string | null; pts: number }>;
}

interface Group {
  label: string;
  accepts: string[];
  cap: number;
  assigned: string[];
}

export function optimalWeekLineup(players: LineupPlayer[], starterSlots: string[]): WeekLineup {
  const groups: Group[] = [];
  for (const slot of starterSlots) {
    const accepts = FLEX_MAP[slot] ?? [slot];
    const existing = groups.find((g) => g.label === slot);
    if (existing) existing.cap++;
    else groups.push({ label: slot, accepts, cap: 1, assigned: [] });
  }

  const byId = new Map(players.map((p) => [p.playerId, p]));
  const candidates = [...players].filter((p) => p.pts > 0).sort((a, b) => b.pts - a.pts);

  function tryAugment(p: LineupPlayer, visited: Set<Group>): boolean {
    for (const g of groups) {
      if (visited.has(g) || !g.accepts.includes(p.pos)) continue;
      visited.add(g);
      if (g.assigned.length < g.cap) {
        g.assigned.push(p.playerId);
        return true;
      }
      for (const occupantId of [...g.assigned]) {
        const occupant = byId.get(occupantId)!;
        if (tryAugment(occupant, visited)) {
          g.assigned[g.assigned.indexOf(occupantId)] = p.playerId;
          return true;
        }
      }
    }
    return false;
  }

  for (const p of candidates) {
    tryAugment(p, new Set());
  }

  const fills: WeekLineup['fills'] = [];
  let total = 0;
  for (const g of groups) {
    for (let i = 0; i < g.cap; i++) {
      const playerId = g.assigned[i] ?? null;
      const pts = playerId ? (byId.get(playerId)?.pts ?? 0) : 0;
      total += pts;
      fills.push({ slot: g.label, playerId, pts });
    }
  }
  return { total, fills };
}

export interface RosterHorizons {
  rosPts: number; // Σ optimal weekly totals, fromWeek..17
  playoffPts: number; // Σ weeks 15..17
  weightedPts: number; // playoff weeks count double
  weeks: Array<{ week: number; total: number }>;
  startsByPos: Record<string, number>;
  emptySlotWeeks: Record<string, number>;
}

const PLAYOFF_WEEKS = new Set([15, 16, 17]);
const PLAYOFF_WEIGHT = 2;

export function rosterHorizons(
  playerIds: string[],
  weeklyPts: Map<string, Float64Array>, // index week-1; missing player/week = 0
  posOf: Map<string, string | null>,
  starterSlots: string[],
  fromWeek: number,
): RosterHorizons {
  const result: RosterHorizons = { rosPts: 0, playoffPts: 0, weightedPts: 0, weeks: [], startsByPos: {}, emptySlotWeeks: {} };

  for (let week = fromWeek; week <= 17; week++) {
    const players: LineupPlayer[] = [];
    for (const id of playerIds) {
      const pos = posOf.get(id);
      if (!pos) continue;
      players.push({ playerId: id, pos, pts: weeklyPts.get(id)?.[week - 1] ?? 0 });
    }
    const lineup = optimalWeekLineup(players, starterSlots);
    result.rosPts += lineup.total;
    result.weeks.push({ week, total: lineup.total });
    const isPlayoff = PLAYOFF_WEEKS.has(week);
    if (isPlayoff) result.playoffPts += lineup.total;
    result.weightedPts += lineup.total * (isPlayoff ? PLAYOFF_WEIGHT : 1);
    for (const fill of lineup.fills) {
      if (fill.playerId) {
        const pos = posOf.get(fill.playerId) ?? '?';
        result.startsByPos[pos] = (result.startsByPos[pos] ?? 0) + 1;
      } else {
        result.emptySlotWeeks[fill.slot] = (result.emptySlotWeeks[fill.slot] ?? 0) + 1;
      }
    }
  }
  return result;
}
