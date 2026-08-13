import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { leagueValues, leagueWeeklyPoints, valuationRuns } from '@/db/schema';
import { componentBuckets, scoreBreakdown, scoreStatLine, type ScoringSettings, type StatLine } from '@/scoring/engine';
import { latestWeekProjections } from '@/services/projections';
import { SEASON } from '@/config';
import { graftTables, graftWeeklyLine } from './graft';
import { normalizePos, replacementLevels } from './replacement';
import { assignTiers } from './tiers';
import { auctionDollars } from './auction';

interface LeagueRow {
  league_id: string;
  name: string;
  total_rosters: number;
  scoring_settings: string;
  roster_positions: string;
  settings: string;
}

interface PlayerAccumulator {
  points: number;
  seasonLine: StatLine;
  graftBonusPts: number;
  graftKrPts: number;
}

export interface ValuationSummary {
  runId: number;
  league: string;
  players: number;
  replacement: Record<string, number>;
  format: string;
}

function addLine(acc: StatLine, line: StatLine): void {
  for (const [k, v] of Object.entries(line)) acc[k] = (acc[k] ?? 0) + v;
}

export interface GraftedWeek {
  grafted: StatLine;
  addedBonusKeys: string[];
  addedKrKeys: string[];
  pos: string;
}

export type GraftedWeeks = Map<number, Map<string, GraftedWeek>>;

// Canonical player -> normalized position map (players.pos with
// fantasy_positions fallback). Shared by valuation and the trade lab so
// lineup positions always match valuation exactly.
export function buildPlayerPosMap(): Map<string, string | null> {
  return new Map(
    db
      .all<{ sleeper_id: string; pos: string | null; meta: string | null }>(sql`select sleeper_id, pos, meta from players`)
      .map((r) => {
        const meta = r.meta ? (JSON.parse(r.meta) as { fantasy_positions?: string[] }) : {};
        return [r.sleeper_id, normalizePos(r.pos) ?? normalizePos(meta.fantasy_positions?.[0])] as const;
      }),
  );
}

// Grafting is league-independent — build the grafted weekly lines once and
// re-score them per league. Turns a 9-league run from 9x work into 1x + 9
// cheap scoring passes.
export function buildGraftedWeeks(): GraftedWeeks {
  const playerPos = buildPlayerPosMap();
  const tables = graftTables();
  const weeks: GraftedWeeks = new Map();
  for (let week = 1; week <= 18; week++) {
    const weekMap = new Map<string, GraftedWeek>();
    for (const [playerId, stats] of latestWeekProjections(SEASON, week)) {
      const pos = playerPos.get(playerId);
      if (!pos) continue;
      const result = graftWeeklyLine(playerId, pos, stats, tables);
      weekMap.set(playerId, { ...result, pos });
    }
    weeks.set(week, weekMap);
  }
  return weeks;
}

