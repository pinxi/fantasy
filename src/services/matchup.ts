import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { fetchJson } from '@/lib/http';
import { getNflClock } from '@/lib/nfl-clock';
import { buildPlayerPosMap } from '@/valuation/compute';
import { optimalWeekLineup, type LineupPlayer } from '@/valuation/lineup';
import { FLEX_MAP } from '@/valuation/replacement';
import { invCdfSampler, seededRng, type PlayerWeekDist } from '@/valuation/samples';
import { leagueRostersDetailed, leagueShape, type RosterDetail } from './trade';

// Weekly command center: start/sit by WIN PROBABILITY, not expected points.
// Lineup totals are Monte Carlo'd from per-player inverse-CDF draws over the
// persisted quantiles (p10/p25/median/p75/p90) — cheap at request time, no
// graft rebuild. Doctrine: underdogs embrace variance (ceiling players),
// favorites suppress it (floor players); the suggestion rows flag exactly the
// swaps where points and win-odds disagree.

const DRAWS = 400;

interface WeekQuantiles {
  runId: number;
  byPlayer: Map<string, PlayerWeekDist>;
}

function weekQuantiles(leagueId: string, week: number): WeekQuantiles | null {
  const run = db.get<{ id: number }>(sql`select max(id) as id from valuation_runs where league_id = ${leagueId}`);
  if (!run?.id) return null;
  const rows = db.all<{ player_id: string; pts: number; p10: number | null; p25: number | null; p75: number | null; p90: number | null }>(
    sql`select player_id, pts, p10, p25, p75, p90 from league_weekly_points where run_id = ${run.id} and week = ${week}`,
  );
  if (rows.length === 0) return null;
  return {
    runId: run.id,
    byPlayer: new Map(rows.map((r) => [r.player_id, { pts: r.pts, p10: r.p10, p25: r.p25, p75: r.p75, p90: r.p90 }])),
  };
}

async function pairings(leagueId: string, week: number): Promise<Map<number, number>> {
  const stored = db.all<{ roster_id: number; matchup_id: number | null }>(
    sql`select roster_id, matchup_id from matchups where league_id = ${leagueId} and week = ${week}`,
  );
  if (stored.length > 0) {
    return new Map(stored.filter((r) => r.matchup_id !== null).map((r) => [r.roster_id, r.matchup_id!]));
  }
  try {
    const live = await fetchJson<Array<{ roster_id: number; matchup_id: number | null }>>(
      `https://api.sleeper.app/v1/league/${leagueId}/matchups/${week}`,
      { timeoutMs: 15_000 },
    );
    return new Map(live.filter((r) => r.matchup_id !== null).map((r) => [r.roster_id, r.matchup_id!]));
  } catch {
    return new Map();
  }
}

export interface LineupRow {
  slot: string;
  playerId: string | null;
  name: string;
  pos: string;
  mean: number;
  p10: number | null;
  p90: number | null;
}

export interface SwapSuggestion {
  out: string;
  outId: string;
  in: string;
  inId: string;
  slot: string;
  deltaWin: number; // percentage points
  deltaMean: number;
  disagree: boolean; // points and win-odds point different ways
}

export interface WeekReport {
  league: string;
  week: number;
  synthetic: boolean; // no pairing found — opponent is the league median lineup
  myRosterId: number;
  opponentRosterId: number | null;
  opponentName: string;
  winProb: number;
  stance: string;
  myTotalMean: number;
  oppTotalMean: number;
  myLineup: LineupRow[];
  oppLineup: LineupRow[];
  suggestions: SwapSuggestion[];
}

function lineupFor(roster: RosterDetail, dist: WeekQuantiles, posOf: Map<string, string | null>, starterSlots: string[]) {
  const active = roster.players.filter((p) => !p.taxi && !p.reserve);
  const players: LineupPlayer[] = active
    .map((p) => ({ playerId: p.playerId!, pos: posOf.get(p.playerId!) ?? '', pts: dist.byPlayer.get(p.playerId!)?.pts ?? 0 }))
    .filter((p) => p.pos);
  return { lineup: optimalWeekLineup(players, starterSlots), active };
}

