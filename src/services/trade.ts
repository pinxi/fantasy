import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { SEASON, SLEEPER_USER_ID } from '@/config';
import type { ScoringSettings } from '@/scoring/engine';
import { rosterHorizons, type RosterHorizons } from '@/valuation/lineup';
import { buildPlayerPosMap } from '@/valuation/compute';
import { getNflClock } from '@/lib/nfl-clock';
import { getLeagueIntel, type ManagerProfile } from './intel';

// Trade lab v1. Doctrine: score MY side with private league values, model THEIR
// perception with public market consensus. Three horizons: ROS optimal-lineup
// delta (both sides), playoff-weighted delta (weeks 15-17 x2), market delta
// (format-matched, single source per evaluation). Honesty: deltas below the
// noise floor report "even"; bench contributes 0 to lineups in v1 (insurance
// value arrives with distributions — league_weekly_points is the seam).

const EVEN_ROS_PTS = 8; // ≈ 0.5 pt/wk
const EVEN_PLAYOFF_PTS = 3;
const EVEN_MARKET_FRAC = 0.04;
const EVEN_MARKET_MIN = 150;

export type TradeAsset = { kind: 'player'; playerId: string } | { kind: 'pick'; label: string };

export interface ResolvedAsset {
  kind: 'player' | 'pick';
  playerId?: string;
  label: string; // player name or pick label
  pos?: string;
  team?: string | null;
  seasonPts?: number;
  marketValue: number | null;
  taxi?: boolean;
  reserve?: boolean;
}

export interface LeagueShape {
  leagueId: string;
  name: string;
  teams: number;
  scoring: ScoringSettings;
  rosterPositions: string[];
  starterSlots: string[];
  isDynasty: boolean;
  isKeeper: boolean;
  isSf: boolean;
  format: string;
  tradesDisabled: boolean;
  tradeDeadline: number | null;
}

export function leagueShape(leagueId: string): LeagueShape | null {
  const row = db.get<{
    league_id: string;
    name: string;
    total_rosters: number;
    scoring_settings: string;
    roster_positions: string;
    settings: string;
  }>(sql`
    select league_id, name, total_rosters, scoring_settings, roster_positions, settings
    from leagues where league_id = ${leagueId} and season = ${SEASON}
  `);
  if (!row) return null;
  const rosterPositions = JSON.parse(row.roster_positions) as string[];
  const settings = JSON.parse(row.settings) as Record<string, unknown>;
  const isSf = rosterPositions.includes('SUPER_FLEX') || rosterPositions.filter((p) => p === 'QB').length >= 2;
  const isDynasty = settings.type === 2;
  const deadline = typeof settings.trade_deadline === 'number' ? settings.trade_deadline : null;
  return {
    leagueId: row.league_id,
    name: row.name,
    teams: row.total_rosters,
    scoring: JSON.parse(row.scoring_settings) as ScoringSettings,
    rosterPositions,
    starterSlots: rosterPositions.filter((s) => s !== 'BN' && s !== 'IR' && s !== 'TAXI'),
    isDynasty,
    isKeeper: settings.type === 1,
    isSf,
    format: `${isDynasty ? 'dynasty' : 'redraft'}_${isSf ? 'sf' : '1qb'}`,
    tradesDisabled: settings.disable_trades === 1,
    tradeDeadline: deadline !== null && deadline >= 99 ? null : deadline,
  };
}

export function weeklyPointsForLeague(leagueId: string): { runId: number; pts: Map<string, Float64Array> } | null {
  const run = db.get<{ id: number }>(sql`select max(id) as id from valuation_runs where league_id = ${leagueId}`);
  if (!run?.id) return null;
  const rows = db.all<{ player_id: string; week: number; pts: number }>(
    sql`select player_id, week, pts from league_weekly_points where run_id = ${run.id}`,
  );
  if (rows.length === 0) return null;
  const map = new Map<string, Float64Array>();
  for (const row of rows) {
    let arr = map.get(row.player_id);
    if (!arr) map.set(row.player_id, (arr = new Float64Array(18)));
    if (row.week >= 1 && row.week <= 18) arr[row.week - 1] = row.pts;
  }
  return { runId: run.id, pts: map };
}

