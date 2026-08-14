import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { SEASON } from '@/config';
import { frozenPredictions, frozenTeamPredictions } from '@/db/schema';
import { buildPlayerPosMap } from './compute';
import { optimalWeekLineup, type LineupPlayer } from './lineup';
import { invCdfSampler, seededRng, type PlayerWeekDist } from './samples';

// Freeze the prediction of record for one league-week: copy the latest run's
// weekly rows into frozen_predictions (never pruned, never overwritten) and
// persist each roster's optimal-lineup total with a Monte Carlo band. First
// freeze wins — a re-run after games start must not overwrite the pre-game
// numbers. Uses the same (league:week:player) draw seeds as the live pages.

const DRAWS = 400;

export interface FreezeResult {
  leagueId: string;
  skipped: boolean;
  players: number;
  teams: number;
}

export function freezeWeek(leagueId: string, week: number): FreezeResult {
  const already = db.get<{ n: number }>(
    sql`select count(*) as n from frozen_team_predictions where league_id = ${leagueId} and season = ${SEASON} and week = ${week}`,
  );
  if ((already?.n ?? 0) > 0) return { leagueId, skipped: true, players: 0, teams: 0 };

  const run = db.get<{ id: number }>(sql`select max(id) as id from valuation_runs where league_id = ${leagueId}`);
  if (!run?.id) return { leagueId, skipped: true, players: 0, teams: 0 };
  const rows = db.all<{ player_id: string; pts: number; p10: number | null; p25: number | null; p75: number | null; p90: number | null }>(
    sql`select player_id, pts, p10, p25, p75, p90 from league_weekly_points where run_id = ${run.id} and week = ${week}`,
  );
  if (rows.length === 0) return { leagueId, skipped: true, players: 0, teams: 0 };

  const league = db.get<{ roster_positions: string }>(sql`select roster_positions from leagues where league_id = ${leagueId}`);
  if (!league) return { leagueId, skipped: true, players: 0, teams: 0 };
  const starterSlots = (JSON.parse(league.roster_positions) as string[]).filter((s) => s !== 'BN' && s !== 'IR' && s !== 'TAXI');

  const rosters = db.all<{ roster_id: number; player_ids: string | null; taxi: string | null; reserve: string | null }>(
    sql`select roster_id, player_ids, taxi, reserve from rosters where league_id = ${leagueId}`,
  );
  const posOf = buildPlayerPosMap();
  const byPlayer = new Map<string, PlayerWeekDist>(rows.map((r) => [r.player_id, { pts: r.pts, p10: r.p10, p25: r.p25, p75: r.p75, p90: r.p90 }]));
  const now = Date.now();

  const teamRows = rosters.map((roster) => {
    const taxi = new Set(roster.taxi ? (JSON.parse(roster.taxi) as string[]) : []);
    const reserve = new Set(roster.reserve ? (JSON.parse(roster.reserve) as string[]) : []);
    const ids = (roster.player_ids ? (JSON.parse(roster.player_ids) as string[]) : []).filter((id) => !taxi.has(id) && !reserve.has(id));
    const players: LineupPlayer[] = ids
      .map((id) => ({ playerId: id, pos: posOf.get(id) ?? '', pts: byPlayer.get(id)?.pts ?? 0 }))
      .filter((p) => p.pos);
    const lineup = optimalWeekLineup(players, starterSlots);
    const draws = new Float64Array(DRAWS);
    for (const fill of lineup.fills) {
      if (!fill.playerId) continue;
      const d = byPlayer.get(fill.playerId) ?? { pts: fill.pts, p10: null, p25: null, p75: null, p90: null };
      const sampler = invCdfSampler(d);
      const rng = seededRng(`${leagueId}:${week}:${fill.playerId}`);
      for (let i = 0; i < DRAWS; i++) draws[i]! += sampler(rng());
    }
    const sorted = [...draws].sort((a, b) => a - b);
    return {
      leagueId,
      season: SEASON,
      week,
      rosterId: roster.roster_id,
      total: lineup.total,
      p10: sorted[Math.floor(0.1 * (DRAWS - 1))]!,
      p90: sorted[Math.floor(0.9 * (DRAWS - 1))]!,
      starters: lineup.fills.map((f) => f.playerId ?? ''),
      runId: run.id,
      frozenAt: now,
    };
  });

  db.transaction((tx) => {
    for (const r of rows) {
      tx.insert(frozenPredictions)
        .values({ leagueId, season: SEASON, week, playerId: r.player_id, pts: r.pts, p10: r.p10, p25: r.p25, p75: r.p75, p90: r.p90, runId: run!.id, frozenAt: now })
        .onConflictDoNothing()
        .run();
    }
    for (const t of teamRows) {
      tx.insert(frozenTeamPredictions).values(t).onConflictDoNothing().run();
    }
  });

  return { leagueId, skipped: false, players: rows.length, teams: teamRows.length };
}

export function freezeAllLeagues(week: number): FreezeResult[] {
  const leagues = db.all<{ league_id: string }>(sql`select league_id from leagues where season = ${SEASON}`);
  return leagues.map((l) => freezeWeek(l.league_id, week));
}