export function runValuation(leagueId: string, shared?: GraftedWeeks): ValuationSummary {
  const started = Date.now();
  const league = db.get<LeagueRow>(sql`
    select league_id, name, total_rosters, scoring_settings, roster_positions, settings
    from leagues where league_id = ${leagueId}
  `);
  if (!league) throw new Error(`league not found: ${leagueId}`);

  const scoring = JSON.parse(league.scoring_settings) as ScoringSettings;
  const rosterPositions = JSON.parse(league.roster_positions) as string[];
  const settings = JSON.parse(league.settings) as Record<string, unknown>;
  const teams = league.total_rosters;

  const graftedWeeks = shared ?? buildGraftedWeeks();
  const posByPlayer = new Map<string, string>();
  const acc = new Map<string, PlayerAccumulator>();
  const weeklyPts = new Map<string, Array<[week: number, pts: number]>>();

  for (const [week, weekMap] of graftedWeeks) {
    for (const [playerId, { grafted, addedBonusKeys, addedKrKeys, pos }] of weekMap) {
      const points = scoreStatLine(grafted, scoring);
      if (points === 0) continue; // absent row = 0 downstream (encodes byes)
      posByPlayer.set(playerId, pos);
      let entry = acc.get(playerId);
      if (!entry) acc.set(playerId, (entry = { points: 0, seasonLine: {}, graftBonusPts: 0, graftKrPts: 0 }));
      entry.points += points;
      addLine(entry.seasonLine, grafted);
      for (const key of addedBonusKeys) entry.graftBonusPts += (grafted[key] ?? 0) * (scoring[key] ?? 0);
      for (const key of addedKrKeys) entry.graftKrPts += (grafted[key] ?? 0) * (scoring[key] ?? 0);
      let weeks = weeklyPts.get(playerId);
      if (!weeks) weeklyPts.set(playerId, (weeks = []));
      weeks.push([week, points]);
    }
  }

  const ranked = [...acc.entries()]
    .map(([playerId, entry]) => ({ playerId, pos: posByPlayer.get(playerId)!, points: entry.points }))
    .filter((p) => p.points > 5);

  const replacement = replacementLevels(ranked, rosterPositions, teams);

  const withVorp = ranked.map((p) => ({ ...p, vorp: p.points - (replacement.levels[p.pos] ?? 0) }));

  // Tiers + positional rank within each position.
  const tierByPlayer = new Map<string, { tier: number; posRank: number }>();
  const byPos = new Map<string, typeof withVorp>();
  for (const p of withVorp) {
    let list = byPos.get(p.pos);
    if (!list) byPos.set(p.pos, (list = []));
    list.push(p);
  }
  for (const list of byPos.values()) {
    list.sort((a, b) => b.points - a.points);
    const tiers = assignTiers(list.map((p) => p.points));
    list.forEach((p, i) => tierByPlayer.set(p.playerId, { tier: tiers[i]!, posRank: i + 1 }));
  }

  // Auction pool: budget from the league's auction draft when present.
  const draftBudget = db.get<{ budget: number | null }>(sql`
    select cast(json_extract(settings, '$.budget') as integer) as budget
    from drafts where league_id = ${leagueId} and type = 'auction'
    order by fetched_at desc limit 1
  `);
  const budget = draftBudget?.budget ?? 200;
  const rosterSize = rosterPositions.filter((s) => s !== 'IR' && s !== 'TAXI').length;
  const dollars = auctionDollars(withVorp, { teams, budget, rosterSize, inflation: 1 });

  // Market join: FantasyCalc, format chosen by league type + superflex shape.
  const isDynasty = settings.type === 2;
  const qbSlots = rosterPositions.filter((s) => s === 'QB').length;
  const isSf = rosterPositions.includes('SUPER_FLEX') || qbSlots >= 2;
  const format = `${isDynasty ? 'dynasty' : 'redraft'}_${isSf ? 'sf' : '1qb'}`;
  const marketRows = db.all<{ asset_id: string; value: number }>(sql`
    select asset_id, value from market_value_snapshots
    where source = 'fantasycalc' and format = ${format} and asset_type = 'player'
      and snapshot_date = (
        select max(snapshot_date) from market_value_snapshots where source = 'fantasycalc' and format = ${format}
      )
  `);
  const market = new Map(marketRows.map((r) => [r.asset_id, r.value]));

  // Market-implied dollars over the same pool math → edge in $.
  const slots = teams * rosterSize;
  const excess = Math.max(teams * budget - slots, 0);
  const draftable = [...withVorp].sort((a, b) => b.points - a.points).slice(0, slots);
  const marketTotal = draftable.reduce((s, p) => s + (market.get(p.playerId) ?? 0), 0);
  const marketDollar = new Map<string, number>();
  for (const p of draftable) {
    const mv = market.get(p.playerId);
    if (mv !== undefined && marketTotal > 0) marketDollar.set(p.playerId, 1 + excess * (mv / marketTotal));
  }

  const runRow = db
    .insert(valuationRuns)
    .values({
      leagueId,
      horizon: 'season',
      ranAt: started,
      config: { budget, rosterSize, teams, format, inflation: 1 },
      inputs: { projectionSource: 'sleeper', season: SEASON, weeks: '1-18' },
      durationMs: 0,
    })
    .returning({ id: valuationRuns.id })
    .all();
  const runId = runRow[0]!.id;

  const top = [...withVorp].sort((a, b) => b.points - a.points).slice(0, 600);

  // Weekly rows persist for top-600 ∪ everyone rostered in this league (covers
  // taxi/deep-IDP players the top-600 cut would drop).
  const persistIds = new Set(top.map((p) => p.playerId));
  const rosterRows = db.all<{ player_ids: string | null }>(sql`select player_ids from rosters where league_id = ${leagueId}`);
  for (const row of rosterRows) {
    for (const id of row.player_ids ? (JSON.parse(row.player_ids) as string[]) : []) {
      if (weeklyPts.has(id)) persistIds.add(id);
    }
  }

  db.transaction((tx) => {
    for (const playerId of persistIds) {
      for (const [week, pts] of weeklyPts.get(playerId) ?? []) {
        tx.insert(leagueWeeklyPoints).values({ runId, playerId, week, pts }).onConflictDoNothing().run();
      }
    }
    // Prune weekly rows beyond this league's last 3 runs.
    tx.run(sql`
      delete from league_weekly_points where run_id in (
        select id from valuation_runs where league_id = ${leagueId}
        and id not in (select id from valuation_runs where league_id = ${leagueId} order by id desc limit 3)
      )
    `);
    for (const p of top) {
      const entry = acc.get(p.playerId)!;
      const buckets = componentBuckets(scoreBreakdown(entry.seasonLine, scoring));
      buckets.graft_bonus = entry.graftBonusPts;
      buckets.graft_kr = entry.graftKrPts;
      const ourDollar = dollars.get(p.playerId) ?? null;
      const mktDollar = marketDollar.get(p.playerId) ?? null;
      const tierInfo = tierByPlayer.get(p.playerId);
      tx.insert(leagueValues)
        .values({
          runId,
          playerId: p.playerId,
          leagueId,
          points: p.points,
          components: buckets,
          vorp: p.vorp,
          tier: tierInfo?.tier ?? null,
          posRank: tierInfo?.posRank ?? null,
          auctionDollar: ourDollar,
          marketValue: market.get(p.playerId) ?? null,
          edge: ourDollar !== null && mktDollar !== null ? ourDollar - mktDollar : null,
          quantiles: null,
        })
        .run();
    }
    tx.update(valuationRuns)
      .set({ durationMs: Date.now() - started })
      .where(sql`id = ${runId}`)
      .run();
  });

  return { runId, league: league.name, players: top.length, replacement: replacement.levels, format };
}

export function runAllValuations(): ValuationSummary[] {
  const leagueRows = db.all<{ league_id: string }>(sql`select league_id from leagues where season = ${SEASON}`);
  const shared = buildGraftedWeeks();
  return leagueRows.map((l) => runValuation(l.league_id, shared));
}