export function marketMap(format: string, source: 'fantasycalc' | 'ktc'): Map<string, number> {
  const rows = db.all<{ asset_id: string; value: number }>(sql`
    select asset_id, value from market_value_snapshots
    where source = ${source} and format = ${format}
      and snapshot_date = (
        select max(snapshot_date) from market_value_snapshots where source = ${source} and format = ${format}
      )
  `);
  return new Map(rows.map((r) => [r.asset_id, r.value]));
}

export function replacementFromRun(leagueId: string): Record<string, number> {
  const rows = db.all<{ pos: string | null; level: number }>(sql`
    with latest as (select max(id) as run_id from valuation_runs where league_id = ${leagueId})
    select p.pos, lv.points - lv.vorp as level
    from league_values lv join latest on latest.run_id = lv.run_id
    join players p on p.sleeper_id = lv.player_id
    where lv.vorp is not null
    group by p.pos
  `);
  const levels: Record<string, number> = {};
  for (const row of rows) if (row.pos) levels[row.pos] = row.level;
  return levels;
}

export interface RosterDetail {
  rosterId: number;
  ownerId: string | null;
  ownerName: string;
  isMe: boolean;
  players: ResolvedAsset[];
}

export function leagueRostersDetailed(leagueId: string): RosterDetail[] {
  const shape = leagueShape(leagueId);
  if (!shape) return [];
  const market = marketMap(shape.format, 'fantasycalc');
  const values = new Map(
    db
      .all<{ player_id: string; points: number }>(sql`
        with latest as (select max(id) as run_id from valuation_runs where league_id = ${leagueId})
        select player_id, points from league_values lv join latest on latest.run_id = lv.run_id
      `)
      .map((r) => [r.player_id, r.points]),
  );
  const playerMeta = new Map(
    db
      .all<{ sleeper_id: string; full_name: string; pos: string | null; team: string | null }>(
        sql`select sleeper_id, full_name, pos, team from players`,
      )
      .map((r) => [r.sleeper_id, r]),
  );

  const rows = db.all<{
    roster_id: number;
    owner_id: string | null;
    display_name: string | null;
    team_name: string | null;
    player_ids: string | null;
    taxi: string | null;
    reserve: string | null;
  }>(sql`
    select r.roster_id, r.owner_id, u.display_name, u.team_name, r.player_ids, r.taxi, r.reserve
    from rosters r
    left join league_users u on u.league_id = r.league_id and u.user_id = r.owner_id
    where r.league_id = ${leagueId}
    order by r.roster_id
  `);

  return rows.map((row) => {
    const taxi = new Set(row.taxi ? (JSON.parse(row.taxi) as string[]) : []);
    const reserve = new Set(row.reserve ? (JSON.parse(row.reserve) as string[]) : []);
    const ids = row.player_ids ? (JSON.parse(row.player_ids) as string[]) : [];
    const players: ResolvedAsset[] = ids
      .map((id) => {
        const meta = playerMeta.get(id);
        return {
          kind: 'player' as const,
          playerId: id,
          label: meta?.full_name ?? id,
          pos: meta?.pos ?? undefined,
          team: meta?.team ?? null,
          seasonPts: values.get(id),
          marketValue: market.get(id) ?? null,
          taxi: taxi.has(id),
          reserve: reserve.has(id),
        };
      })
      .sort((a, b) => (b.seasonPts ?? 0) - (a.seasonPts ?? 0));
    return {
      rosterId: row.roster_id,
      ownerId: row.owner_id,
      ownerName: row.team_name ?? row.display_name ?? `roster ${row.roster_id}`,
      isMe: row.owner_id === SLEEPER_USER_ID,
      players,
    };
  });
}

// -- pick labels ------------------------------------------------------------

const PICK_RE = /^(20\d{2})\s+(early|mid|late)?\s*(1st|2nd|3rd|4th)$/i;

