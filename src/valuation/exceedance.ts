import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import type { StatLine } from '@/scoring/engine';

// Empirical exceedance: P(weekly stat >= threshold | player's per-game mean),
// learned from 2024-25 actuals. Buckets are mean/threshold ratios so one table
// shape serves every threshold of a stat. This is what turns a 92-yard
// projection into ~0.4 expected 100-yard bonuses instead of 0.

export interface ThresholdSpec {
  bonusKey: string;
  stat: string; // 'rush_rec_yd' is computed as rush_yd + rec_yd when absent
  threshold: number;
}

export const THRESHOLD_SPECS: ThresholdSpec[] = [
  { bonusKey: 'bonus_rush_yd_100', stat: 'rush_yd', threshold: 100 },
  { bonusKey: 'bonus_rush_yd_200', stat: 'rush_yd', threshold: 200 },
  { bonusKey: 'bonus_rec_yd_100', stat: 'rec_yd', threshold: 100 },
  { bonusKey: 'bonus_rec_yd_200', stat: 'rec_yd', threshold: 200 },
  { bonusKey: 'bonus_pass_yd_300', stat: 'pass_yd', threshold: 300 },
  { bonusKey: 'bonus_pass_yd_400', stat: 'pass_yd', threshold: 400 },
  { bonusKey: 'bonus_rush_rec_yd_100', stat: 'rush_rec_yd', threshold: 100 },
  { bonusKey: 'bonus_rush_rec_yd_200', stat: 'rush_rec_yd', threshold: 200 },
  { bonusKey: 'bonus_rush_att_20', stat: 'rush_att', threshold: 20 },
  { bonusKey: 'bonus_pass_cmp_25', stat: 'pass_cmp', threshold: 25 },
  { bonusKey: 'bonus_tkl_10p', stat: 'idp_tkl', threshold: 10 },
  { bonusKey: 'bonus_sack_2p', stat: 'idp_sack', threshold: 2 },
];

// mean/threshold ratio bin edges (right-open); probabilities are cummax'd so
// they never decrease as the mean rises.
const RATIO_BINS = [0, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95, 1.1, 1.3, Infinity];

const TD_DISTANCE_KEYS: Array<{ distanceKey: string; baseKey: string }> = [
  { distanceKey: 'rec_td_40p', baseKey: 'rec_td' },
  { distanceKey: 'rec_td_50p', baseKey: 'rec_td' },
  { distanceKey: 'rush_td_40p', baseKey: 'rush_td' },
  { distanceKey: 'rush_td_50p', baseKey: 'rush_td' },
  { distanceKey: 'pass_td_40p', baseKey: 'pass_td' },
  { distanceKey: 'pass_td_50p', baseKey: 'pass_td' },
];

export interface FdRateTable {
  // playerId -> EB-shrunk FD-per-volume rate; pos -> league prior rate
  players: Map<string, number>;
  priors: Map<string, number>;
}

export interface GraftTables {
  // stat -> probs per ratio bin, keyed by spec bonusKey
  exceedance: Map<string, number[]>;
  // position -> distanceKey -> share of base TDs that hit the distance
  tdShares: Map<string, Map<string, number>>;
  // playerId -> shrunk expected kr_yd per active week (2025)
  krRates: Map<string, number>;
  // Sleeper's PROJECTED fd values are a yards/10 placeholder (verified: rush_fd
  // == rush_yd/10 exactly). Real FD rates are modeled from actuals instead:
  // fd per rush attempt, per reception, per completion.
  fdRates: { rush: FdRateTable; rec: FdRateTable; pass: FdRateTable };
}

function ratioBin(ratio: number): number {
  for (let i = RATIO_BINS.length - 2; i >= 0; i--) {
    if (ratio >= RATIO_BINS[i]!) return i;
  }
  return 0;
}

function statValue(stats: StatLine, stat: string): number {
  if (stat === 'rush_rec_yd') return stats.rush_rec_yd ?? (stats.rush_yd ?? 0) + (stats.rec_yd ?? 0);
  return stats[stat] ?? 0;
}

let cached: GraftTables | null = null;

