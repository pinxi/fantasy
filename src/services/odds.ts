import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { SEASON } from '@/config';
import { fetchJson } from '@/lib/http';
import { getNflClock } from '@/lib/nfl-clock';
import { buildPlayerPosMap } from '@/valuation/compute';
import { optimalWeekLineup, type LineupPlayer } from '@/valuation/lineup';
import { invCdfSampler, seededRng, type PlayerWeekDist } from '@/valuation/samples';
import { leagueRostersDetailed, leagueShape } from './trade';

// Monte Carlo season simulation: draw every remaining week for every roster
// from the persisted quantiles (common random numbers — same seed convention
// as the week/team pages), walk the real H2H schedule into standings (starting
// from the CURRENT record mid-season), then play the playoff bracket per the
// league's actual settings (start week, team count, re-seeding, two-week
// championship). Odds = fractions over SIMS worlds.
//
// The 500-world sim is too heavy for web requests on the Fly shared vCPU
// (232s → 502), so the worker computes it (valuation.odds job) and persists
// to season_odds_cache; web reads the cache — returning a slightly stale run's
// odds rather than ever simulating inline. On-demand compute happens only when
// no cache row exists at all (fresh league / local dev).

const SIMS = 500;

export interface TeamOdds {
  rosterId: number;
  name: string;
  isMe: boolean;
  expWins: number; // expected FINAL regular-season wins (current + simulated remaining)
  playoffPct: number;
  titlePct: number;
}

export interface SeasonOdds {
  league: string;
  fromWeek: number;
  playoffTeams: number;
  playoffWeekStart: number;
  approximations: string[];
  teams: TeamOdds[];
}

export interface SeasonOddsResult extends SeasonOdds {
  staleRun?: boolean; // served from a previous run's cache (worker refresh pending)
}