export function parsePickLabel(input: string): string | null {
  const match = PICK_RE.exec(input.trim().toLowerCase().replace(/\s+/g, ' '));
  if (!match) return null;
  const tier = match[2] ? match[2][0]!.toUpperCase() + match[2].slice(1) : 'Mid';
  return `${match[1]} ${tier} ${match[3]}`;
}

// -- evaluation ---------------------------------------------------------------

export interface SideEval {
  rosterId: number;
  ownerName: string;
  before: RosterHorizons;
  after: RosterHorizons;
  deltaRos: number;
  deltaPlayoff: number;
  deltaWeighted: number;
  deltaMarket: number;
  positions: Array<{ pos: string; startsBefore: number; startsAfter: number; startableBefore: number; startableAfter: number }>;
}

export interface TradeEvaluation {
  league: { leagueId: string; name: string; format: string; isDynasty: boolean };
  fromWeek: number;
  marketSource: 'fantasycalc' | 'ktc';
  me: SideEval;
  them: SideEval;
  verdict: { ros: string; playoff: string; market: string };
  warnings: string[];
  assets: { give: ResolvedAsset[]; receive: ResolvedAsset[] };
}

export interface EvaluateTradeInput {
  leagueId: string;
  counterpartyRosterId: number;
  give: TradeAsset[];
  receive: TradeAsset[];
  fromWeek?: number;
}

function verdictOf(delta: number, evenThreshold: number): string {
  if (Math.abs(delta) <= evenThreshold) return 'even';
  return delta > 0 ? 'gain' : 'loss';
}

