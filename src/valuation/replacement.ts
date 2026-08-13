// Slot-filling replacement levels: fill every starting slot across the league
// greedily by points (dedicated slots first, then compatible flexes); the
// replacement level for a position is the best player left unassigned. This is
// what makes superflex QB inflation and 3-FLEX depth emerge naturally.

export const FLEX_MAP: Record<string, string[]> = {
  FLEX: ['RB', 'WR', 'TE'],
  WRRB_FLEX: ['WR', 'RB'],
  WRRBTE_FLEX: ['RB', 'WR', 'TE'],
  REC_FLEX: ['WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  IDP_FLEX: ['DL', 'LB', 'DB'],
};

const DIRECT_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB']);

const POS_ALIASES: Record<string, string> = {
  FB: 'RB',
  ILB: 'LB',
  OLB: 'LB',
  DE: 'DL',
  DT: 'DL',
  NT: 'DL',
  CB: 'DB',
  S: 'DB',
  FS: 'DB',
  SS: 'DB',
};

export function normalizePos(pos: string | null | undefined): string | null {
  if (!pos) return null;
  const upper = pos.toUpperCase();
  if (DIRECT_POSITIONS.has(upper)) return upper;
  return POS_ALIASES[upper] ?? null;
}

export interface RankedPlayer {
  playerId: string;
  pos: string;
  points: number;
}

export interface ReplacementResult {
  levels: Record<string, number>;
  starterCounts: Record<string, number>;
  totalStarterSlots: number;
}

export function replacementLevels(players: RankedPlayer[], rosterPositions: string[], teams: number): ReplacementResult {
  const dedicated: Record<string, number> = {};
  const flexes: Array<{ accepts: string[]; open: number }> = [];
  let totalStarterSlots = 0;

  const starterSlots = rosterPositions.filter((slot) => slot !== 'BN' && slot !== 'IR' && slot !== 'TAXI');
  for (const slot of starterSlots) {
    totalStarterSlots += teams;
    if (DIRECT_POSITIONS.has(slot)) {
      dedicated[slot] = (dedicated[slot] ?? 0) + teams;
    } else if (FLEX_MAP[slot]) {
      const existing = flexes.find((f) => f.accepts.join() === FLEX_MAP[slot]!.join());
      if (existing) existing.open += teams;
      else flexes.push({ accepts: FLEX_MAP[slot]!, open: teams });
    }
  }

  const sorted = [...players].sort((a, b) => b.points - a.points);
  const starterCounts: Record<string, number> = {};
  const levels: Record<string, number> = {};

  for (const player of sorted) {
    if (dedicated[player.pos] && dedicated[player.pos]! > 0) {
      dedicated[player.pos]!--;
      starterCounts[player.pos] = (starterCounts[player.pos] ?? 0) + 1;
      continue;
    }
    const flex = flexes.find((f) => f.open > 0 && f.accepts.includes(player.pos));
    if (flex) {
      flex.open--;
      starterCounts[player.pos] = (starterCounts[player.pos] ?? 0) + 1;
      continue;
    }
    // First unassigned player at each position defines its replacement level.
    if (levels[player.pos] === undefined) levels[player.pos] = player.points;
  }

  return { levels, starterCounts, totalStarterSlots };
}
