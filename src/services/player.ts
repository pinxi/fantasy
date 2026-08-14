import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { SEASON, SLEEPER_USER_ID } from '@/config';
import { scoreStatLine, type ScoringSettings, type StatLine } from '@/scoring/engine';
import { graftTables, graftWeeklyLine } from '@/valuation/graft';
import { normalizePos } from '@/valuation/replacement';

export interface PlayerHeader {
  sleeperId: string;
  name: string;
  pos: string | null;
  team: string | null;
  age: number | null;
  yearsExp: number | null;
  injuryStatus: string | null;
}

export function playerHeader(playerId: string): PlayerHeader | null {
  const row = db.get<{ sleeper_id: string; full_name: string; pos: string | null; team: string | null; injury_status: string | null; meta: string | null }>(
    sql`select sleeper_id, full_name, pos, team, injury_status, meta from players where sleeper_id = ${playerId}`,
  );
  if (!row) return null;
  const meta = row.meta ? (JSON.parse(row.meta) as { age?: number; years_exp?: number }) : {};
  return {
    sleeperId: row.sleeper_id,
    name: row.full_name,
    pos: row.pos,
    team: row.team,
    age: meta.age ?? null,
    yearsExp: meta.years_exp ?? null,
    injuryStatus: row.injury_status,
  };
}

export interface RosterStatus {
  leagueId: string;
  league: string;
  status: 'mine' | 'rostered' | 'fa';
  ownerName: string | null;
}

export function rosterStatuses(playerId: string): RosterStatus[] {
  const rows = db.all<{ league_id: string; name: string; owner_id: string | null; display_name: string | null; player_ids: string | null }>(sql`
    select l.league_id, l.name, r.owner_id, u.display_name, r.player_ids
    from leagues l
    left join rosters r on r.league_id = l.league_id
    left join league_users u on u.league_id = r.league_id and u.user_id = r.owner_id
    where l.season = ${SEASON}
  `);
  const byLeague = new Map<string, RosterStatus>();
  for (const row of rows) {
    if (!byLeague.has(row.league_id)) {
      byLeague.set(row.league_id, { leagueId: row.league_id, league: row.name, status: 'fa', ownerName: null });
    }
    const ids = row.player_ids ? (JSON.parse(row.player_ids) as string[]) : [];
    if (ids.includes(playerId)) {
      const entry = byLeague.get(row.league_id)!;
      entry.status = row.owner_id === SLEEPER_USER_ID ? 'mine' : 'rostered';
      entry.ownerName = row.display_name;
    }
  }
  return [...byLeague.values()].sort((a, b) => a.league.localeCompare(b.league));
}

export interface PlayerLeagueValue {
  leagueId: string;
  league: string;
  points: number;
  dollar: number | null;
  edge: number | null;
  tier: number | null;
  posRank: number | null;
  fdPts: number;
  krPts: number;
  bonusEvPts: number;
}

export function playerLeagueValues(playerId: string): PlayerLeagueValue[] {
  const rows = db.all<{
    league_id: string;
    league: string;
    points: number;
    auction_dollar: number | null;
    edge: number | null;
    tier: number | null;
    pos_rank: number | null;
    components: string;
  }>(sql`
    with latest as (select league_id, max(id) as run_id from valuation_runs group by league_id)
    select l.league_id, l.name as league, lv.points, lv.auction_dollar, lv.edge, lv.tier, lv.pos_rank, lv.components
    from league_values lv
    join latest on latest.run_id = lv.run_id
    join leagues l on l.league_id = lv.league_id
    where lv.player_id = ${playerId} and l.season = ${SEASON}
    order by lv.points desc
  `);
  return rows.map((r) => {
    const c = JSON.parse(r.components) as Record<string, number>;
    return {
      leagueId: r.league_id,
      league: r.league,
      points: r.points,
      dollar: r.auction_dollar,
      edge: r.edge,
      tier: r.tier,
      posRank: r.pos_rank,
      fdPts: c.fd ?? 0,
      krPts: c.graft_kr ?? 0,
      bonusEvPts: c.graft_bonus ?? 0,
    };
  });
}

