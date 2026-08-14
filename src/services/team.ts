import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { SEASON } from '@/config';
import { getNflClock } from '@/lib/nfl-clock';
import { buildPlayerPosMap } from '@/valuation/compute';
import { optimalWeekLineup, type LineupPlayer } from '@/valuation/lineup';
import { invCdfSampler, seededRng, type PlayerWeekDist } from '@/valuation/samples';
import { teamAccuracy, leagueCalibration, type LeagueCalibration, type TeamWeekAccuracy } from './accuracy';
import { leagueRostersDetailed, leagueShape, marketMap, weeklyPointsForLeague, type RosterDetail } from './trade';

// Team pages: the roster as a portfolio. Predicted side = optimal-lineup
// weekly means + Monte Carlo season band from the persisted quantiles (same
// seeds as the week page, so numbers agree). Historical side = the full
// previous_league_id chain (2021+ where archived): records and points straight
// from Sleeper's roster settings, all-play/luck and H2H recomputed from the
// backfilled matchup grids. Prediction-vs-actual trend lines accrue in-season
// once the freeze job lands — history before Aug 2026 has no archived predictions.

const LAST_WEEK = 17; // fantasy regular season + playoffs end (wk 18 unused by our leagues)
const DRAWS = 400;

export interface TeamSummary {
  rosterId: number;
  name: string;
  isMe: boolean;
  record: { wins: number; losses: number; ties: number } | null;
  rosTotal: number;
  playoffTotal: number;
  marketTotal: number;
  posPoints: Record<string, number>;
}

interface LeagueTeams {
  shape: NonNullable<ReturnType<typeof leagueShape>>;
  fromWeek: number;
  teams: TeamSummary[];
  rosters: RosterDetail[];
  weekly: Map<string, Float64Array>;
  posOf: Map<string, string | null>;
  market: Map<string, number>;
  lineupsByRoster: Map<number, Map<number, Array<{ slot: string; playerId: string | null; pts: number }>>>;
}

async function computeLeagueTeams(leagueId: string): Promise<LeagueTeams | null> {
  const shape = leagueShape(leagueId);
  if (!shape) return null;
  const weekly = weeklyPointsForLeague(leagueId);
  if (!weekly) return null;
  const clock = await getNflClock();
  const fromWeek = clock.seasonType === 'regular' ? Math.max(clock.week, 1) : 1;
  const rosters = leagueRostersDetailed(leagueId);
  const posOf = buildPlayerPosMap();
  const market = marketMap(shape.format, 'fantasycalc');
  const settingsRow = db.get<{ settings: string }>(sql`select settings from leagues where league_id = ${leagueId}`);
  const playoffStart = (settingsRow ? ((JSON.parse(settingsRow.settings) as { playoff_week_start?: number }).playoff_week_start ?? 15) : 15) || 15;

  const teams: TeamSummary[] = [];
  const lineupsByRoster = new Map<number, Map<number, Array<{ slot: string; playerId: string | null; pts: number }>>>();
  for (const roster of rosters) {
    const active = roster.players.filter((p) => !p.taxi && !p.reserve && p.playerId);
    let rosTotal = 0;
    let playoffTotal = 0;
    const posPoints: Record<string, number> = {};
    const byWeek = new Map<number, Array<{ slot: string; playerId: string | null; pts: number }>>();
    for (let week = fromWeek; week <= LAST_WEEK; week++) {
      const players: LineupPlayer[] = active
        .map((p) => ({
          playerId: p.playerId!,
          pos: posOf.get(p.playerId!) ?? '',
          pts: weekly.pts.get(p.playerId!)?.[week - 1] ?? 0,
        }))
        .filter((p) => p.pos);
      const lineup = optimalWeekLineup(players, shape.starterSlots);
      byWeek.set(week, lineup.fills);
      rosTotal += lineup.total;
      if (week >= playoffStart) playoffTotal += lineup.total;
      for (const fill of lineup.fills) {
        if (!fill.playerId) continue;
        const pos = posOf.get(fill.playerId) ?? '?';
        posPoints[pos] = (posPoints[pos] ?? 0) + fill.pts;
      }
    }
    const marketTotal = roster.players.reduce((sum, p) => sum + (p.playerId ? (market.get(p.playerId) ?? 0) : 0), 0);
    const settings = currentSettings(leagueId, roster.rosterId);
    teams.push({
      rosterId: roster.rosterId,
      name: roster.ownerName,
      isMe: roster.isMe,
      record: settings && settings.wins + settings.losses + settings.ties > 0 ? { wins: settings.wins, losses: settings.losses, ties: settings.ties } : null,
      rosTotal,
      playoffTotal,
      marketTotal,
      posPoints,
    });
    lineupsByRoster.set(roster.rosterId, byWeek);
  }
  teams.sort((a, b) => b.rosTotal - a.rosTotal);
  return { shape, fromWeek, teams, rosters, weekly: weekly.pts, posOf, market, lineupsByRoster };
}