export async function weekReport(leagueId: string, weekOverride?: number): Promise<WeekReport | { error: string }> {
  const shape = leagueShape(leagueId);
  if (!shape) return { error: `league not found: ${leagueId}` };
  const clock = await getNflClock();
  const week = weekOverride ?? (clock.seasonType === 'regular' ? Math.max(clock.week, 1) : 1);
  const dist = weekQuantiles(leagueId, week);
  if (!dist) return { error: `no weekly valuation data for week ${week} — recompute first` };

  const rosters = leagueRostersDetailed(leagueId);
  const mine = rosters.find((r) => r.isMe);
  if (!mine) return { error: 'no roster owned by me in this league' };

  const posOf = buildPlayerPosMap();
  const names = new Map(
    db.all<{ sleeper_id: string; full_name: string }>(sql`select sleeper_id, full_name from players`).map((r) => [r.sleeper_id, r.full_name]),
  );

  const pairs = await pairings(leagueId, week);
  const myMatchupId = pairs.get(mine.rosterId);
  const opponent =
    myMatchupId !== undefined
      ? (rosters.find((r) => r.rosterId !== mine.rosterId && pairs.get(r.rosterId) === myMatchupId) ?? null)
      : null;

  const my = lineupFor(mine, dist, posOf, shape.starterSlots);

  // Per-player draws with common random numbers: seeded per (league, week,
  // player) so swap what-ifs reuse identical draws.
  const drawCache = new Map<string, Float64Array>();
  const drawsFor = (playerId: string): Float64Array => {
    let cached = drawCache.get(playerId);
    if (cached) return cached;
    const d = dist.byPlayer.get(playerId) ?? { pts: 0, p10: null, p25: null, p75: null, p90: null };
    const sampler = invCdfSampler(d);
    const rng = seededRng(`${leagueId}:${week}:${playerId}`);
    cached = new Float64Array(DRAWS);
    for (let i = 0; i < DRAWS; i++) cached[i] = sampler(rng());
    drawCache.set(playerId, cached);
    return cached;
  };

  const totalDraws = (playerIds: Array<string | null>): Float64Array => {
    const total = new Float64Array(DRAWS);
    for (const id of playerIds) {
      if (!id) continue;
      const draws = drawsFor(id);
      for (let i = 0; i < DRAWS; i++) total[i]! += draws[i]!;
    }
    return total;
  };

  const myStarters = my.lineup.fills.map((f) => f.playerId);
  const myTotal = totalDraws(myStarters);

  let oppTotal: Float64Array;
  let oppLineup: LineupRow[] = [];
  let opponentName = 'league median';
  let synthetic = true;
  if (opponent) {
    const theirs = lineupFor(opponent, dist, posOf, shape.starterSlots);
    oppTotal = totalDraws(theirs.lineup.fills.map((f) => f.playerId));
    opponentName = opponent.ownerName;
    synthetic = false;
    oppLineup = theirs.lineup.fills.map((f) => ({
      slot: f.slot,
      playerId: f.playerId,
      name: f.playerId ? (names.get(f.playerId) ?? f.playerId) : '(empty)',
      pos: f.playerId ? (posOf.get(f.playerId) ?? '?') : '·',
      mean: f.pts,
      p10: f.playerId ? (dist.byPlayer.get(f.playerId)?.p10 ?? null) : null,
      p90: f.playerId ? (dist.byPlayer.get(f.playerId)?.p90 ?? null) : null,
    }));
  } else {
    // Synthetic opponent: the median of every roster's optimal-lineup mean.
    const means = rosters
      .filter((r) => r.rosterId !== mine.rosterId)
      .map((r) => lineupFor(r, dist, posOf, shape.starterSlots).lineup.total)
      .sort((a, b) => a - b);
    const median = means.length > 0 ? means[Math.floor(means.length / 2)]! : 0;
    oppTotal = new Float64Array(DRAWS).fill(median);
  }

  const winProbOf = (mineDraws: Float64Array): number => {
    let wins = 0;
    for (let i = 0; i < DRAWS; i++) {
      if (mineDraws[i]! > oppTotal[i]!) wins++;
      else if (mineDraws[i]! === oppTotal[i]!) wins += 0.5;
    }
    return wins / DRAWS;
  };
  const winProb = winProbOf(myTotal);

  // Swap what-ifs: bench candidate B replacing starter S when B fits S's slot.
  const starterIds = new Set(myStarters.filter(Boolean) as string[]);
  const bench = my.active.filter((p) => !starterIds.has(p.playerId!) && (dist.byPlayer.get(p.playerId!)?.pts ?? 0) > 0);
  const suggestions: SwapSuggestion[] = [];
  for (const fill of my.lineup.fills) {
    if (!fill.playerId) continue;
    const accepts = FLEX_MAP[fill.slot] ?? [fill.slot];
    for (const candidate of bench) {
      const pos = posOf.get(candidate.playerId!) ?? '';
      if (!accepts.includes(pos)) continue;
      const sDraws = drawsFor(fill.playerId);
      const bDraws = drawsFor(candidate.playerId!);
      const swapped = new Float64Array(DRAWS);
      for (let i = 0; i < DRAWS; i++) swapped[i] = myTotal[i]! - sDraws[i]! + bDraws[i]!;
      const newWin = winProbOf(swapped);
      const deltaWin = (newWin - winProb) * 100;
      const deltaMean = (dist.byPlayer.get(candidate.playerId!)?.pts ?? 0) - (dist.byPlayer.get(fill.playerId)?.pts ?? 0);
      if (Math.abs(deltaWin) < 0.4 && Math.abs(deltaMean) < 0.5) continue;
      suggestions.push({
        out: names.get(fill.playerId) ?? fill.playerId,
        outId: fill.playerId,
        in: names.get(candidate.playerId!) ?? candidate.playerId!,
        inId: candidate.playerId!,
        slot: fill.slot,
        deltaWin,
        deltaMean,
        disagree: (deltaWin > 0.4 && deltaMean < -0.3) || (deltaWin < -0.4 && deltaMean > 0.3),
      });
    }
  }
  suggestions.sort((a, b) => b.deltaWin - a.deltaWin);

  const stance =
    winProb < 0.45
      ? 'underdog — lean ceiling (embrace variance)'
      : winProb > 0.55
        ? 'favorite — lean floor (suppress variance)'
        : 'coin flip — points-maximize';

  let myMean = 0;
  for (const v of myTotal) myMean += v;
  let oppMean = 0;
  for (const v of oppTotal) oppMean += v;

  return {
    league: shape.name,
    week,
    synthetic,
    myRosterId: mine.rosterId,
    opponentRosterId: opponent?.rosterId ?? null,
    opponentName,
    winProb,
    stance,
    myTotalMean: myMean / DRAWS,
    oppTotalMean: oppMean / DRAWS,
    myLineup: my.lineup.fills.map((f) => ({
      slot: f.slot,
      playerId: f.playerId,
      name: f.playerId ? (names.get(f.playerId) ?? f.playerId) : '(empty)',
      pos: f.playerId ? (posOf.get(f.playerId) ?? '?') : '·',
      mean: f.pts,
      p10: f.playerId ? (dist.byPlayer.get(f.playerId)?.p10 ?? null) : null,
      p90: f.playerId ? (dist.byPlayer.get(f.playerId)?.p90 ?? null) : null,
    })),
    oppLineup,
    suggestions: suggestions.slice(0, 10),
  };
}