export interface TrendSeries {
  source: string;
  format: string;
  points: Array<{ date: string; value: number }>;
}

export function marketSeries(playerId: string): TrendSeries[] {
  const rows = db.all<{ source: string; format: string; snapshot_date: string; value: number }>(sql`
    select source, format, snapshot_date, value from market_value_snapshots
    where asset_id = ${playerId} and format in ('dynasty_sf', 'redraft_sf')
    order by source, format, snapshot_date
  `);
  const map = new Map<string, TrendSeries>();
  for (const row of rows) {
    const key = `${row.source}:${row.format}`;
    let series = map.get(key);
    if (!series) map.set(key, (series = { source: row.source, format: row.format, points: [] }));
    series.points.push({ date: row.snapshot_date, value: row.value });
  }
  return [...map.values()];
}

export interface MarketDelta {
  source: string;
  format: string;
  current: number;
  d7: number | null;
  d30: number | null;
}

export function marketDeltas(playerId: string): MarketDelta[] {
  return marketSeries(playerId).map((s) => {
    const last = s.points[s.points.length - 1]!;
    const valueAt = (daysAgo: number): number | null => {
      const cutoff = new Date(Date.now() - daysAgo * 86400_000).toISOString().slice(0, 10);
      const at = [...s.points].reverse().find((p) => p.date <= cutoff);
      return at && at !== last ? at.value : null;
    };
    const v7 = valueAt(7);
    const v30 = valueAt(30);
    return {
      source: s.source,
      format: s.format,
      current: last.value,
      d7: v7 !== null ? last.value - v7 : null,
      d30: v30 !== null ? last.value - v30 : null,
    };
  });
}

export function adpSeries(playerId: string, adpKey = 'adp_ppr'): Array<{ date: string; value: number }> {
  const rows = db.all<{ snapshot_date: string; adp: number | null }>(sql`
    select snapshot_date, json_extract(stats, ${'$.' + adpKey}) as adp
    from projection_snapshots
    where source = 'sleeper' and season = ${SEASON} and week = 0 and player_id = ${playerId}
    order by snapshot_date
  `);
  return rows.filter((r) => r.adp !== null && r.adp > 0 && r.adp < 999).map((r) => ({ date: r.snapshot_date, value: r.adp! }));
}

export interface WeeklyLine {
  week: number;
  projected: number;
  actual: number | null;
  p10: number | null;
  p90: number | null;
}

// Weekly league-scored projections for ONE player. Prefers the persisted
// valuation rows (which carry resampled p10/p90 bands); falls back to live
// grafted computation for players outside the persisted set.
export function weeklyLines(playerId: string, leagueId: string): WeeklyLine[] {
  const league = db.get<{ scoring_settings: string }>(sql`select scoring_settings from leagues where league_id = ${leagueId}`);
  if (!league) return [];
  const scoring = JSON.parse(league.scoring_settings) as ScoringSettings;

  const actualsForPlayer = new Map(
    db
      .all<{ week: number; stats: string }>(
        sql`select week, stats from stat_actuals where source = 'sleeper' and season = ${SEASON} and player_id = ${playerId}`,
      )
      .map((r) => [r.week, scoreStatLine(JSON.parse(r.stats) as StatLine, scoring)]),
  );

  const stored = db.all<{ week: number; pts: number; p10: number | null; p90: number | null }>(sql`
    select week, pts, p10, p90 from league_weekly_points
    where run_id = (select max(id) from valuation_runs where league_id = ${leagueId}) and player_id = ${playerId}
    order by week
  `);
  if (stored.length > 0) {
    return stored.map((r) => ({
      week: r.week,
      projected: r.pts,
      actual: actualsForPlayer.get(r.week) ?? null,
      p10: r.p10,
      p90: r.p90,
    }));
  }

  const header = playerHeader(playerId);
  const pos = normalizePos(header?.pos) ?? '?';
  const tables = graftTables();

  const projRows = db.all<{ week: number; stats: string }>(sql`
    select ps.week, ps.stats from projection_snapshots ps
    join (
      select week, max(id) as max_id from projection_snapshots
      where source = 'sleeper' and season = ${SEASON} and player_id = ${playerId} and week > 0
      group by week
    ) latest on latest.max_id = ps.id
    order by ps.week
  `);
  const actualRows = new Map(
    db
      .all<{ week: number; stats: string }>(
        sql`select week, stats from stat_actuals where source = 'sleeper' and season = ${SEASON} and player_id = ${playerId}`,
      )
      .map((r) => [r.week, JSON.parse(r.stats) as StatLine]),
  );

  return projRows.map((r) => {
    const { grafted } = graftWeeklyLine(playerId, pos, JSON.parse(r.stats) as StatLine, tables);
    const actualStats = actualRows.get(r.week);
    return {
      week: r.week,
      projected: scoreStatLine(grafted, scoring),
      actual: actualStats ? scoreStatLine(actualStats, scoring) : null,
      p10: null,
      p90: null,
    };
  });
}