interface RosterSettings {
  wins: number;
  losses: number;
  ties: number;
  fpts: number;
  fptsAgainst: number;
  ppts: number;
}

function parseSettings(raw: string | null): RosterSettings | null {
  if (!raw) return null;
  const s = JSON.parse(raw) as Record<string, number | undefined>;
  const dec = (whole?: number, frac?: number) => (whole ?? 0) + (frac ?? 0) / 100;
  return {
    wins: s.wins ?? 0,
    losses: s.losses ?? 0,
    ties: s.ties ?? 0,
    fpts: dec(s.fpts, s.fpts_decimal),
    fptsAgainst: dec(s.fpts_against, s.fpts_against_decimal),
    ppts: dec(s.ppts, s.ppts_decimal),
  };
}

function currentSettings(leagueId: string, rosterId: number): RosterSettings | null {
  const row = db.get<{ settings: string | null }>(
    sql`select settings from rosters where league_id = ${leagueId} and roster_id = ${rosterId}`,
  );
  return row ? parseSettings(row.settings) : null;
}

export interface TeamsOverview {
  league: string;
  fromWeek: number;
  teams: TeamSummary[];
}

export async function teamsOverview(leagueId: string): Promise<TeamsOverview | { error: string }> {
  const computed = await computeLeagueTeams(leagueId);
  if (!computed) return { error: 'league not found or no valuation run — recompute first' };
  return { league: computed.shape.name, fromWeek: computed.fromWeek, teams: computed.teams };
}

// ---------- history ----------

interface AncestorLeague {
  leagueId: string;
  season: number;
  name: string;
}

function ancestry(currentLeagueId: string): AncestorLeague[] {
  const chain: AncestorLeague[] = [];
  let id: string | null = currentLeagueId;
  while (id && id !== '0' && chain.length < 12) {
    const row: { league_id: string; season: number; name: string; previous_league_id: string | null } | undefined = db.get(
      sql`select league_id, season, name, previous_league_id from leagues where league_id = ${id}`,
    );
    if (!row) break;
    chain.push({ leagueId: row.league_id, season: row.season, name: row.name });
    id = row.previous_league_id;
  }
  return chain;
}

export interface SeasonHistory {
  season: number;
  leagueName: string;
  record: { wins: number; losses: number; ties: number } | null; // null = elimination format or no H2H
  pf: number;
  pa: number;
  ppts: number;
  efficiency: number | null; // fpts / potential points — lineup-setting quality
  allPlayPct: number | null;
  luckDelta: number | null; // actual win% - all-play win%; positive = schedule luck
  weeklyPoints: Array<{ week: number; points: number }>;
}

export interface H2hRecord {
  ownerId: string;
  name: string;
  wins: number;
  losses: number;
  ties: number;
  pf: number;
  pa: number;
}