export async function evaluateTrade(input: EvaluateTradeInput): Promise<TradeEvaluation | { error: string }> {
  const shape = leagueShape(input.leagueId);
  if (!shape) return { error: `league not found: ${input.leagueId}` };
  if (shape.tradesDisabled) return { error: `trades are disabled in ${shape.name}` };

  const weekly = weeklyPointsForLeague(input.leagueId);
  if (!weekly) return { error: `no weekly valuation data for ${shape.name} — run a recompute first` };

  const rosters = leagueRostersDetailed(input.leagueId);
  const mine = rosters.find((r) => r.isMe);
  const theirs = rosters.find((r) => r.rosterId === input.counterpartyRosterId);
  if (!mine) return { error: `no roster owned by me in ${shape.name}` };
  if (!theirs) return { error: `counterparty roster ${input.counterpartyRosterId} not found` };
  if (theirs.rosterId === mine.rosterId) return { error: 'counterparty is my own roster — cannot trade with yourself' };

  const warnings: string[] = [];
  const clock = await getNflClock();
  const fromWeek = input.fromWeek ?? (clock.seasonType === 'regular' ? Math.max(clock.week, 1) : 1);

  if (shape.tradeDeadline !== null && clock.seasonType === 'regular' && clock.week > shape.tradeDeadline) {
    warnings.push(`past trade deadline (wk ${shape.tradeDeadline})`);
  }

  const hasPicks = [...input.give, ...input.receive].some((a) => a.kind === 'pick');
  let marketSource: 'fantasycalc' | 'ktc' = hasPicks ? 'ktc' : 'fantasycalc';
  let market = marketMap(shape.format, marketSource);

  const resolveAsset = (asset: TradeAsset, roster: RosterDetail): ResolvedAsset | { error: string } => {
    if (asset.kind === 'pick') {
      if (!shape.isDynasty) return { error: 'picks are dynasty-only' };
      const canonical = parsePickLabel(asset.label) ?? asset.label;
      return { kind: 'pick', label: canonical, marketValue: market.get(canonical) ?? null };
    }
    const onRoster = roster.players.find((p) => p.playerId === asset.playerId);
    if (!onRoster) return { error: `${asset.playerId} is not on ${roster.ownerName}'s roster` };
    return { ...onRoster, marketValue: market.get(asset.playerId) ?? null };
  };

  const give: ResolvedAsset[] = [];
  const receive: ResolvedAsset[] = [];
  for (const asset of input.give) {
    const resolved = resolveAsset(asset, mine);
    if ('error' in resolved) return resolved;
    give.push(resolved);
  }
  for (const asset of input.receive) {
    const resolved = resolveAsset(asset, theirs);
    if ('error' in resolved) return resolved;
    receive.push(resolved);
  }

  // Source coherence: switch the whole evaluation if the other source covers
  // more of the traded players.
  const players = [...give, ...receive].filter((a) => a.kind === 'player');
  const covered = (m: Map<string, number>) => players.filter((a) => m.has(a.playerId!)).length;
  if (!hasPicks && covered(market) < players.length) {
    const alt = marketMap(shape.format, 'ktc');
    if (covered(alt) > covered(market)) {
      marketSource = 'ktc';
      market = alt;
      for (const a of [...give, ...receive]) if (a.kind === 'player') a.marketValue = market.get(a.playerId!) ?? null;
    }
  }
  for (const a of [...give, ...receive]) {
    if (a.marketValue === null) warnings.push(`no ${marketSource} value for ${a.label}`);
    if (a.kind === 'pick') warnings.push(`pick ownership not verified (${a.label})`);
    if (a.taxi) warnings.push(`${a.label} is on taxi — market value only, no lineup impact`);
    if (a.reserve) warnings.push(`${a.label} is on IR — market value only, no lineup impact`);
  }
  if (give.length === 0 || receive.length === 0) warnings.push('one-sided trade');

  const posOf = buildPlayerPosMap();
  const replacement = replacementFromRun(input.leagueId);

  const activeIds = (roster: RosterDetail, exclude: Set<string>, add: string[]): string[] => {
    const base = roster.players.filter((p) => !p.taxi && !p.reserve && !exclude.has(p.playerId!)).map((p) => p.playerId!);
    // Incoming taxi/IR players stay excluded (symmetric v1 rule).
    const incoming = add.filter((id) => {
      const asset = [...give, ...receive].find((a) => a.playerId === id);
      return !(asset?.taxi || asset?.reserve);
    });
    return [...base, ...incoming];
  };

  const giveIds = new Set(give.filter((a) => a.kind === 'player').map((a) => a.playerId!));
  const receiveIds = receive.filter((a) => a.kind === 'player').map((a) => a.playerId!);

  const evalSide = (roster: RosterDetail, lose: Set<string>, gain: string[]): SideEval => {
    const beforeIds = activeIds(roster, new Set(), []);
    const afterIds = activeIds(roster, lose, gain);
    const before = rosterHorizons(beforeIds, weekly.pts, posOf, shape.starterSlots, fromWeek);
    const after = rosterHorizons(afterIds, weekly.pts, posOf, shape.starterSlots, fromWeek);

    const startable = (ids: string[]): Record<string, number> => {
      const counts: Record<string, number> = {};
      for (const id of ids) {
        const pos = posOf.get(id);
        if (!pos) continue;
        const season = [...(weekly.pts.get(id) ?? [])].reduce((a, b) => a + b, 0);
        if (season >= (replacement[pos] ?? 0)) counts[pos] = (counts[pos] ?? 0) + 1;
      }
      return counts;
    };
    const sb = startable(beforeIds);
    const sa = startable(afterIds);
    const positions = [...new Set([...Object.keys(before.startsByPos), ...Object.keys(after.startsByPos)])].map((pos) => ({
      pos,
      startsBefore: before.startsByPos[pos] ?? 0,
      startsAfter: after.startsByPos[pos] ?? 0,
      startableBefore: sb[pos] ?? 0,
      startableAfter: sa[pos] ?? 0,
    }));

    const marketOut = (lose.size > 0 ? [...lose] : []).reduce((s, id) => s + (market.get(id) ?? 0), 0);
    const marketIn = gain.reduce((s, id) => s + (market.get(id) ?? 0), 0);
    return {
      rosterId: roster.rosterId,
      ownerName: roster.ownerName,
      before,
      after,
      deltaRos: after.rosPts - before.rosPts,
      deltaPlayoff: after.playoffPts - before.playoffPts,
      deltaWeighted: after.weightedPts - before.weightedPts,
      deltaMarket: marketIn - marketOut,
      positions,
    };
  };

  const me = evalSide(mine, giveIds, receiveIds);
  const them = evalSide(theirs, new Set(receiveIds), [...giveIds]);

  // Picks contribute market value only.
  const pickMarket = (assets: ResolvedAsset[]) => assets.filter((a) => a.kind === 'pick').reduce((s, a) => s + (a.marketValue ?? 0), 0);
  me.deltaMarket += pickMarket(receive) - pickMarket(give);
  them.deltaMarket += pickMarket(give) - pickMarket(receive);

  for (const side of [me, them]) {
    for (const p of side.positions) {
      const dedicated = shape.starterSlots.filter((s) => s === p.pos).length;
      if (dedicated > 0 && p.startableAfter < dedicated && p.startableBefore >= dedicated) {
        warnings.push(`${side.ownerName}: ${p.pos} drops below startable depth`);
      }
    }
    for (const [slot, weeks] of Object.entries(side.after.emptySlotWeeks)) {
      if (!(slot in side.before.emptySlotWeeks) || side.after.emptySlotWeeks[slot]! > (side.before.emptySlotWeeks[slot] ?? 0)) {
        warnings.push(`${side.ownerName}: cannot fill ${slot} in ${weeks} week(s) post-trade`);
      }
    }
  }

  const marketScale = Math.max(
    give.reduce((s, a) => s + (a.marketValue ?? 0), 0),
    receive.reduce((s, a) => s + (a.marketValue ?? 0), 0),
    1,
  );
  return {
    league: { leagueId: shape.leagueId, name: shape.name, format: shape.format, isDynasty: shape.isDynasty },
    fromWeek,
    marketSource,
    me,
    them,
    verdict: {
      ros: verdictOf(me.deltaRos, EVEN_ROS_PTS),
      playoff: verdictOf(me.deltaPlayoff, EVEN_PLAYOFF_PTS),
      market: verdictOf(me.deltaMarket, Math.max(EVEN_MARKET_MIN, marketScale * EVEN_MARKET_FRAC)),
    },
    warnings: [...new Set(warnings)],
    assets: { give, receive },
  };
}

