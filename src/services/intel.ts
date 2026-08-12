import { inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { SLEEPER_USER_ID } from '@/config';
import { draftPicks, drafts, leagues, leagueUsers, players, rosters, transactions } from '@/db/schema';

// Manager tendency profiles, computed over a league's full previous_league_id
// chain (every season the backfill has archived). Attribution: draft picks by
// picked_by (fallback roster→owner), transactions by roster_ids→owner.

export type PosGroup = 'QB' | 'RB' | 'WR' | 'TE' | 'K' | 'DEF' | 'IDP' | '?';

const IDP_POS = new Set(['DL', 'LB', 'DB', 'DE', 'DT', 'CB', 'S', 'EDGE', 'NT', 'OLB', 'ILB', 'FS', 'SS']);

function posGroup(pos: string | null | undefined): PosGroup {
  if (!pos) return '?';
  if (['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].includes(pos)) return pos as PosGroup;
  if (IDP_POS.has(pos)) return 'IDP';
  return '?';
}

export interface AuctionProfile {
  auctions: number; // completed auctions with data for this manager
  avgSpend: number; // avg total $ per auction
  avgBudget: number;
  spendMix: Partial<Record<PosGroup, number>>; // share of $ by position (0-1)
  top1Share: number; // avg share of own spend on single biggest buy
  top3Share: number;
  dollarFlyers: number; // avg count of ≤$2 buys per auction
  earlySpendShare: number; // share of own $ committed in first third of the room's picks
  maxBuy: { name: string; pos: PosGroup; amount: number; season: number } | null;
}

export interface SnakeProfile {
  drafts: number; // manager-seasons of startup/redraft snake data
  firstRound: Partial<Record<PosGroup, number>>; // avg round of first pick at position
  earlyMix: Partial<Record<PosGroup, number>>; // share of rounds 1-3 picks by position
  keeperPicks: number;
}

export interface RookieProfile {
  drafts: number;
  picks: number;
  posMix: Partial<Record<PosGroup, number>>;
}

export interface TradeProfile {
  total: number;
  perSeason: number;
  playersAcquired: number;
  playersSent: number;
  posNet: Partial<Record<PosGroup, number>>; // players acquired − sent, by position
  picksAcquired: number;
  picksSent: number;
  faabNet: number;
  topPartners: Array<{ userId: string; name: string; count: number }>;
  avgWeek: number | null; // in-season timing of their trades
}

export interface FaabProfile {
  seasonsWithData: number;
  winsPerSeason: number;
  spendPerSeason: number;
  budgetShare: number | null; // avg spend / league waiver budget
  maxBid: number;
  avgBid: number;
  addsPerSeason: number; // free-agent + waiver adds (activity)
}

export interface ManagerProfile {
  userId: string;
  displayName: string;
  teamName: string | null;
  isMe: boolean;
  seasons: number[];
  auction: AuctionProfile | null;
  rookieAuction: AuctionProfile | null; // small rookies-only auctions (e.g. FAAB rookie events) — different game than a startup/redraft auction
  snake: SnakeProfile | null;
  rookie: RookieProfile | null;
  trades: TradeProfile;
  faab: FaabProfile | null;
  tags: string[];
}

export interface LeagueIntel {
  leagueId: string;
  name: string;
  season: number;
  isSF: boolean;
  isTEP: boolean;
  chainSeasons: number[];
  managers: ManagerProfile[];
}

type LeagueRow = typeof leagues.$inferSelect;

function walkChain(currentLeagueId: string): LeagueRow[] {
  const all = db.select().from(leagues).all();
  const byId = new Map(all.map((l) => [l.leagueId, l]));
  const chain: LeagueRow[] = [];
  let id: string | null = currentLeagueId;
  while (id && id !== '0' && chain.length < 12) {
    const row = byId.get(id);
    if (!row) break;
    chain.push(row);
    id = row.previousLeagueId;
  }
  return chain;
}

function chunkedPlayerRows(ids: string[]): Array<{ sleeperId: string; fullName: string; pos: string | null }> {
  const out: Array<{ sleeperId: string; fullName: string; pos: string | null }> = [];
  for (let i = 0; i < ids.length; i += 400) {
    out.push(
      ...db
        .select({ sleeperId: players.sleeperId, fullName: players.fullName, pos: players.pos })
        .from(players)
        .where(inArray(players.sleeperId, ids.slice(i, i + 400)))
        .all(),
    );
  }
  return out;
}

const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round2 = (x: number): number => Math.round(x * 100) / 100;

export function getLeagueIntel(currentLeagueId: string): LeagueIntel | null {
  const chain = walkChain(currentLeagueId);
  const current = chain[0];
  if (!current) return null;
  const chainIds = chain.map((l) => l.leagueId);
  const seasonByLeague = new Map(chain.map((l) => [l.leagueId, l.season]));

  const userRows = db.select().from(leagueUsers).where(inArray(leagueUsers.leagueId, chainIds)).all();
  const rosterRows = db.select().from(rosters).where(inArray(rosters.leagueId, chainIds)).all();
  const draftRows = db.select().from(drafts).where(inArray(drafts.leagueId, chainIds)).all();
  const completeDrafts = draftRows.filter((d) => d.status === 'complete');
  const pickRows = completeDrafts.length
    ? db
        .select()
        .from(draftPicks)
        .where(
          inArray(
            draftPicks.draftId,
            completeDrafts.map((d) => d.draftId),
          ),
        )
        .all()
    : [];
  const txRows = db.select().from(transactions).where(inArray(transactions.leagueId, chainIds)).all();
  const completeTx = txRows.filter((t) => t.status === 'complete');

  // roster → owner per league-season
  const ownerOf = new Map<string, string>();
  for (const r of rosterRows) if (r.ownerId) ownerOf.set(`${r.leagueId}:${r.rosterId}`, r.ownerId);

  const seasonsByUser = new Map<string, Set<number>>();
  for (const r of rosterRows) {
    if (!r.ownerId) continue;
    const season = seasonByLeague.get(r.leagueId);
    if (season === undefined) continue;
    if (!seasonsByUser.has(r.ownerId)) seasonsByUser.set(r.ownerId, new Set());
    seasonsByUser.get(r.ownerId)!.add(season);
  }

  // display names: prefer the current league's entry, fall back to most recent historical
  const nameByUser = new Map<string, { displayName: string; teamName: string | null }>();
  for (const u of [...userRows].sort((a, b) => (seasonByLeague.get(a.leagueId) ?? 0) - (seasonByLeague.get(b.leagueId) ?? 0))) {
    nameByUser.set(u.userId, { displayName: u.displayName ?? u.userId, teamName: u.teamName });
  }
  const currentUserIds = userRows.filter((u) => u.leagueId === current.leagueId).map((u) => u.userId);

  // player metadata for every id seen in picks or trades
  const playerIds = new Set<string>();
  for (const p of pickRows) if (p.playerId) playerIds.add(p.playerId);
  for (const t of completeTx) {
    for (const pid of Object.keys(t.adds ?? {})) playerIds.add(pid);
    for (const pid of Object.keys(t.drops ?? {})) playerIds.add(pid);
  }
  const playerRows = chunkedPlayerRows([...playerIds]);
  const playerById = new Map(playerRows.map((p) => [p.sleeperId, p]));
  const posOf = (pid: string | null, meta: Record<string, unknown> | null): PosGroup =>
    posGroup((pid ? playerById.get(pid)?.pos : null) ?? ((meta?.position as string) || null));

  // ---- draft aggregation ------------------------------------------------
  const draftById = new Map(completeDrafts.map((d) => [d.draftId, d]));
  const maxPickNoByDraft = new Map<string, number>();
  for (const p of pickRows) {
    maxPickNoByDraft.set(p.draftId, Math.max(maxPickNoByDraft.get(p.draftId) ?? 0, p.pickNo));
  }
  const pickCountByDraft = new Map<string, number>();
  for (const p of pickRows) pickCountByDraft.set(p.draftId, (pickCountByDraft.get(p.draftId) ?? 0) + 1);
  // ≤5 picks per team = a rookie/supplemental event, not a full startup/redraft draft
  const kindOf = (d: (typeof completeDrafts)[number]): 'auction' | 'rookieAuction' | 'rookie' | 'snake' => {
    const settings = d.settings as Record<string, unknown> | null;
    const teams = Number(settings?.teams ?? current.totalRosters ?? 10);
    const picksPerTeam = (pickCountByDraft.get(d.draftId) ?? 0) / Math.max(teams, 1);
    if (d.type === 'auction') return picksPerTeam <= 5 ? 'rookieAuction' : 'auction';
    const rounds = Number(settings?.rounds ?? 99);
    return rounds <= 5 || picksPerTeam <= 5 ? 'rookie' : 'snake';
  };

  interface UserAuctionSeason {
    season: number;
    budget: number;
    spend: number;
    amounts: number[];
    byPos: Map<PosGroup, number>;
    flyers: number;
    earlySpend: number;
    maxBuy: { name: string; pos: PosGroup; amount: number; season: number } | null;
  }
  const auctionByUser = new Map<string, UserAuctionSeason[]>();
  const rookieAuctionByUser = new Map<string, UserAuctionSeason[]>();
  interface UserSnakeSeason {
    season: number;
    firstRound: Map<PosGroup, number>;
    earlyByPos: Map<PosGroup, number>;
    earlyTotal: number;
    keepers: number;
  }
  const snakeByUser = new Map<string, UserSnakeSeason[]>();
  const rookieByUser = new Map<string, { drafts: Set<string>; byPos: Map<PosGroup, number>; picks: number }>();

  const seasonBuckets = new Map<string, UserAuctionSeason>(); // `${draftId}:${userId}`
  const snakeBuckets = new Map<string, UserSnakeSeason>();

  for (const p of pickRows) {
    const d = draftById.get(p.draftId);
    if (!d || !d.leagueId) continue;
    const user = p.pickedBy ?? ownerOf.get(`${d.leagueId}:${p.rosterId}`);
    if (!user) continue;
    const season = d.season ?? seasonByLeague.get(d.leagueId) ?? 0;
    const pos = posOf(p.playerId, p.metadata);
    const kind = kindOf(d);

    if (kind === 'auction' || kind === 'rookieAuction') {
      const byUser = kind === 'auction' ? auctionByUser : rookieAuctionByUser;
      const key = `${p.draftId}:${user}`;
      let bucket = seasonBuckets.get(key);
      if (!bucket) {
        bucket = {
          season,
          budget: Number((d.settings as Record<string, unknown> | null)?.budget ?? 0),
          spend: 0,
          amounts: [],
          byPos: new Map(),
          flyers: 0,
          earlySpend: 0,
          maxBuy: null,
        };
        seasonBuckets.set(key, bucket);
        if (!byUser.has(user)) byUser.set(user, []);
        byUser.get(user)!.push(bucket);
      }
      const amount = p.amount ?? 0;
      if (p.isKeeper) continue; // keeper $ isn't a live bid
      bucket.spend += amount;
      bucket.amounts.push(amount);
      bucket.byPos.set(pos, (bucket.byPos.get(pos) ?? 0) + amount);
      if (amount <= 2) bucket.flyers++;
      const maxPickNo = maxPickNoByDraft.get(p.draftId) ?? 1;
      if (p.pickNo <= maxPickNo / 3) bucket.earlySpend += amount;
      const meta = p.metadata as Record<string, unknown> | null;
      const name =
        (p.playerId ? playerById.get(p.playerId)?.fullName : null) ??
        [meta?.first_name, meta?.last_name].filter(Boolean).join(' ');
      if (!bucket.maxBuy || amount > bucket.maxBuy.amount) bucket.maxBuy = { name: name || '?', pos, amount, season };
    } else if (kind === 'snake') {
      const key = `${p.draftId}:${user}`;
      let bucket = snakeBuckets.get(key);
      if (!bucket) {
        bucket = { season, firstRound: new Map(), earlyByPos: new Map(), earlyTotal: 0, keepers: 0 };
        snakeBuckets.set(key, bucket);
        if (!snakeByUser.has(user)) snakeByUser.set(user, []);
        snakeByUser.get(user)!.push(bucket);
      }
      if (p.isKeeper) {
        bucket.keepers++;
        continue;
      }
      const round = p.round ?? 0;
      if (round > 0 && !bucket.firstRound.has(pos)) bucket.firstRound.set(pos, round);
      if (round >= 1 && round <= 3) {
        bucket.earlyByPos.set(pos, (bucket.earlyByPos.get(pos) ?? 0) + 1);
        bucket.earlyTotal++;
      }
    } else {
      if (p.isKeeper) continue;
      let bucket = rookieByUser.get(user);
      if (!bucket) {
        bucket = { drafts: new Set(), byPos: new Map(), picks: 0 };
        rookieByUser.set(user, bucket);
      }
      bucket.drafts.add(p.draftId);
      bucket.byPos.set(pos, (bucket.byPos.get(pos) ?? 0) + 1);
      bucket.picks++;
    }
  }

  // ---- transactions ------------------------------------------------------
  interface TradeAgg {
    total: number;
    playersAcquired: number;
    playersSent: number;
    posNet: Map<PosGroup, number>;
    picksAcquired: number;
    picksSent: number;
    faabNet: number;
    partners: Map<string, number>;
    weeks: number[];
  }
  const tradeByUser = new Map<string, TradeAgg>();
  const tradeAgg = (u: string): TradeAgg => {
    let t = tradeByUser.get(u);
    if (!t) {
      t = {
        total: 0,
        playersAcquired: 0,
        playersSent: 0,
        posNet: new Map(),
        picksAcquired: 0,
        picksSent: 0,
        faabNet: 0,
        partners: new Map(),
        weeks: [],
      };
      tradeByUser.set(u, t);
    }
    return t;
  };

  interface FaabAgg {
    seasons: Map<number, { spend: number; wins: number; adds: number; budget: number }>;
    maxBid: number;
    bids: number[];
  }
  const faabByUser = new Map<string, FaabAgg>();
  const faabSeason = (u: string, season: number, budget: number) => {
    let f = faabByUser.get(u);
    if (!f) {
      f = { seasons: new Map(), maxBid: 0, bids: [] };
      faabByUser.set(u, f);
    }
    let s = f.seasons.get(season);
    if (!s) {
      s = { spend: 0, wins: 0, adds: 0, budget };
      f.seasons.set(season, s);
    }
    return { f, s };
  };

  for (const t of completeTx) {
    const season = seasonByLeague.get(t.leagueId) ?? 0;
    const league = chain.find((l) => l.leagueId === t.leagueId);
    const waiverBudget = Number((league?.settings as Record<string, unknown> | null)?.waiver_budget ?? 100);
    const owner = (rid: number | undefined | null): string | undefined =>
      rid === undefined || rid === null ? undefined : ownerOf.get(`${t.leagueId}:${rid}`);

    if (t.type === 'trade') {
      const participants = (t.rosterIds ?? []).map((rid) => owner(rid)).filter((u): u is string => !!u);
      const uniq = [...new Set(participants)];
      for (const u of uniq) {
        const agg = tradeAgg(u);
        agg.total++;
        if (t.week) agg.weeks.push(t.week);
        for (const v of uniq) if (v !== u) agg.partners.set(v, (agg.partners.get(v) ?? 0) + 1);
        for (const [pid, rid] of Object.entries(t.adds ?? {})) {
          if (owner(rid) !== u) continue;
          agg.playersAcquired++;
          const pos = posOf(pid, null);
          agg.posNet.set(pos, (agg.posNet.get(pos) ?? 0) + 1);
        }
        for (const [pid, rid] of Object.entries(t.drops ?? {})) {
          if (owner(rid) !== u) continue;
          agg.playersSent++;
          const pos = posOf(pid, null);
          agg.posNet.set(pos, (agg.posNet.get(pos) ?? 0) - 1);
        }
        for (const pk of t.tradedPicks ?? []) {
          if (owner(pk.owner_id) === u) agg.picksAcquired++;
          if (owner(pk.previous_owner_id) === u) agg.picksSent++;
        }
        for (const wb of t.waiverBudget ?? []) {
          if (owner(wb.receiver) === u) agg.faabNet += wb.amount;
          if (owner(wb.sender) === u) agg.faabNet -= wb.amount;
        }
      }
    } else if (t.type === 'waiver' || t.type === 'free_agent') {
      const u = owner((t.rosterIds ?? [])[0]);
      if (!u) continue;
      const { f, s } = faabSeason(u, season, waiverBudget);
      if (Object.keys(t.adds ?? {}).length > 0) s.adds++;
      if (t.type === 'waiver') {
        const bid = t.faabBid ?? 0;
        s.wins++;
        s.spend += bid;
        f.maxBid = Math.max(f.maxBid, bid);
        if (bid > 0) f.bids.push(bid);
      }
    }
  }

  // ---- assemble profiles -------------------------------------------------
  const isSF =
    (current.rosterPositions ?? []).includes('SUPER_FLEX') ||
    (current.rosterPositions ?? []).filter((p) => p === 'QB').length >= 2;
  const isTEP = ((current.scoringSettings ?? {})['bonus_rec_te'] ?? 0) > 0;

  const managers: ManagerProfile[] = currentUserIds.map((userId) => {
    const names = nameByUser.get(userId) ?? { displayName: userId, teamName: null };
    const seasons = [...(seasonsByUser.get(userId) ?? [])].sort();

    // auction
    const buildAuctionProfile = (aSeasons: UserAuctionSeason[]): AuctionProfile | null => {
      if (!aSeasons.length) return null;
      const mix = new Map<PosGroup, number>();
      let totalSpend = 0;
      for (const s of aSeasons) {
        totalSpend += s.spend;
        for (const [pos, amt] of s.byPos) mix.set(pos, (mix.get(pos) ?? 0) + amt);
      }
      const top = (n: number) =>
        avg(aSeasons.map((s) => (s.spend ? s.amounts.sort((a, b) => b - a).slice(0, n).reduce((a, b) => a + b, 0) / s.spend : 0)));
      const maxBuy = aSeasons.reduce<AuctionProfile['maxBuy']>(
        (best, s) => (s.maxBuy && (!best || s.maxBuy.amount > best.amount) ? s.maxBuy : best),
        null,
      );
      return {
        auctions: aSeasons.length,
        avgSpend: round2(avg(aSeasons.map((s) => s.spend))),
        avgBudget: round2(avg(aSeasons.map((s) => s.budget))),
        spendMix: Object.fromEntries([...mix].map(([k, v]) => [k, round2(totalSpend ? v / totalSpend : 0)])),
        top1Share: round2(top(1)),
        top3Share: round2(top(3)),
        dollarFlyers: round2(avg(aSeasons.map((s) => s.flyers))),
        earlySpendShare: round2(avg(aSeasons.map((s) => (s.spend ? s.earlySpend / s.spend : 0)))),
        maxBuy,
      };
    };
    const auction = buildAuctionProfile(auctionByUser.get(userId) ?? []);
    const rookieAuction = buildAuctionProfile(rookieAuctionByUser.get(userId) ?? []);

    // snake
    const sSeasons = snakeByUser.get(userId) ?? [];
    let snake: SnakeProfile | null = null;
    if (sSeasons.length) {
      const firstRound: Partial<Record<PosGroup, number>> = {};
      for (const pos of ['QB', 'RB', 'WR', 'TE'] as PosGroup[]) {
        const rounds = sSeasons.map((s) => s.firstRound.get(pos)).filter((r): r is number => r !== undefined);
        if (rounds.length) firstRound[pos] = round2(avg(rounds));
      }
      const earlyMix: Partial<Record<PosGroup, number>> = {};
      const earlyTotal = sSeasons.reduce((a, s) => a + s.earlyTotal, 0);
      if (earlyTotal) {
        const byPos = new Map<PosGroup, number>();
        for (const s of sSeasons) for (const [pos, n] of s.earlyByPos) byPos.set(pos, (byPos.get(pos) ?? 0) + n);
        for (const [pos, n] of byPos) earlyMix[pos] = round2(n / earlyTotal);
      }
      snake = {
        drafts: sSeasons.length,
        firstRound,
        earlyMix,
        keeperPicks: sSeasons.reduce((a, s) => a + s.keepers, 0),
      };
    }

    // rookie
    const r = rookieByUser.get(userId);
    const rookie: RookieProfile | null = r
      ? {
          drafts: r.drafts.size,
          picks: r.picks,
          posMix: Object.fromEntries([...r.byPos].map(([k, v]) => [k, round2(r.picks ? v / r.picks : 0)])),
        }
      : null;

    // trades
    const tAgg = tradeByUser.get(userId);
    const seasonCount = Math.max(seasons.length, 1);
    const trades: TradeProfile = {
      total: tAgg?.total ?? 0,
      perSeason: round2((tAgg?.total ?? 0) / seasonCount),
      playersAcquired: tAgg?.playersAcquired ?? 0,
      playersSent: tAgg?.playersSent ?? 0,
      posNet: Object.fromEntries([...(tAgg?.posNet ?? new Map())].filter(([, v]) => v !== 0)),
      picksAcquired: tAgg?.picksAcquired ?? 0,
      picksSent: tAgg?.picksSent ?? 0,
      faabNet: tAgg?.faabNet ?? 0,
      topPartners: [...(tAgg?.partners ?? new Map<string, number>())]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([uid, count]) => ({ userId: uid, name: nameByUser.get(uid)?.displayName ?? uid, count })),
      avgWeek: tAgg?.weeks.length ? round2(avg(tAgg.weeks)) : null,
    };

    // faab
    const fAgg = faabByUser.get(userId);
    let faab: FaabProfile | null = null;
    if (fAgg) {
      const perSeason = [...fAgg.seasons.values()];
      const budgetShares = perSeason.filter((s) => s.budget > 0).map((s) => s.spend / s.budget);
      faab = {
        seasonsWithData: perSeason.length,
        winsPerSeason: round2(avg(perSeason.map((s) => s.wins))),
        spendPerSeason: round2(avg(perSeason.map((s) => s.spend))),
        budgetShare: budgetShares.length ? round2(avg(budgetShares)) : null,
        maxBid: fAgg.maxBid,
        avgBid: round2(avg(fAgg.bids)),
        addsPerSeason: round2(avg(perSeason.map((s) => s.adds))),
      };
    }

    const tags = buildTags({ auction, snake, trades, faab, isSF, isTEP });

    return {
      userId,
      displayName: names.displayName,
      teamName: names.teamName,
      isMe: userId === SLEEPER_USER_ID,
      seasons,
      auction,
      rookieAuction,
      snake,
      rookie,
      trades,
      faab,
      tags,
    };
  });

  managers.sort((a, b) => Number(b.isMe) - Number(a.isMe) || a.displayName.localeCompare(b.displayName));

  return {
    leagueId: current.leagueId,
    name: current.name,
    season: current.season,
    isSF,
    isTEP,
    chainSeasons: chain.map((l) => l.season).sort(),
    managers,
  };
}

function buildTags(args: {
  auction: AuctionProfile | null;
  snake: SnakeProfile | null;
  trades: TradeProfile;
  faab: FaabProfile | null;
  isSF: boolean;
  isTEP: boolean;
}): string[] {
  const { auction, snake, trades, faab, isSF, isTEP } = args;
  const tags: string[] = [];

  if (auction && auction.auctions > 0) {
    if (auction.top3Share >= 0.5) tags.push('stars & scrubs');
    else if (auction.top3Share <= 0.35) tags.push('spreads $');
    if (auction.dollarFlyers >= 8) tags.push('$1 scavenger');
    if (auction.earlySpendShare >= 0.55) tags.push('fast spender');
    else if (auction.earlySpendShare <= 0.25) tags.push('waits out room');
    const mixEntries = Object.entries(auction.spendMix).filter(([k]) => k !== 'K' && k !== 'DEF' && k !== '?') as Array<
      [PosGroup, number]
    >;
    const top = mixEntries.sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= 0.45) tags.push(`${top[0]}-heavy $`);
  }

  if (snake && snake.drafts > 0) {
    const rb = snake.earlyMix.RB ?? 0;
    const wr = snake.earlyMix.WR ?? 0;
    if (rb >= 0.5) tags.push('RB-early');
    if (wr >= 0.5) tags.push('WR-early');
    const qb = snake.firstRound.QB;
    if (isSF && qb !== undefined) {
      if (qb <= 2) tags.push('QB-early');
      else if (qb >= 5) tags.push('QB-late');
    }
    const te = snake.firstRound.TE;
    if (isTEP && te !== undefined && te <= 4) tags.push('TE-early');
  }

  if (trades.perSeason >= 8) tags.push('hyper-trader');
  else if (trades.perSeason >= 3) tags.push('trade-happy');
  else if (trades.total === 0) tags.push('no trades');
  const pickNet = trades.picksAcquired - trades.picksSent;
  if (pickNet >= 3) tags.push('pick hoarder');
  else if (pickNet <= -3) tags.push('pick spender');
  if (trades.total >= 5 && trades.playersAcquired <= trades.playersSent * 0.75) tags.push('consolidator');

  if (faab && faab.seasonsWithData > 0 && faab.budgetShare !== null) {
    if (faab.budgetShare >= 0.8) tags.push('FAAB whale');
    else if (faab.budgetShare <= 0.2 && faab.addsPerSeason >= 5) tags.push('FAAB miser');
  }
  if (faab && faab.addsPerSeason >= 40) tags.push('waiver churner');

  return tags;
}
