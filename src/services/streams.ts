import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { SLEEPER_USER_ID } from '@/config';
import { buildPlayerPosMap } from '@/valuation/compute';
import { optimalWeekLineup, type LineupPlayer } from '@/valuation/lineup';
import { leagueShape, replacementFromRun, weeklyPointsForLeague } from './trade';

// Stream-vs-hold intelligence. Streamer baseline per (league, pos, week) =
// mean of the top-K free agents' league-scored points that week. A bench
// player whose expected points sit below what the wire hands you weekly is a
// stream candidate — his roster spot is worth more as a lottery stash.
// (VBD doctrine per the Subvertadown baselines guide: draft $ keep the
// starter baseline; the streamer-adjusted view is for roster decisions only.)
// Preseason this runs on projections; once 2026 actuals land the same weekly
// table reflects them via revaluation — no code change.

const TOP_K = 2;

export interface PositionStreamability {
  pos: string;
  faCount: number;
  baselineAvg: number; // avg of weekly top-K FA points
  replacement: number; // draft-time replacement level
  streamable: boolean; // wire keeps pace with rosterable depth
  weekly: number[]; // per-week baseline, index week-1
}

export interface HoldVerdict {
  playerId: string;
  name: string;
  pos: string;
  taxi: boolean;
  reserve: boolean;
  starts: number; // weeks in my optimal lineup
  avgPts: number; // per-week avg (active weeks)
  baselineAvg: number;
  margin: number; // avgPts - baselineAvg
  verdict: 'hold' | 'coin-flip' | 'stream';
  subvertadownRank: number | null;
}

export interface StreamsReport {
  league: string;
  fromWeek: number;
  positions: PositionStreamability[];
  myVerdicts: HoldVerdict[];
}

