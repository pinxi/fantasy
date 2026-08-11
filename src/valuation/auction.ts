// Auction dollars: $1 floor for every roster spot, remaining budget split
// proportionally to positive value-over-replacement across the draftable pool.

export interface AuctionInput {
  teams: number;
  budget: number; // per-team auction budget
  rosterSize: number; // full roster incl. bench
  inflation: number; // 1.0 = neutral; live knob later
}

export function auctionDollars(
  players: Array<{ playerId: string; points: number; vorp: number }>,
  { teams, budget, rosterSize, inflation }: AuctionInput,
): Map<string, number> {
  const pool = teams * budget * inflation;
  const slots = teams * rosterSize;
  const excess = Math.max(pool - slots, 0);

  const draftable = [...players].sort((a, b) => b.points - a.points).slice(0, slots);
  const totalVorp = draftable.reduce((acc, p) => acc + Math.max(p.vorp, 0), 0);

  const dollars = new Map<string, number>();
  for (const p of draftable) {
    const share = totalVorp > 0 ? Math.max(p.vorp, 0) / totalVorp : 0;
    dollars.set(p.playerId, Math.max(1, Math.round(1 + excess * share)));
  }
  return dollars;
}