export interface PastSeasonLine {
  season: number;
  games: number;
  points: number; // scored through the selected league's settings
  ppg: number;
  best: number;
  worst: number;
}

// Past-season actuals re-scored through the selected league (stat_actuals
// currently spans 2024-25 — the comp-pool backfill).
export function pastSeasonLines(playerId: string, leagueId: string): PastSeasonLine[] {
  const league = db.get<{ scoring_settings: string }>(sql`select scoring_settings from leagues where league_id = ${leagueId}`);
  if (!league) return [];
  const scoring = JSON.parse(league.scoring_settings) as ScoringSettings;
  const rows = db.all<{ season: number; stats: string }>(
    sql`select season, stats from stat_actuals where source = 'sleeper' and player_id = ${playerId} and season < ${SEASON}`,
  );
  const bySeason = new Map<number, number[]>();
  for (const r of rows) {
    const pts = scoreStatLine(JSON.parse(r.stats) as StatLine, scoring);
    let arr = bySeason.get(r.season);
    if (!arr) bySeason.set(r.season, (arr = []));
    arr.push(pts);
  }
  return [...bySeason.entries()]
    .map(([season, pts]) => {
      const played = pts.filter((p) => p !== 0);
      const total = pts.reduce((a, b) => a + b, 0);
      return {
        season,
        games: played.length,
        points: total,
        ppg: played.length > 0 ? total / played.length : 0,
        best: played.length > 0 ? Math.max(...played) : 0,
        worst: played.length > 0 ? Math.min(...played) : 0,
      };
    })
    .sort((a, b) => b.season - a.season);
}

export interface NewsItem {
  source: string;
  title: string | null;
  body: string | null;
  url: string | null;
  publishedAtMs: number | null;
}

export function playerNews(playerId: string, limit = 10): NewsItem[] {
  const rows = db.all<{ source: string; title: string | null; body: string | null; meta: string | null; published_at_ms: number | null }>(sql`
    select source, title, body, meta, published_at_ms from news_items
    where player_id = ${playerId}
    order by published_at_ms desc
    limit ${limit}
  `);
  return rows.map((r) => {
    const meta = r.meta ? (JSON.parse(r.meta) as { url?: string }) : {};
    return { source: r.source, title: r.title, body: r.body, url: meta.url ?? null, publishedAtMs: r.published_at_ms };
  });
}

export function searchPlayers(query: string, limit = 20): Array<{ sleeperId: string; name: string; pos: string | null; team: string | null }> {
  const normalized = query.toLowerCase().replace(/[.'’-]/g, '').trim();
  if (!normalized) return [];
  const rows = db.all<{ sleeper_id: string; full_name: string; pos: string | null; team: string | null }>(sql`
    select sleeper_id, full_name, pos, team from players
    where search_name like ${'%' + normalized + '%'} and pos is not null
    order by case when team is null then 1 else 0 end, full_name
    limit ${limit}
  `);
  return rows.map((r) => ({ sleeperId: r.sleeper_id, name: r.full_name, pos: r.pos, team: r.team }));
}