export function buildGraftTables(): GraftTables {
  if (cached) return cached;

  const rows = db.all<{ season: number; player_id: string; week: number; stats: string }>(sql`
    select season, player_id, week, stats from stat_actuals where source = 'sleeper' and season in (2024, 2025)
  `);

  interface PlayerSeason {
    weeks: StatLine[];
    pos?: string;
  }
  const bySeasonPlayer = new Map<string, PlayerSeason>();
  for (const row of rows) {
    const key = `${row.season}:${row.player_id}`;
    const stats = JSON.parse(row.stats) as StatLine;
    if ((stats.gp ?? 1) <= 0) continue;
    let entry = bySeasonPlayer.get(key);
    if (!entry) bySeasonPlayer.set(key, (entry = { weeks: [] }));
    entry.weeks.push(stats);
  }

  const positions = new Map<string, string>(
    db
      .all<{ sleeper_id: string; pos: string | null }>(sql`select sleeper_id, pos from players`)
      .map((r) => [r.sleeper_id, r.pos ?? '']),
  );

  // Exceedance per spec.
  const exceedance = new Map<string, number[]>();
  for (const spec of THRESHOLD_SPECS) {
    const exceeds = new Array(RATIO_BINS.length - 1).fill(0) as number[];
    const totals = new Array(RATIO_BINS.length - 1).fill(0) as number[];
    for (const [key, ps] of bySeasonPlayer) {
      void key;
      if (ps.weeks.length < 4) continue;
      const mean = ps.weeks.reduce((acc, w) => acc + statValue(w, spec.stat), 0) / ps.weeks.length;
      if (mean <= 0) continue;
      const bin = ratioBin(mean / spec.threshold);
      for (const week of ps.weeks) {
        totals[bin]!++;
        if (statValue(week, spec.stat) >= spec.threshold) exceeds[bin]!++;
      }
    }
    const probs = totals.map((n, i) => (n > 0 ? (exceeds[i]! + 0.5) / (n + 1) : 0));
    for (let i = 1; i < probs.length; i++) probs[i] = Math.max(probs[i]!, probs[i - 1]!);
    exceedance.set(spec.bonusKey, probs);
  }

  // TD distance shares by position (league-wide ratios).
  const tdShares = new Map<string, Map<string, number>>();
  const tdAgg = new Map<string, Map<string, { distance: number; base: number }>>();
  for (const [key, ps] of bySeasonPlayer) {
    const playerId = key.split(':')[1]!;
    const pos = positions.get(playerId) ?? '';
    if (!pos) continue;
    let posAgg = tdAgg.get(pos);
    if (!posAgg) tdAgg.set(pos, (posAgg = new Map()));
    for (const { distanceKey, baseKey } of TD_DISTANCE_KEYS) {
      let agg = posAgg.get(distanceKey);
      if (!agg) posAgg.set(distanceKey, (agg = { distance: 0, base: 0 }));
      for (const week of ps.weeks) {
        agg.distance += week[distanceKey] ?? 0;
        agg.base += week[baseKey] ?? 0;
      }
    }
  }
  for (const [pos, posAgg] of tdAgg) {
    const shares = new Map<string, number>();
    for (const [distanceKey, { distance, base }] of posAgg) {
      if (base >= 20) shares.set(distanceKey, distance / base);
    }
    tdShares.set(pos, shares);
  }

  // Real FD rates from actuals, EB-shrunk toward position priors.
  const FD_SPECS = [
    { type: 'rush' as const, fdKey: 'rush_fd', volKey: 'rush_att', pseudo: 60 },
    { type: 'rec' as const, fdKey: 'rec_fd', volKey: 'rec', pseudo: 40 },
    { type: 'pass' as const, fdKey: 'pass_fd', volKey: 'pass_cmp', pseudo: 150 },
  ];
  const fdRates = { rush: emptyFdTable(), rec: emptyFdTable(), pass: emptyFdTable() };
  for (const spec of FD_SPECS) {
    const byPlayer = new Map<string, { fd: number; vol: number }>();
    const byPos = new Map<string, { fd: number; vol: number }>();
    for (const [key, ps] of bySeasonPlayer) {
      const playerId = key.split(':')[1]!;
      let playerAgg = byPlayer.get(playerId);
      if (!playerAgg) byPlayer.set(playerId, (playerAgg = { fd: 0, vol: 0 }));
      const pos = positions.get(playerId) ?? '';
      let posAgg = byPos.get(pos);
      if (!posAgg) byPos.set(pos, (posAgg = { fd: 0, vol: 0 }));
      for (const week of ps.weeks) {
        const fd = week[spec.fdKey] ?? 0;
        const vol = week[spec.volKey] ?? 0;
        playerAgg.fd += fd;
        playerAgg.vol += vol;
        posAgg.fd += fd;
        posAgg.vol += vol;
      }
    }
    const table = fdRates[spec.type];
    for (const [pos, agg] of byPos) {
      if (agg.vol >= 200) table.priors.set(pos, agg.fd / agg.vol);
    }
    for (const [playerId, agg] of byPlayer) {
      if (agg.vol <= 0) continue;
      const prior = table.priors.get(positions.get(playerId) ?? '') ?? 0;
      table.players.set(playerId, (agg.fd + spec.pseudo * prior) / (agg.vol + spec.pseudo));
    }
  }

  // KR rates from 2025: shrunk toward zero by sample size. Limitation (accepted
  // for v1): rookies and new-role returners are invisible until they show usage.
  const krRates = new Map<string, number>();
  for (const [key, ps] of bySeasonPlayer) {
    const [season, playerId] = key.split(':') as [string, string];
    if (season !== '2025') continue;
    const totalKr = ps.weeks.reduce((acc, w) => acc + (w.kr_yd ?? 0), 0);
    if (totalKr <= 0) continue;
    const n = ps.weeks.length;
    const shrunk = (totalKr / n) * (n / (n + 4));
    if (shrunk >= 3) krRates.set(playerId, shrunk);
  }

  cached = { exceedance, tdShares, krRates, fdRates };
  return cached;
}

function emptyFdTable(): FdRateTable {
  return { players: new Map(), priors: new Map() };
}

export function fdRate(table: FdRateTable, playerId: string, pos: string): number {
  return table.players.get(playerId) ?? table.priors.get(pos) ?? 0;
}

export function exceedanceProb(tables: GraftTables, spec: ThresholdSpec, projectedMean: number): number {
  if (projectedMean <= 0) return 0;
  const probs = tables.exceedance.get(spec.bonusKey);
  if (!probs) return 0;
  return probs[ratioBin(projectedMean / spec.threshold)] ?? 0;
}