export function streamsReport(leagueId: string, fromWeek = 1): StreamsReport | { error: string } {
  const shape = leagueShape(leagueId);
  if (!shape) return { error: `league not found: ${leagueId}` };
  const weekly = weeklyPointsForLeague(leagueId);
  if (!weekly) return { error: 'no weekly valuation data — recompute first' };

  const posOf = buildPlayerPosMap();
  const rosteredRows = db.all<{ player_ids: string | null; taxi: string | null; reserve: string | null; owner_id: string | null }>(
    sql`select player_ids, taxi, reserve, owner_id from rosters where league_id = ${leagueId}`,
  );
  const rostered = new Set<string>();
  let myIds: string[] = [];
  const myTaxi = new Set<string>();
  const myReserve = new Set<string>();
  for (const row of rosteredRows) {
    const ids = row.player_ids ? (JSON.parse(row.player_ids) as string[]) : [];
    for (const id of ids) rostered.add(id);
    if (row.owner_id === SLEEPER_USER_ID) {
      myIds = ids;
      for (const id of row.taxi ? (JSON.parse(row.taxi) as string[]) : []) myTaxi.add(id);
      for (const id of row.reserve ? (JSON.parse(row.reserve) as string[]) : []) myReserve.add(id);
    }
  }

  // Positions that exist in this league's starting slots (direct or via flex).
  const leaguePositions = new Set<string>();
  for (const slot of shape.starterSlots) {
    for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB']) {
      if (slot === pos) leaguePositions.add(pos);
    }
  }
  for (const slot of shape.starterSlots) {
    if (slot === 'FLEX' || slot === 'WRRB_FLEX' || slot === 'REC_FLEX') ['RB', 'WR', 'TE'].forEach((p) => leaguePositions.add(p));
    if (slot === 'SUPER_FLEX') ['QB', 'RB', 'WR', 'TE'].forEach((p) => leaguePositions.add(p));
    if (slot === 'IDP_FLEX') ['DL', 'LB', 'DB'].forEach((p) => leaguePositions.add(p));
  }

  // Weekly top-K free-agent baseline per position.
  const replacement = replacementFromRun(leagueId);
  const positions: PositionStreamability[] = [];
  const baselineByPos = new Map<string, { weekly: number[]; avg: number }>();
  for (const pos of leaguePositions) {
    const faIds = [...weekly.pts.keys()].filter((id) => !rostered.has(id) && posOf.get(id) === pos);
    const perWeek: number[] = [];
    for (let week = fromWeek; week <= 17; week++) {
      const top = faIds
        .map((id) => weekly.pts.get(id)?.[week - 1] ?? 0)
        .sort((a, b) => b - a)
        .slice(0, TOP_K);
      perWeek.push(top.length > 0 ? top.reduce((a, b) => a + b, 0) / top.length : 0);
    }
    const avg = perWeek.length > 0 ? perWeek.reduce((a, b) => a + b, 0) / perWeek.length : 0;
    const repl = replacement[pos] ?? 0;
    const replPerWeek = repl / 17;
    baselineByPos.set(pos, { weekly: perWeek, avg });
    positions.push({
      pos,
      faCount: faIds.length,
      baselineAvg: avg,
      replacement: replPerWeek,
      streamable: avg >= replPerWeek * 0.85,
      weekly: perWeek,
    });
  }
  positions.sort((a, b) => b.baselineAvg / Math.max(b.replacement, 0.1) - a.baselineAvg / Math.max(a.replacement, 0.1));

  // My weekly optimal-lineup starts (who actually plays).
  const starts = new Map<string, number>();
  const activeMine = myIds.filter((id) => !myTaxi.has(id) && !myReserve.has(id));
  for (let week = fromWeek; week <= 17; week++) {
    const players: LineupPlayer[] = activeMine
      .map((id) => ({ playerId: id, pos: posOf.get(id) ?? '', pts: weekly.pts.get(id)?.[week - 1] ?? 0 }))
      .filter((p) => p.pos);
    const lineup = optimalWeekLineup(players, shape.starterSlots);
    for (const fill of lineup.fills) {
      if (fill.playerId) starts.set(fill.playerId, (starts.get(fill.playerId) ?? 0) + 1);
    }
  }

  const subRanks = new Map(
    db
      .all<{ player_id: string; rank: number }>(sql`
        select player_id, rank from ranking_snapshots
        where source = 'subvertadown'
          and snapshot_date = (select max(snapshot_date) from ranking_snapshots where source = 'subvertadown')
      `)
      .map((r) => [r.player_id, r.rank]),
  );

  const names = new Map(
    db.all<{ sleeper_id: string; full_name: string }>(sql`select sleeper_id, full_name from players`).map((r) => [r.sleeper_id, r.full_name]),
  );

  const weeksCount = 17 - fromWeek + 1;
  const myVerdicts: HoldVerdict[] = myIds
    .map((id) => {
      const pos = posOf.get(id) ?? '?';
      const arr = weekly.pts.get(id);
      const active = arr ? [...arr.slice(fromWeek - 1, 17)].filter((v) => v > 0) : [];
      const avgPts = active.length > 0 ? active.reduce((a, b) => a + b, 0) / active.length : 0;
      const baselineAvg = baselineByPos.get(pos)?.avg ?? 0;
      const margin = avgPts - baselineAvg;
      const startCount = starts.get(id) ?? 0;
      // Taxi/IR players occupy dedicated slots, not bench spots — holding them
      // is free, so they never draw a "stream" verdict.
      const verdict: HoldVerdict['verdict'] =
        myTaxi.has(id) || myReserve.has(id)
          ? 'hold'
          : startCount >= weeksCount * 0.5 || margin >= 1
            ? 'hold'
            : margin >= -1
              ? 'coin-flip'
              : 'stream';
      return {
        playerId: id,
        name: names.get(id) ?? id,
        pos,
        taxi: myTaxi.has(id),
        reserve: myReserve.has(id),
        starts: startCount,
        avgPts,
        baselineAvg,
        margin,
        verdict,
        subvertadownRank: subRanks.get(id) ?? null,
      };
    })
    .sort((a, b) => a.margin - b.margin);

  return { league: shape.name, fromWeek, positions, myVerdicts };
}