function teamHistory(currentLeagueId: string, ownerId: string): { seasons: SeasonHistory[]; h2h: H2hRecord[] } {
  const chain = ancestry(currentLeagueId).filter((a) => a.season < SEASON);
  const currentOwners = new Map(
    db
      .all<{ user_id: string; display_name: string | null; team_name: string | null }>(
        sql`select user_id, display_name, team_name from league_users where league_id = ${currentLeagueId}`,
      )
      .map((u) => [u.user_id, u.team_name ?? u.display_name ?? u.user_id]),
  );

  const seasons: SeasonHistory[] = [];
  const h2hByOwner = new Map<string, H2hRecord>();

  for (const anc of chain) {
    const myRoster = db.get<{ roster_id: number; settings: string | null }>(
      sql`select roster_id, settings from rosters where league_id = ${anc.leagueId} and owner_id = ${ownerId}`,
    );
    if (!myRoster) continue;
    const grid = db.all<{ week: number; roster_id: number; matchup_id: number | null; points: number | null }>(
      sql`select week, roster_id, matchup_id, points from matchups where league_id = ${anc.leagueId} and points is not null`,
    );
    if (grid.length === 0) continue; // league created but never played
    const played = grid.filter((g) => g.points! > 0);
    if (played.length === 0) continue;

    const settings = parseSettings(myRoster.settings);
    const mineByWeek = new Map(grid.filter((g) => g.roster_id === myRoster.roster_id).map((g) => [g.week, g]));

    // All-play: my score vs every other score that week.
    let apWins = 0;
    let apGames = 0;
    const weeklyPoints: Array<{ week: number; points: number }> = [];
    const weeks = [...new Set(grid.map((g) => g.week))].sort((a, b) => a - b);
    for (const week of weeks) {
      const mine = mineByWeek.get(week);
      if (!mine || mine.points === null || mine.points === 0) continue;
      weeklyPoints.push({ week, points: mine.points });
      for (const other of grid) {
        if (other.week !== week || other.roster_id === myRoster.roster_id || other.points === null || other.points === 0) continue;
        if (mine.points > other.points) apWins++;
        else if (mine.points === other.points) apWins += 0.5;
        apGames++;
      }
    }
    const allPlayPct = apGames > 0 ? apWins / apGames : null;

    const hasH2h = settings !== null && settings.wins + settings.losses + settings.ties > 0;
    const winPct = hasH2h ? settings.wins / (settings.wins + settings.losses + settings.ties) : null;

    seasons.push({
      season: anc.season,
      leagueName: anc.name,
      record: hasH2h ? { wins: settings.wins, losses: settings.losses, ties: settings.ties } : null,
      pf: settings?.fpts ?? 0,
      pa: settings?.fptsAgainst ?? 0,
      ppts: settings?.ppts ?? 0,
      efficiency: settings && settings.ppts > 0 ? settings.fpts / settings.ppts : null,
      allPlayPct,
      luckDelta: winPct !== null && allPlayPct !== null ? winPct - allPlayPct : null,
      weeklyPoints,
    });

    // H2H: pair rosters sharing (week, matchup_id); attribute by that season's owner.
    const ownerOfRoster = new Map(
      db
        .all<{ roster_id: number; owner_id: string | null }>(sql`select roster_id, owner_id from rosters where league_id = ${anc.leagueId}`)
        .map((r) => [r.roster_id, r.owner_id]),
    );
    for (const mine of grid) {
      if (mine.roster_id !== myRoster.roster_id || mine.matchup_id === null || mine.points === null || mine.points === 0) continue;
      const opp = grid.find(
        (g) => g.week === mine.week && g.matchup_id === mine.matchup_id && g.roster_id !== mine.roster_id,
      );
      if (!opp || opp.points === null || (opp.points === 0 && mine.points === 0)) continue;
      const oppOwner = ownerOfRoster.get(opp.roster_id);
      if (!oppOwner || !currentOwners.has(oppOwner)) continue; // only rivals still in the league
      let rec = h2hByOwner.get(oppOwner);
      if (!rec) h2hByOwner.set(oppOwner, (rec = { ownerId: oppOwner, name: currentOwners.get(oppOwner)!, wins: 0, losses: 0, ties: 0, pf: 0, pa: 0 }));
      if (mine.points > opp.points) rec.wins++;
      else if (mine.points < opp.points) rec.losses++;
      else rec.ties++;
      rec.pf += mine.points;
      rec.pa += opp.points;
    }
  }

  seasons.sort((a, b) => b.season - a.season);
  const h2h = [...h2hByOwner.values()].sort((a, b) => b.wins + b.losses + b.ties - (a.wins + a.losses + a.ties));
  return { seasons, h2h };
}