// -- finder -------------------------------------------------------------------

export interface TradeProposal {
  counterpartyRosterId: number;
  ownerName: string;
  give: ResolvedAsset[];
  receive: ResolvedAsset[];
  myDeltaRos: number;
  myDeltaWeighted: number;
  theirDeltaRos: number;
  theirDeltaMarket: number;
  plausibility: number;
  score: number;
  reasons: string[];
}

export interface FindTradesOptions {
  position?: string;
  stance?: 'any' | 'consolidate' | 'spread';
  limit?: number;
  maxPerRival?: number;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export async function findTrades(leagueId: string, opts: FindTradesOptions = {}): Promise<TradeProposal[] | { error: string }> {
  const shape = leagueShape(leagueId);
  if (!shape) return { error: `league not found: ${leagueId}` };
  if (shape.tradesDisabled) return { error: `trades are disabled in ${shape.name}` };
  const weekly = weeklyPointsForLeague(leagueId);
  if (!weekly) return { error: `no weekly valuation data — recompute first` };

  const { position, stance = 'any', limit = 12, maxPerRival = 3 } = opts;
  const rosters = leagueRostersDetailed(leagueId);
  const mine = rosters.find((r) => r.isMe);
  if (!mine) return { error: 'no roster owned by me in this league' };

  const posOf = buildPlayerPosMap();
  const clock = await getNflClock();
  const fromWeek = clock.seasonType === 'regular' ? Math.max(clock.week, 1) : 1;
  const intel = getLeagueIntel(leagueId);
  const profileByUser = new Map<string, ManagerProfile>(intel?.managers.map((m) => [m.userId, m]) ?? []);

  const mval = (a: ResolvedAsset) => a.marketValue ?? 0;
  const activePool = (r: RosterDetail) =>
    r.players
      .filter((p) => !p.taxi && !p.reserve)
      .sort((a, b) => mval(b) - mval(a) || (b.seasonPts ?? 0) - (a.seasonPts ?? 0))
      .slice(0, 15);

  const myPool = activePool(mine);
  const horizonCache = new Map<string, RosterHorizons>();
  const baseHorizons = (r: RosterDetail): RosterHorizons => {
    let cached = horizonCache.get(`base:${r.rosterId}`);
    if (!cached) {
      const ids = r.players.filter((p) => !p.taxi && !p.reserve).map((p) => p.playerId!);
      horizonCache.set(`base:${r.rosterId}`, (cached = rosterHorizons(ids, weekly.pts, posOf, shape.starterSlots, fromWeek)));
    }
    return cached;
  };

  const deltaFor = (r: RosterDetail, lose: string[], gain: string[]): number => {
    const ids = r.players
      .filter((p) => !p.taxi && !p.reserve && !lose.includes(p.playerId!))
      .map((p) => p.playerId!)
      .concat(gain);
    return rosterHorizons(ids, weekly.pts, posOf, shape.starterSlots, fromWeek).rosPts - baseHorizons(r).rosPts;
  };

  const proposals: TradeProposal[] = [];
  for (const rival of rosters) {
    if (rival.isMe || !rival.ownerId) continue;
    const profile = profileByUser.get(rival.ownerId);
    const theirPool = activePool(rival).filter((p) => !position || p.pos === position.toUpperCase());
    if (theirPool.length === 0) continue;

    interface Candidate {
      give: ResolvedAsset[];
      receive: ResolvedAsset[];
    }
    const candidates: Candidate[] = [];
    if (stance !== 'consolidate') {
      for (const g of myPool) for (const r of theirPool) candidates.push({ give: [g], receive: [r] });
    }
    if (stance === 'any' || stance === 'consolidate') {
      const pairs = myPool.slice(0, 10);
      for (let i = 0; i < pairs.length; i++)
        for (let j = i + 1; j < pairs.length; j++)
          for (const r of theirPool.slice(0, 10)) candidates.push({ give: [pairs[i]!, pairs[j]!], receive: [r] });
    }
    if (stance === 'any' || stance === 'spread') {
      const theirPairs = theirPool.slice(0, 10);
      for (const g of myPool.slice(0, 10))
        for (let i = 0; i < theirPairs.length; i++)
          for (let j = i + 1; j < theirPairs.length; j++) candidates.push({ give: [g], receive: [theirPairs[i]!, theirPairs[j]!] });
    }

    // Stage 1: cheap market/sanity gates.
    const gated = candidates
      .map((c) => {
        const giveMkt = c.give.reduce((s, a) => s + mval(a), 0);
        const recvMkt = c.receive.reduce((s, a) => s + mval(a), 0);
        const theirDeltaMarket = giveMkt - recvMkt;
        const myDeltaMarket = recvMkt - giveMkt;
        return { ...c, giveMkt, recvMkt, theirDeltaMarket, myDeltaMarket };
      })
      .filter((c) => c.theirDeltaMarket >= -Math.max(200, 0.05 * c.recvMkt)) // never propose fleecings
      .filter((c) => c.myDeltaMarket >= -0.25 * Math.max(c.giveMkt, 1)) // premium for points OK, within reason
      .filter((c) => !(c.give.length === 1 && c.receive.length === 1 && c.give[0]!.pos === c.receive[0]!.pos && Math.abs((c.give[0]!.seasonPts ?? 0) - (c.receive[0]!.seasonPts ?? 0)) < 15))
      .sort((a, b) => b.theirDeltaMarket + b.recvMkt * 0.01 - (a.theirDeltaMarket + a.recvMkt * 0.01))
      .slice(0, 40);

    // Stage 2: exact lineup deltas + plausibility.
    for (const c of gated) {
      const giveIds = c.give.map((a) => a.playerId!);
      const recvIds = c.receive.map((a) => a.playerId!);
      const myDeltaRos = deltaFor(mine, giveIds, recvIds);
      if (myDeltaRos < 5) continue;
      const theirDeltaRos = deltaFor(rival, recvIds, giveIds);

      const tradeSize = Math.max(c.giveMkt, c.recvMkt, 1);
      const fairness = clamp01(0.5 + c.theirDeltaMarket / (0.3 * tradeSize));
      let posNetFit = 0.5;
      const reasons: string[] = [`+${myDeltaRos.toFixed(1)} ROS pts for you`];
      if (profile) {
        const fits: number[] = [];
        for (const a of c.give) {
          const net = profile.trades.posNet[(a.pos as keyof typeof profile.trades.posNet) ?? '?'] ?? 0;
          fits.push(net > 0 ? 1 : net <= -2 ? 0 : 0.5);
          if (net > 0) reasons.push(`they historically acquire ${a.pos} (net +${net})`);
        }
        for (const a of c.receive) {
          const net = profile.trades.posNet[(a.pos as keyof typeof profile.trades.posNet) ?? '?'] ?? 0;
          fits.push(net < 0 ? 1 : net >= 2 ? 0 : 0.5);
          if (net < 0) reasons.push(`they historically ship ${a.pos} (net ${net})`);
        }
        posNetFit = fits.length > 0 ? fits.reduce((a, b) => a + b, 0) / fits.length : 0.5;
      }
      const partnerBias = profile?.trades.topPartners.some((p) => p.userId === SLEEPER_USER_ID)
        ? 1
        : (profile?.trades.total ?? 0) > 0
          ? 0.5
          : 0.3;
      if (partnerBias === 1) reasons.push('frequent trade partner of yours');
      const activity = clamp01((profile?.trades.perSeason ?? 0) / 4);
      const theirLineupOk = theirDeltaRos >= -5 ? 1 : theirDeltaRos >= -20 ? 0.5 : 0;
      if (c.theirDeltaMarket > 0) reasons.push(`market: they gain +${Math.round(c.theirDeltaMarket)} (fair for them)`);
      reasons.push(`their lineup ${theirDeltaRos >= -5 ? '≈ unchanged' : 'weakens'} (${theirDeltaRos.toFixed(1)})`);

      const plausibility = 0.45 * fairness + 0.2 * posNetFit + 0.15 * partnerBias + 0.1 * activity + 0.1 * theirLineupOk;
      if (plausibility < 0.2) continue;

      proposals.push({
        counterpartyRosterId: rival.rosterId,
        ownerName: rival.ownerName,
        give: c.give,
        receive: c.receive,
        myDeltaRos,
        myDeltaWeighted: myDeltaRos, // v1: weighted computed on demand in full eval
        theirDeltaRos,
        theirDeltaMarket: c.theirDeltaMarket,
        plausibility,
        score: myDeltaRos * plausibility,
        reasons,
      });
    }
  }

  // Dedup identical receive sets, cap per rival, global limit.
  proposals.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const perRival = new Map<number, number>();
  const out: TradeProposal[] = [];
  for (const p of proposals) {
    const key = `${p.counterpartyRosterId}:${p.receive.map((a) => a.playerId).sort().join(',')}`;
    if (seen.has(key)) continue;
    const count = perRival.get(p.counterpartyRosterId) ?? 0;
    if (count >= maxPerRival) continue;
    seen.add(key);
    perRival.set(p.counterpartyRosterId, count + 1);
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

// -- MCP resolvers ------------------------------------------------------------

export function resolvePlayerOnRoster(
  leagueId: string,
  name: string,
): { playerId: string; rosterId: number; name: string } | { error: string; candidates?: string[] } {
  const normalized = name.toLowerCase().replace(/[.'’-]/g, '').trim();
  const rosters = leagueRostersDetailed(leagueId);
  const matches: Array<{ playerId: string; rosterId: number; name: string }> = [];
  for (const roster of rosters) {
    for (const p of roster.players) {
      if (p.label.toLowerCase().replace(/[.'’-]/g, '').includes(normalized)) {
        matches.push({ playerId: p.playerId!, rosterId: roster.rosterId, name: p.label });
      }
    }
  }
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) return { error: `no rostered player matching "${name}"` };
  const unique = [...new Set(matches.map((m) => m.name))];
  if (unique.length === 1) return matches[0]!;
  return { error: `ambiguous name "${name}"`, candidates: unique.slice(0, 5) };
}
