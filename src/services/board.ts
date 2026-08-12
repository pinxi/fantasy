import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { SEASON } from '@/config';

export interface BoardRow {
  playerId: string;
  name: string;
  pos: string;
  team: string | null;
  points: number;
  vorp: number | null;
  tier: number | null;
  posRank: number | null;
  dollar: number | null;
  marketValue: number | null;
  edge: number | null;
  adp: number | null;
  fdPts: number;
  krPts: number;
  bonusPts: number;
}

// Sleeper's week-0 "projection" rows carry ADP for every format — pick the one
// matching this league's shape.
function adpKeyForLeague(leagueId: string): string {
  const row = db.get<{ scoring_settings: string; roster_positions: string; settings: string }>(
    sql`select scoring_settings, roster_positions, settings from leagues where league_id = ${leagueId}`,
  );
  if (!row) return 'adp_ppr';
  const scoring = JSON.parse(row.scoring_settings) as Record<string, number>;
  const positions = JSON.parse(row.roster_positions) as string[];
  const settings = JSON.parse(row.settings) as Record<string, unknown>;
  const isDynasty = settings.type === 2;
  const isSf = positions.includes('SUPER_FLEX') || positions.filter((p) => p === 'QB').length >= 2;
  const isIdp = positions.some((p) => ['DL', 'LB', 'DB', 'IDP_FLEX'].includes(p));
  if (isIdp) return isSf ? 'adp_idp' : 'adp_idp_1qb';
  if (isDynasty) return isSf ? 'adp_dynasty_2qb' : 'adp_dynasty_ppr';
  if (isSf) return 'adp_2qb';
  const rec = scoring.rec ?? 0;
  return rec >= 1 ? 'adp_ppr' : rec >= 0.5 ? 'adp_half_ppr' : 'adp_std';
}

function adpMap(adpKey: string): Map<string, number> {
  const rows = db.all<{ player_id: string; adp: number | null }>(sql`
    select ps.player_id, json_extract(ps.stats, ${'$.' + adpKey}) as adp
    from projection_snapshots ps
    join (
      select player_id, max(id) as max_id from projection_snapshots
      where source = 'sleeper' and season = ${SEASON} and week = 0
      group by player_id
    ) latest on latest.max_id = ps.id
  `);
  const map = new Map<string, number>();
  for (const r of rows) {
    if (r.adp !== null && r.adp > 0 && r.adp < 999) map.set(r.player_id, r.adp);
  }
  return map;
}

export function latestRunId(leagueId: string): number | null {
  const row = db.get<{ id: number }>(sql`select max(id) as id from valuation_runs where league_id = ${leagueId}`);
  return row?.id ?? null;
}

export function boardRows(leagueId: string): BoardRow[] {
  const runId = latestRunId(leagueId);
  if (!runId) return [];
  const adp = adpMap(adpKeyForLeague(leagueId));
  const rows = db.all<{
    player_id: string;
    full_name: string;
    pos: string | null;
    team: string | null;
    points: number;
    vorp: number | null;
    tier: number | null;
    pos_rank: number | null;
    auction_dollar: number | null;
    market_value: number | null;
    edge: number | null;
    components: string;
  }>(sql`
    select lv.player_id, p.full_name, p.pos, p.team, lv.points, lv.vorp, lv.tier, lv.pos_rank,
      lv.auction_dollar, lv.market_value, lv.edge, lv.components
    from league_values lv
    join players p on p.sleeper_id = lv.player_id
    where lv.run_id = ${runId}
    order by lv.points desc
  `);
  return rows.map((r) => {
    const c = JSON.parse(r.components) as Record<string, number>;
    return {
      playerId: r.player_id,
      name: r.full_name,
      pos: r.pos ?? '?',
      team: r.team,
      points: r.points,
      vorp: r.vorp,
      tier: r.tier,
      posRank: r.pos_rank,
      dollar: r.auction_dollar,
      marketValue: r.market_value,
      edge: r.edge,
      adp: adp.get(r.player_id) ?? null,
      fdPts: c.fd ?? 0,
      krPts: c.graft_kr ?? 0,
      bonusPts: (c.graft_bonus ?? 0) + Math.max((c.bonus ?? 0) - (c.graft_bonus ?? 0), 0),
    };
  });
}

export function leagueMeta(leagueId: string): { name: string; isDynasty: boolean } | null {
  const row = db.get<{ name: string; type: number | null }>(
    sql`select name, cast(json_extract(settings, '$.type') as integer) as type from leagues where league_id = ${leagueId}`,
  );
  return row ? { name: row.name, isDynasty: row.type === 2 } : null;
}

export function leagueName(leagueId: string): string | null {
  return leagueMeta(leagueId)?.name ?? null;
}