// ---------- detail ----------

export interface TeamRosterRow {
  playerId: string;
  name: string;
  pos: string;
  team: string | null;
  age: number | null;
  rosPts: number;
  market: number;
  seasonP10: number | null;
  seasonP90: number | null;
  taxi: boolean;
  reserve: boolean;
}

export interface PosStrength {
  pos: string;
  mine: number;
  leagueMedian: number;
  rank: number; // 1 = best in league
  teams: number;
}

export interface TeamDetail {
  league: string;
  leagueId: string;
  fromWeek: number;
  summary: TeamSummary;
  rosRank: number;
  marketRank: number;
  weeklySeries: Array<{ week: number; mean: number; p10: number; p90: number }>;
  seasonBand: { mean: number; p10: number; p90: number };
  roster: TeamRosterRow[];
  posStrength: PosStrength[];
  ageProfile: { valueWeightedAge: number | null; buckets: Array<{ label: string; share: number }> };
  marketTrend: Array<{ date: string; total: number }>;
  history: { seasons: SeasonHistory[]; h2h: H2hRecord[] };
  fiveYear: { wins: number; losses: number; ties: number; avgPfPerWeek: number | null; avgEfficiency: number | null } | null;
  accuracy: TeamWeekAccuracy[]; // frozen predicted vs actual, accrues in-season
  calibration: LeagueCalibration;
}

