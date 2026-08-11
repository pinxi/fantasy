import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { SEASON } from '@/config';
import { listLeagues, sourceHealthStrip } from '@/services/leagues';
import { boardRows, leagueMeta } from '@/services/board';

// Read-only MCP tools over the same services layer as the web UI.
// The engine computes, the LLM interprets — never the reverse.

const server = new Server({ name: 'fantasy', version: '0.1.0' }, { capabilities: { tools: {} } });

const TOOLS = [
  {
    name: 'list_leagues',
    description:
      "Casey's 9 Sleeper leagues for 2026 with format flags (SF/TEP/FD/KR/BONUS/IDP/CHOPPED/DYNASTY), team counts, and draft status. League values are league-conditional — always name the league when discussing a player's value.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_player',
    description:
      'League-conditional values for a player across all 9 leagues: league-scored season points, auction dollars, market-implied dollars, edge, tier, and hidden-points components (modeled first downs, grafted kick returns, bonus EV). Values differ per league by design.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Player name (partial ok, e.g. "Turpin")' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_draft_board',
    description:
      'League-scored draft board for one league: players by position with season points, VORP, tier, auction dollars, market value, and edge. In dynasty leagues, edge compares this-season production vs the dynasty market (win-now buy signal).',
    inputSchema: {
      type: 'object',
      properties: {
        league: { type: 'string', description: 'League name (partial ok) or league_id' },
        position: { type: 'string', description: 'Optional: QB/RB/WR/TE/K/DEF/DL/LB/DB' },
        limit: { type: 'number', description: 'Rows per position (default 25)' },
      },
      required: ['league'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_source_health',
    description: 'Data-source freshness: which ingestion sources are green, stale, or failing, with messages.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

function resolveLeagueId(query: string): string | null {
  const leagues = listLeagues();
  const exact = leagues.find((l) => l.leagueId === query);
  if (exact) return exact.leagueId;
  const lower = query.toLowerCase();
  const match = leagues.find((l) => l.name.toLowerCase().includes(lower));
  return match?.leagueId ?? null;
}

function getPlayer(name: string): unknown {
  const players = db.all<{ sleeper_id: string; full_name: string; pos: string | null; team: string | null }>(sql`
    select sleeper_id, full_name, pos, team from players
    where full_name like ${'%' + name + '%'} and pos is not null
    order by case when team is null then 1 else 0 end limit 5
  `);
  if (players.length === 0) return { error: `no player matching "${name}"` };
  const player = players[0]!;

  const values = db.all<{
    league: string;
    points: number;
    auction_dollar: number | null;
    edge: number | null;
    tier: number | null;
    pos_rank: number | null;
    components: string;
  }>(sql`
    with latest as (select league_id, max(id) as run_id from valuation_runs group by league_id)
    select l.name as league, lv.points, lv.auction_dollar, lv.edge, lv.tier, lv.pos_rank, lv.components
    from league_values lv
    join latest on latest.run_id = lv.run_id
    join leagues l on l.league_id = lv.league_id
    where lv.player_id = ${player.sleeper_id} and l.season = ${SEASON}
    order by lv.points desc
  `);

  const market = db.all<{ format: string; value: number; snapshot_date: string }>(sql`
    select format, value, snapshot_date from market_value_snapshots
    where source = 'fantasycalc' and asset_id = ${player.sleeper_id}
      and snapshot_date = (select max(snapshot_date) from market_value_snapshots where source = 'fantasycalc')
  `);

  return {
    player: { name: player.full_name, pos: player.pos, team: player.team, sleeper_id: player.sleeper_id },
    otherMatches: players.slice(1).map((p) => p.full_name),
    leagueValues: values.map((v) => {
      const c = JSON.parse(v.components) as Record<string, number>;
      return {
        league: v.league,
        seasonPoints: Math.round(v.points),
        auctionDollar: v.auction_dollar,
        edgeDollar: v.edge !== null ? Math.round(v.edge) : null,
        tier: v.tier,
        posRank: v.pos_rank,
        hiddenPoints: {
          modeledFirstDowns: Math.round(c.fd ?? 0),
          graftedKickReturns: Math.round(c.graft_kr ?? 0),
          bonusEV: Math.round(c.graft_bonus ?? 0),
        },
      };
    }),
    marketValues: market.map((m) => ({ format: m.format, value: m.value, asOf: m.snapshot_date })),
  };
}

function getDraftBoard(league: string, position?: string, limit = 25): unknown {
  const leagueId = resolveLeagueId(league);
  if (!leagueId) return { error: `no league matching "${league}"` };
  const meta = leagueMeta(leagueId);
  const rows = boardRows(leagueId).filter((r) => !position || r.pos === position.toUpperCase());
  const byPos = new Map<string, Array<Record<string, unknown>>>();
  for (const r of rows) {
    let list = byPos.get(r.pos);
    if (!list) byPos.set(r.pos, (list = []));
    if (list.length >= limit) continue;
    list.push({
      rank: r.posRank,
      tier: r.tier,
      name: r.name,
      team: r.team,
      points: Math.round(r.points),
      vorp: r.vorp !== null ? Math.round(r.vorp) : null,
      dollar: r.dollar,
      edgeDollar: r.edge !== null ? Math.round(r.edge) : null,
      fdPts: Math.round(r.fdPts),
      krPts: Math.round(r.krPts),
      bonusPts: Math.round(r.bonusPts),
    });
  }
  return { league: meta?.name, isDynasty: meta?.isDynasty ?? false, board: Object.fromEntries(byPos) };
}

server.setRequestHandler(CallToolRequestSchema, (request) => {
  const { name, arguments: args } = request.params;
  let result: unknown;
  switch (name) {
    case 'list_leagues':
      result = listLeagues();
      break;
    case 'get_player':
      result = getPlayer(String((args as { name?: unknown })?.name ?? ''));
      break;
    case 'get_draft_board': {
      const a = args as { league?: unknown; position?: unknown; limit?: unknown };
      result = getDraftBoard(String(a?.league ?? ''), a?.position ? String(a.position) : undefined, typeof a?.limit === 'number' ? a.limit : 25);
      break;
    }
    case 'get_source_health':
      result = sourceHealthStrip();
      break;
    default:
      return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
  }
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
