import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { SEASON } from '@/config';
import { listLeagues, sourceHealthStrip } from '@/services/leagues';
import { boardRows, leagueMeta, myRosterIds } from '@/services/board';
import { getLeagueIntel } from '@/services/intel';
import { marketDeltas, playerNews } from '@/services/player';
import { evaluateTrade, findTrades, leagueRostersDetailed, parsePickLabel, resolvePlayerOnRoster, type TradeAsset } from '@/services/trade';
import { streamsReport } from '@/services/streams';
import { weekReport } from '@/services/matchup';
import { SLEEPER_USER_ID } from '@/config';

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
    name: 'get_edge_board',
    description:
      'Edge board for one league: players sorted by model-vs-market edge (buys first by default). Includes tier, points, our $, edge $, hidden points (fd/kr/bonus), Sleeper ADP, and whether the player is on my roster. In dynasty leagues, positive edge = win-now buy (this-season production the dynasty market discounts).',
    inputSchema: {
      type: 'object',
      properties: {
        league: { type: 'string', description: 'League name (partial ok) or league_id' },
        sort: { type: 'string', description: 'buy (default) | sell | points' },
        limit: { type: 'number', description: 'Max rows (default 40)' },
      },
      required: ['league'],
      additionalProperties: false,
    },
  },
  {
    name: 'evaluate_trade',
    description:
      'Evaluate a trade in one league across three horizons: rest-of-season optimal-lineup points delta for BOTH sides (league-scored weekly projections, exact lineup optimizer), playoff-weighted delta (weeks 15-17 count 2x), and market-value delta (format-matched; single source per evaluation — fantasycalc, or ktc when dynasty picks like "2027 mid 1st" are included). give = assets leaving my roster, receive = assets arriving. Small deltas honestly report "even". Includes per-side lineup before/after and warning chips (taxi/IR, startable-depth drops, deadline, unfillable slots).',
    inputSchema: {
      type: 'object',
      properties: {
        league: { type: 'string', description: 'League name (partial ok) or league_id' },
        give: { type: 'array', items: { type: 'string' }, description: 'Player names or pick labels I send' },
        receive: { type: 'array', items: { type: 'string' }, description: 'Player names or pick labels I get' },
        counterparty: { type: 'string', description: 'Manager team/display name; inferred from receive players when omitted' },
      },
      required: ['league', 'give', 'receive'],
      additionalProperties: false,
    },
  },
  {
    name: 'find_trades',
    description:
      "Scan one league for realistic 1-for-1 and 2-for-1 trades that improve my optimal lineup, ranked by my ROS gain x acceptance plausibility (their side judged by public market values + manager tendencies from league history: positional flow, past partners, trade frequency; never proposes fleecings). Returns both sides' deltas with human-readable reasons.",
    inputSchema: {
      type: 'object',
      properties: {
        league: { type: 'string' },
        position: { type: 'string', description: 'Optional: upgrade target QB/RB/WR/TE/K/DEF/DL/LB/DB' },
        stance: { type: 'string', description: 'any (default) | consolidate (send 2 get 1) | spread (send 1 get 2)' },
      },
      required: ['league'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_matchup',
    description:
      "Weekly command center for one league: Monte Carlo win probability against my real opponent (or the league-median lineup preseason), both optimal lineups with p10–p90 bands, and start/sit swap suggestions scored by Δwin% — NOT Δpoints. Suggestions flagged 'disagree' are where the two lenses conflict: trust win% (underdogs want ceiling/variance, favorites want floor). Empty starting slots are called out.",
    inputSchema: {
      type: 'object',
      properties: {
        league: { type: 'string', description: 'League name (partial ok) or league_id' },
        week: { type: 'number', description: 'NFL week 1-18; defaults to the current week' },
      },
      required: ['league'],
      additionalProperties: false,
    },
  },
  {
    name: 'stream_or_hold',
    description:
      "Stream-vs-hold analysis for one league: per-position streamability (weekly top-2 free-agent baseline vs replacement level — 'streamable' means the wire keeps pace, so don't pay for bench depth there) and hold/coin-flip/stream verdicts for every player on my roster (margin = player's weekly avg vs the wire baseline; starts = weeks in my optimal lineup). Stream verdicts mean the roster spot is worth more as a lottery stash. Especially relevant for IDP in Squidward.",
    inputSchema: {
      type: 'object',
      properties: {
        league: { type: 'string', description: 'League name (partial ok) or league_id' },
        position: { type: 'string', description: 'Optional filter: QB/RB/WR/TE/K/DEF/DL/LB/DB' },
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
  {
    name: 'get_manager_tendencies',
    description:
      "Manager tendency profiles for one league, computed from every archived season of that league's history: auction bidding shape (top-3 concentration, early-spend rate, $ by position, biggest buy), snake-draft position timing (round of first QB/RB/WR/TE), rookie-draft mix, trade behavior (frequency, positional flow, pick hoarding, go-to partners), and FAAB aggression. Use before drafts and trade negotiations to exploit opponent habits.",
    inputSchema: {
      type: 'object',
      properties: { league: { type: 'string', description: 'League name (partial ok) or league_id' } },
      required: ['league'],
      additionalProperties: false,
    },
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
    quantiles: string | null;
  }>(sql`
    with latest as (select league_id, max(id) as run_id from valuation_runs group by league_id)
    select l.name as league, lv.points, lv.auction_dollar, lv.edge, lv.tier, lv.pos_rank, lv.components, lv.quantiles
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
      const q = v.quantiles ? (JSON.parse(v.quantiles) as { p10?: number; p90?: number }) : null;
      return {
        league: v.league,
        seasonPoints: Math.round(v.points),
        seasonP10: q?.p10 !== undefined ? Math.round(q.p10) : null,
        seasonP90: q?.p90 !== undefined ? Math.round(q.p90) : null,
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
    marketTrend: marketDeltas(player.sleeper_id).map((d) => ({
      source: d.source,
      format: d.format,
      current: Math.round(d.current),
      change7d: d.d7 !== null ? Math.round(d.d7) : null,
      change30d: d.d30 !== null ? Math.round(d.d30) : null,
    })),
    recentNews: playerNews(player.sleeper_id, 5).map((n) => ({
      source: n.source,
      title: n.title,
      daysAgo: n.publishedAtMs ? Math.round((Date.now() - n.publishedAtMs) / 86400_000) : null,
    })),
  };
}

function getEdgeBoard(league: string, sort = 'buy', limit = 40): unknown {
  const leagueId = resolveLeagueId(league);
  if (!leagueId) return { error: `no league matching "${league}"` };
  const meta = leagueMeta(leagueId);
  const mine = myRosterIds(leagueId, SLEEPER_USER_ID);
  let rows = boardRows(leagueId).filter((r) => r.edge !== null);
  if (sort === 'sell') rows = rows.sort((a, b) => a.edge! - b.edge!);
  else if (sort === 'points') rows = rows.sort((a, b) => b.points - a.points);
  else rows = rows.sort((a, b) => b.edge! - a.edge!);
  return {
    league: meta?.name,
    isDynasty: meta?.isDynasty ?? false,
    sort,
    rows: rows.slice(0, limit).map((r) => ({
      name: r.name,
      pos: r.pos,
      team: r.team,
      tier: r.tier,
      points: Math.round(r.points),
      dollar: r.dollar,
      edgeDollar: Math.round(r.edge!),
      adp: r.adp !== null ? Math.round(r.adp) : null,
      fdPts: Math.round(r.fdPts),
      krPts: Math.round(r.krPts),
      bonusPts: Math.round(r.bonusPts),
      mine: mine.has(r.playerId),
    })),
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

async function mcpEvaluateTrade(leagueQuery: string, giveNames: string[], receiveNames: string[], counterparty?: string): Promise<unknown> {
  const leagueId = resolveLeagueId(leagueQuery);
  if (!leagueId) return { error: `no league matching "${leagueQuery}"` };

  const resolveAssets = (names: string[], mustBeMine: boolean): TradeAsset[] | { error: string; candidates?: string[] } => {
    const assets: TradeAsset[] = [];
    for (const raw of names) {
      const pick = parsePickLabel(raw);
      if (pick) {
        assets.push({ kind: 'pick', label: pick });
        continue;
      }
      const resolved = resolvePlayerOnRoster(leagueId, raw);
      if ('error' in resolved) return resolved;
      void mustBeMine; // ownership is validated inside evaluateTrade
      assets.push({ kind: 'player', playerId: resolved.playerId });
    }
    return assets;
  };

  const give = resolveAssets(giveNames, true);
  if ('error' in give) return give;
  const receive = resolveAssets(receiveNames, false);
  if ('error' in receive) return receive;

  const rosters = leagueRostersDetailed(leagueId);
  let counterpartyRosterId: number | null = null;
  if (counterparty) {
    const lower = counterparty.toLowerCase();
    counterpartyRosterId = rosters.find((r) => !r.isMe && r.ownerName.toLowerCase().includes(lower))?.rosterId ?? null;
    if (counterpartyRosterId === null) return { error: `no manager matching "${counterparty}"` };
  } else {
    const rosterIds = new Set<number>();
    for (const asset of receive) {
      if (asset.kind !== 'player') continue;
      const owner = rosters.find((r) => r.players.some((p) => p.playerId === asset.playerId));
      if (owner && !owner.isMe) rosterIds.add(owner.rosterId);
    }
    if (rosterIds.size !== 1) return { error: 'could not infer a single counterparty — pass counterparty explicitly' };
    counterpartyRosterId = [...rosterIds][0]!;
  }
  return evaluateTrade({ leagueId, counterpartyRosterId, give, receive });
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
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
    case 'get_edge_board': {
      const a = args as { league?: unknown; sort?: unknown; limit?: unknown };
      result = getEdgeBoard(String(a?.league ?? ''), a?.sort ? String(a.sort) : 'buy', typeof a?.limit === 'number' ? a.limit : 40);
      break;
    }
    case 'evaluate_trade': {
      const a = args as { league?: unknown; give?: unknown; receive?: unknown; counterparty?: unknown };
      result = await mcpEvaluateTrade(
        String(a?.league ?? ''),
        Array.isArray(a?.give) ? a.give.map(String) : [],
        Array.isArray(a?.receive) ? a.receive.map(String) : [],
        a?.counterparty ? String(a.counterparty) : undefined,
      );
      break;
    }
    case 'find_trades': {
      const a = args as { league?: unknown; position?: unknown; stance?: unknown };
      const leagueId = resolveLeagueId(String(a?.league ?? ''));
      result = leagueId
        ? await findTrades(leagueId, {
            position: a?.position ? String(a.position) : undefined,
            stance: a?.stance ? (String(a.stance) as 'any' | 'consolidate' | 'spread') : undefined,
          })
        : { error: `no league matching "${String(a?.league ?? '')}"` };
      break;
    }
    case 'get_matchup': {
      const a = args as { league?: unknown; week?: unknown };
      const leagueId = resolveLeagueId(String(a?.league ?? ''));
      if (!leagueId) {
        result = { error: `no league matching "${String(a?.league ?? '')}"` };
        break;
      }
      const report = await weekReport(leagueId, typeof a?.week === 'number' ? a.week : undefined);
      if ('error' in report) {
        result = report;
        break;
      }
      const round1 = (n: number) => Math.round(n * 10) / 10;
      const lineupOut = (rows: typeof report.myLineup) =>
        rows.map((r) => ({
          slot: r.slot,
          name: r.name,
          pos: r.pos,
          mean: round1(r.mean),
          p10: r.p10 !== null ? round1(r.p10) : null,
          p90: r.p90 !== null ? round1(r.p90) : null,
        }));
      result = {
        league: report.league,
        week: report.week,
        opponent: report.opponentName,
        syntheticOpponent: report.synthetic || undefined,
        winProbPct: round1(report.winProb * 100),
        stance: report.stance,
        myTotalMean: round1(report.myTotalMean),
        oppTotalMean: round1(report.oppTotalMean),
        emptyStartingSlots: report.myLineup.filter((r) => !r.playerId).length || undefined,
        myLineup: lineupOut(report.myLineup),
        oppLineup: report.oppLineup.length > 0 ? lineupOut(report.oppLineup) : undefined,
        swapSuggestions: report.suggestions.map((s) => ({
          slot: s.slot,
          sit: s.out,
          start: s.in,
          deltaWinPp: round1(s.deltaWin),
          deltaMean: round1(s.deltaMean),
          disagree: s.disagree || undefined,
        })),
      };
      break;
    }
    case 'stream_or_hold': {
      const a = args as { league?: unknown; position?: unknown };
      const leagueId = resolveLeagueId(String(a?.league ?? ''));
      if (!leagueId) {
        result = { error: `no league matching "${String(a?.league ?? '')}"` };
        break;
      }
      const report = streamsReport(leagueId);
      if ('error' in report) {
        result = report;
        break;
      }
      const pos = a?.position ? String(a.position).toUpperCase() : null;
      result = {
        league: report.league,
        positions: pos ? report.positions.filter((p) => p.pos === pos) : report.positions,
        myVerdicts: (pos ? report.myVerdicts.filter((v) => v.pos === pos) : report.myVerdicts).map((v) => ({
          name: v.name,
          pos: v.pos,
          starts: v.starts,
          avgPpw: Math.round(v.avgPts * 10) / 10,
          wirePpw: Math.round(v.baselineAvg * 10) / 10,
          margin: Math.round(v.margin * 10) / 10,
          verdict: v.verdict,
          taxi: v.taxi || undefined,
          reserve: v.reserve || undefined,
        })),
      };
      break;
    }
    case 'get_source_health':
      result = sourceHealthStrip();
      break;
    case 'get_manager_tendencies': {
      const league = String((args as { league?: unknown })?.league ?? '');
      const leagueId = resolveLeagueId(league);
      result = leagueId ? getLeagueIntel(leagueId) : { error: `no league matching "${league}"` };
      break;
    }
    default:
      return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
  }
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