export async function teamDetail(leagueId: string, rosterId: number): Promise<TeamDetail | { error: string }> {
  const computed = await computeLeagueTeams(leagueId);
  if (!computed) return { error: 'league not found or no valuation run — recompute first' };
  const { shape, fromWeek, teams, rosters, posOf, market } = computed;
  const summary = teams.find((t) => t.rosterId === rosterId);
  const roster = rosters.find((r) => r.rosterId === rosterId);
  if (!summary || !roster) return { error: `no roster ${rosterId} in ${shape.name}` };

  // Monte Carlo weekly bands: same per-(league, week, player) seeds as the week
  // page, summed over the mean-optimal starters; season band sums index-aligned
  // draws (common random numbers across weeks).
  const runId = db.get<{ id: number }>(sql`select max(id) as id from valuation_runs where league_id = ${leagueId}`)!.id;
  const qRows = db.all<{ player_id: string; week: number; pts: number; p10: number | null; p25: number | null; p75: number | null; p90: number | null }>(
    sql`select player_id, week, pts, p10, p25, p75, p90 from league_weekly_points where run_id = ${runId}`,
  );
  const distByPlayerWeek = new Map<string, PlayerWeekDist>();
  for (const r of qRows) distByPlayerWeek.set(`${r.player_id}:${r.week}`, { pts: r.pts, p10: r.p10, p25: r.p25, p75: r.p75, p90: r.p90 });

  const lineups = computed.lineupsByRoster.get(rosterId)!;
  const seasonDraws = new Float64Array(DRAWS);
  const weeklySeries: Array<{ week: number; mean: number; p10: number; p90: number }> = [];
  for (let week = fromWeek; week <= LAST_WEEK; week++) {
    const fills = lineups.get(week) ?? [];
    const weekDraws = new Float64Array(DRAWS);
    let mean = 0;
    for (const fill of fills) {
      if (!fill.playerId) continue;
      mean += fill.pts;
      const d = distByPlayerWeek.get(`${fill.playerId}:${week}`) ?? { pts: fill.pts, p10: null, p25: null, p75: null, p90: null };
      const sampler = invCdfSampler(d);
      const rng = seededRng(`${leagueId}:${week}:${fill.playerId}`);
      for (let i = 0; i < DRAWS; i++) weekDraws[i]! += sampler(rng());
    }
    for (let i = 0; i < DRAWS; i++) seasonDraws[i]! += weekDraws[i]!;
    const sorted = [...weekDraws].sort((a, b) => a - b);
    weeklySeries.push({ week, mean, p10: sorted[Math.floor(0.1 * (DRAWS - 1))]!, p90: sorted[Math.floor(0.9 * (DRAWS - 1))]! });
  }
  const seasonSorted = [...seasonDraws].sort((a, b) => a - b);
  const seasonBand = {
    mean: summary.rosTotal,
    p10: seasonSorted[Math.floor(0.1 * (DRAWS - 1))]!,
    p90: seasonSorted[Math.floor(0.9 * (DRAWS - 1))]!,
  };

  // Roster table: season points/quantiles from the latest run + age from player meta.
  const ids = roster.players.filter((p) => p.playerId).map((p) => p.playerId!);
  const lvRows = new Map(
    db
      .all<{ player_id: string; points: number; quantiles: string | null }>(
        sql`select player_id, points, quantiles from league_values where run_id = ${runId}`,
      )
      .map((r) => [r.player_id, r]),
  );
  const metaRows = new Map(
    db
      .all<{ sleeper_id: string; full_name: string; team: string | null; meta: string | null }>(sql`select sleeper_id, full_name, team, meta from players`)
      .map((r) => [r.sleeper_id, r]),
  );
  const rosterRows: TeamRosterRow[] = ids
    .map((id) => {
      const p = roster.players.find((x) => x.playerId === id)!;
      const lv = lvRows.get(id);
      const q = lv?.quantiles ? (JSON.parse(lv.quantiles) as { p10?: number; p90?: number }) : null;
      const meta = metaRows.get(id);
      const age = meta?.meta ? ((JSON.parse(meta.meta) as { age?: number }).age ?? null) : null;
      let rosPts = 0;
      const weeklyArr = computed.weekly.get(id);
      if (weeklyArr) for (let w = fromWeek; w <= LAST_WEEK; w++) rosPts += weeklyArr[w - 1]!;
      return {
        playerId: id,
        name: meta?.full_name ?? id,
        pos: posOf.get(id) ?? '?',
        team: meta?.team ?? null,
        age,
        rosPts,
        market: market.get(id) ?? 0,
        seasonP10: q?.p10 ?? null,
        seasonP90: q?.p90 ?? null,
        taxi: p.taxi ?? false,
        reserve: p.reserve ?? false,
      };
    })
    .sort((a, b) => b.rosPts - a.rosPts);

  // Positional strength: ROS optimal-lineup points attributed to each position,
  // ranked across the league.
  const allPos = [...new Set(teams.flatMap((t) => Object.keys(t.posPoints)))].sort();
  const posStrength: PosStrength[] = allPos.map((pos) => {
    const values = teams.map((t) => t.posPoints[pos] ?? 0).sort((a, b) => b - a);
    const mine = summary.posPoints[pos] ?? 0;
    const median = values[Math.floor(values.length / 2)]!;
    return { pos, mine, leagueMedian: median, rank: values.filter((v) => v > mine).length + 1, teams: values.length };
  });

  // Dynasty window: where the market value sits on the age curve.
  const valued = rosterRows.filter((r) => r.market > 0 && r.age !== null);
  const totalVal = valued.reduce((s, r) => s + r.market, 0);
  const valueWeightedAge = totalVal > 0 ? valued.reduce((s, r) => s + r.market * r.age!, 0) / totalVal : null;
  const bucketDefs: Array<{ label: string; test: (age: number) => boolean }> = [
    { label: '≤23', test: (a) => a <= 23 },
    { label: '24–26', test: (a) => a >= 24 && a <= 26 },
    { label: '27–29', test: (a) => a >= 27 && a <= 29 },
    { label: '30+', test: (a) => a >= 30 },
  ];
  const buckets = bucketDefs.map((b) => ({
    label: b.label,
    share: totalVal > 0 ? valued.filter((r) => b.test(r.age!)).reduce((s, r) => s + r.market, 0) / totalVal : 0,
  }));

  // Portfolio value over time: summed market value of the CURRENT roster across
  // the daily archive (composition held fixed — a value trend, not a diff of
  // past rosters). Snapshots are sparse (rows only on change), so fill each
  // player forward across the union of dates before summing.
  const marketTrend: Array<{ date: string; total: number }> = [];
  if (ids.length > 0) {
    const histRows = db.all<{ asset_id: string; snapshot_date: string; value: number }>(sql`
      select asset_id, snapshot_date, value from market_value_snapshots
      where source = 'fantasycalc' and format = ${shape.format} and asset_id in ${ids}
      order by snapshot_date
    `);
    const dates = [...new Set(histRows.map((r) => r.snapshot_date))].sort();
    const latest = new Map<string, number>();
    const byDate = new Map<string, Array<{ asset_id: string; value: number }>>();
    for (const r of histRows) {
      let arr = byDate.get(r.snapshot_date);
      if (!arr) byDate.set(r.snapshot_date, (arr = []));
      arr.push(r);
    }
    for (const date of dates) {
      for (const r of byDate.get(date) ?? []) latest.set(r.asset_id, r.value);
      let total = 0;
      for (const v of latest.values()) total += v;
      marketTrend.push({ date, total });
    }
  }

  const history = roster.players.length > 0 ? teamHistory(leagueId, rosterOwnerId(leagueId, rosterId) ?? '') : { seasons: [], h2h: [] };

  const playedSeasons = history.seasons.filter((s) => s.weeklyPoints.length > 0);
  const fiveYear =
    playedSeasons.length > 0
      ? {
          wins: playedSeasons.reduce((s, x) => s + (x.record?.wins ?? 0), 0),
          losses: playedSeasons.reduce((s, x) => s + (x.record?.losses ?? 0), 0),
          ties: playedSeasons.reduce((s, x) => s + (x.record?.ties ?? 0), 0),
          avgPfPerWeek: (() => {
            const weeks = playedSeasons.reduce((s, x) => s + x.weeklyPoints.length, 0);
            const pts = playedSeasons.reduce((s, x) => s + x.weeklyPoints.reduce((a, w) => a + w.points, 0), 0);
            return weeks > 0 ? pts / weeks : null;
          })(),
          avgEfficiency: (() => {
            const withEff = playedSeasons.filter((x) => x.efficiency !== null);
            return withEff.length > 0 ? withEff.reduce((s, x) => s + x.efficiency!, 0) / withEff.length : null;
          })(),
        }
      : null;

  const marketSorted = [...teams].sort((a, b) => b.marketTotal - a.marketTotal);
  return {
    league: shape.name,
    leagueId,
    fromWeek,
    summary,
    rosRank: teams.findIndex((t) => t.rosterId === rosterId) + 1,
    marketRank: marketSorted.findIndex((t) => t.rosterId === rosterId) + 1,
    weeklySeries,
    seasonBand,
    roster: rosterRows,
    posStrength,
    ageProfile: { valueWeightedAge, buckets },
    marketTrend,
    history,
    fiveYear,
    accuracy: teamAccuracy(leagueId, rosterId),
    calibration: leagueCalibration(leagueId),
  };
}

function rosterOwnerId(leagueId: string, rosterId: number): string | null {
  const row = db.get<{ owner_id: string | null }>(sql`select owner_id from rosters where league_id = ${leagueId} and roster_id = ${rosterId}`);
  return row?.owner_id ?? null;
}