async function pairingsForWeek(leagueId: string, week: number): Promise<Map<number, number>> {
  const stored = db.all<{ roster_id: number; matchup_id: number | null }>(
    sql`select roster_id, matchup_id from matchups where league_id = ${leagueId} and week = ${week}`,
  );
  if (stored.length > 0) return new Map(stored.filter((r) => r.matchup_id !== null).map((r) => [r.roster_id, r.matchup_id!]));
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

// Web path: cache-only, never simulates unless no cache row has ever been
// written for the league.
export async function seasonOdds(leagueId: string): Promise<SeasonOddsResult | { error: string }> {
  const run = db.get<{ id: number }>(sql`select max(id) as id from valuation_runs where league_id = ${leagueId}`);
  if (!run?.id) return { error: 'no valuation run — recompute first' };
  const cached = db.get<{ run_id: number; payload: string }>(
    sql`select run_id, payload from season_odds_cache where league_id = ${leagueId}`,
  );
  if (cached) {
    const value = JSON.parse(cached.payload) as SeasonOddsResult;
    if (cached.run_id !== run.id) value.staleRun = true;
    return value;
  }
  return computeSeasonOdds(leagueId, { persist: false });
}

// Worker path: full simulation, persisted for the web to read.
export async function computeSeasonOdds(leagueId: string, opts: { persist: boolean }): Promise<SeasonOdds | { error: string }> {
  const shape = leagueShape(leagueId);
  if (!shape) return { error: `league not found: ${leagueId}` };

  const settingsRow = db.get<{ settings: string }>(sql`select settings from leagues where league_id = ${leagueId}`);
  const settings = settingsRow ? (JSON.parse(settingsRow.settings) as Record<string, number | undefined>) : {};
  const playoffTeams = settings.playoff_teams ?? 0;
  const playoffWeekStart = settings.playoff_week_start ?? 0;
  if (playoffTeams < 2 || playoffWeekStart < 2) {
    return { error: `${shape.name} has no playoff bracket configured (elimination or off-format league)` };
  }
  const roundType = settings.playoff_round_type ?? 0; // 0 = 1wk rounds, 1 = 2wk championship, 2 = 2wk rounds
  const reseed = (settings.playoff_seed_type ?? 0) === 1;

  const run = db.get<{ id: number }>(sql`select max(id) as id from valuation_runs where league_id = ${leagueId}`);
  if (!run?.id) return { error: 'no valuation run — recompute first' };

  const clock = await getNflClock();
  const fromWeek = clock.seasonType === 'regular' ? Math.max(clock.week, 1) : 1;

  const approximations: string[] = [];
  if ((settings.divisions ?? 0) >= 2) approximations.push('division seeding approximated by overall record');

  const rosters = leagueRostersDetailed(leagueId);
  const posOf = buildPlayerPosMap();
  const qRows = db.all<{ player_id: string; week: number; pts: number; p10: number | null; p25: number | null; p75: number | null; p90: number | null }>(
    sql`select player_id, week, pts, p10, p25, p75, p90 from league_weekly_points where run_id = ${run.id}`,
  );
  const dist = new Map<string, PlayerWeekDist>();
  for (const r of qRows) dist.set(`${r.player_id}:${r.week}`, { pts: r.pts, p10: r.p10, p25: r.p25, p75: r.p75, p90: r.p90 });

  // Championship may span two weeks (round_type 1) — sim needs draws through it.
  const rounds = Math.ceil(Math.log2(playoffTeams));
  const champExtra = roundType === 1 ? 1 : 0;
  const lastSimWeek = Math.min(playoffWeekStart + rounds - 1 + champExtra + (roundType === 2 ? rounds : 0), 18);

  // Per (roster, week): draws over the optimal (mean) lineup, CRN across sims.
  const teamWeekDraws = new Map<string, Float64Array>();
  const drawCache = new Map<string, Float64Array>();
  const playerDraws = (playerId: string, week: number): Float64Array => {
    const key = `${playerId}:${week}`;
    let cached = drawCache.get(key);
    if (cached) return cached;
    const d = dist.get(key) ?? { pts: 0, p10: null, p25: null, p75: null, p90: null };
    const sampler = invCdfSampler(d);
    const rng = seededRng(`${leagueId}:${week}:${playerId}`);
    cached = new Float64Array(SIMS);
    for (let i = 0; i < SIMS; i++) cached[i] = sampler(rng());
    drawCache.set(key, cached);
    return cached;
  };
  for (const roster of rosters) {
    const active = roster.players.filter((p) => !p.taxi && !p.reserve && p.playerId);
    for (let week = fromWeek; week <= lastSimWeek; week++) {
      const players: LineupPlayer[] = active
        .map((p) => ({ playerId: p.playerId!, pos: posOf.get(p.playerId!) ?? '', pts: dist.get(`${p.playerId!}:${week}`)?.pts ?? 0 }))
        .filter((p) => p.pos);
      const lineup = optimalWeekLineup(players, shape.starterSlots);
      const total = new Float64Array(SIMS);
      for (const fill of lineup.fills) {
        if (!fill.playerId) continue;
        const draws = playerDraws(fill.playerId, week);
        for (let i = 0; i < SIMS; i++) total[i]! += draws[i]!;
      }
      teamWeekDraws.set(`${roster.rosterId}:${week}`, total);
    }
  }

  // Real schedule for the remaining regular season (parallel — preseason all
  // weeks come from the live API until the matchups job starts persisting).
  const regularWeeks: number[] = [];
  for (let week = fromWeek; week < playoffWeekStart; week++) regularWeeks.push(week);
  const schedule = new Map<number, Map<number, number>>(
    await Promise.all(regularWeeks.map(async (week) => [week, await pairingsForWeek(leagueId, week)] as const)),
  );

  // Standings baseline: current record + points from Sleeper roster settings.
  const baseline = new Map<number, { wins: number; pf: number }>();
  for (const roster of rosters) {
    const row = db.get<{ settings: string | null }>(
      sql`select settings from rosters where league_id = ${leagueId} and roster_id = ${roster.rosterId}`,
    );
    const s = row?.settings ? (JSON.parse(row.settings) as Record<string, number | undefined>) : {};
    baseline.set(roster.rosterId, { wins: s.wins ?? 0, pf: (s.fpts ?? 0) + (s.fpts_decimal ?? 0) / 100 });
  }

  const playoffCount = new Map<number, number>(rosters.map((r) => [r.rosterId, 0]));
  const titleCount = new Map<number, number>(rosters.map((r) => [r.rosterId, 0]));
  const winsSum = new Map<number, number>(rosters.map((r) => [r.rosterId, 0]));

  const drawAt = (rosterId: number, week: number, sim: number): number => teamWeekDraws.get(`${rosterId}:${week}`)?.[sim] ?? 0;
  // Multi-week playoff rounds sum consecutive weeks.
  const roundScore = (rosterId: number, startWeek: number, weeks: number, sim: number): number => {
    let total = 0;
    for (let w = 0; w < weeks; w++) total += drawAt(rosterId, Math.min(startWeek + w, 18), sim);
    return total;
  };

  for (let sim = 0; sim < SIMS; sim++) {
    const wins = new Map<number, number>();
    const pf = new Map<number, number>();
    for (const roster of rosters) {
      wins.set(roster.rosterId, baseline.get(roster.rosterId)!.wins);
      pf.set(roster.rosterId, baseline.get(roster.rosterId)!.pf);
    }
    for (let week = fromWeek; week < playoffWeekStart; week++) {
      const pairs = schedule.get(week)!;
      const byMatchup = new Map<number, number[]>();
      for (const [rosterId, matchupId] of pairs) {
        let arr = byMatchup.get(matchupId);
        if (!arr) byMatchup.set(matchupId, (arr = []));
        arr.push(rosterId);
      }
      for (const ids of byMatchup.values()) {
        if (ids.length !== 2) continue;
        const [a, b] = ids as [number, number];
        const sa = drawAt(a, week, sim);
        const sb = drawAt(b, week, sim);
        pf.set(a, pf.get(a)! + sa);
        pf.set(b, pf.get(b)! + sb);
        if (sa > sb) wins.set(a, wins.get(a)! + 1);
        else if (sb > sa) wins.set(b, wins.get(b)! + 1);
        else wins.set(sa >= sb ? a : b, wins.get(a)! + 0.5); // ties are ~impossible with continuous draws
      }
    }
    for (const roster of rosters) winsSum.set(roster.rosterId, winsSum.get(roster.rosterId)! + wins.get(roster.rosterId)!);

    // Seeding: record then points-for.
    const seeded = [...rosters]
      .map((r) => r.rosterId)
      .sort((a, b) => wins.get(b)! - wins.get(a)! || pf.get(b)! - pf.get(a)!);
    const field = seeded.slice(0, playoffTeams);
    for (const id of field) playoffCount.set(id, playoffCount.get(id)! + 1);

    // Bracket: byes for top seeds when the field isn't a power of two.
    const bracketSize = 2 ** Math.ceil(Math.log2(playoffTeams));
    const byes = bracketSize - playoffTeams;
    let alive = field.slice(0, byes); // bye seeds advance to round 2
    let round1 = field.slice(byes);
    let week = playoffWeekStart;
    // Round 1 among non-bye seeds: highest remaining vs lowest remaining.
    if (round1.length > 0) {
      const weeksThisRound = roundType === 2 ? 2 : 1;
      const winners: number[] = [];
      while (round1.length >= 2) {
        const hi = round1.shift()!;
        const lo = round1.pop()!;
        winners.push(roundScore(hi, week, weeksThisRound, sim) >= roundScore(lo, week, weeksThisRound, sim) ? hi : lo);
      }
      if (round1.length === 1) winners.push(round1[0]!);
      alive = [...alive, ...winners].sort((a, b) => field.indexOf(a) - field.indexOf(b));
      week += weeksThisRound;
    }
    while (alive.length > 1) {
      const isFinal = alive.length === 2;
      const weeksThisRound = roundType === 2 || (roundType === 1 && isFinal) ? 2 : 1;
      const next: number[] = [];
      const pool = reseed ? [...alive].sort((a, b) => field.indexOf(a) - field.indexOf(b)) : alive;
      while (pool.length >= 2) {
        const hi = pool.shift()!;
        const lo = pool.pop()!;
        next.push(roundScore(hi, week, weeksThisRound, sim) >= roundScore(lo, week, weeksThisRound, sim) ? hi : lo);
      }
      if (pool.length === 1) next.push(pool[0]!);
      alive = next;
      week += weeksThisRound;
    }
    if (alive.length === 1) titleCount.set(alive[0]!, titleCount.get(alive[0]!)! + 1);
  }

  const value: SeasonOdds = {
    league: shape.name,
    fromWeek,
    playoffTeams,
    playoffWeekStart,
    approximations,
    teams: rosters
      .map((r) => ({
        rosterId: r.rosterId,
        name: r.ownerName,
        isMe: r.isMe,
        expWins: winsSum.get(r.rosterId)! / SIMS,
        playoffPct: (playoffCount.get(r.rosterId)! / SIMS) * 100,
        titlePct: (titleCount.get(r.rosterId)! / SIMS) * 100,
      }))
      .sort((a, b) => b.titlePct - a.titlePct || b.playoffPct - a.playoffPct),
  };
  if (opts.persist) {
    db.run(sql`
      insert into season_odds_cache (league_id, run_id, payload, computed_at)
      values (${leagueId}, ${run.id}, ${JSON.stringify(value)}, ${Date.now()})
      on conflict(league_id) do update set run_id = excluded.run_id, payload = excluded.payload, computed_at = excluded.computed_at
    `);
  }
  return value;
}
