import type { StatLine } from '@/scoring/engine';
import { buildGraftTables, exceedanceProb, fdRate, THRESHOLD_SPECS, type GraftTables } from './exceedance';

// Graft projection-blind stats into a weekly line as fractional expected
// values. Only keys ABSENT from the projection are written — Sleeper's own
// numbers are never overwritten. The scorer then prices everything uniformly.

const TD_SHARE_KEYS: Array<{ distanceKey: string; baseKey: string }> = [
  { distanceKey: 'rec_td_40p', baseKey: 'rec_td' },
  { distanceKey: 'rec_td_50p', baseKey: 'rec_td' },
  { distanceKey: 'rush_td_40p', baseKey: 'rush_td' },
  { distanceKey: 'rush_td_50p', baseKey: 'rush_td' },
  { distanceKey: 'pass_td_40p', baseKey: 'pass_td' },
  { distanceKey: 'pass_td_50p', baseKey: 'pass_td' },
];

export interface GraftResult {
  grafted: StatLine;
  addedBonusKeys: string[];
  addedKrKeys: string[];
}

export function graftWeeklyLine(playerId: string, pos: string, stats: StatLine, tables: GraftTables): GraftResult {
  const grafted: StatLine = { ...stats };
  const addedBonusKeys: string[] = [];
  const addedKrKeys: string[] = [];

  // OVERRIDE Sleeper's placeholder FDs (== yards/10) with modeled rates:
  // real FD-per-volume from 2024-25 actuals, EB-shrunk to position priors.
  if ((stats.rush_att ?? 0) > 0) grafted.rush_fd = fdRate(tables.fdRates.rush, playerId, pos) * stats.rush_att!;
  else delete grafted.rush_fd;
  if ((stats.rec ?? 0) > 0) grafted.rec_fd = fdRate(tables.fdRates.rec, playerId, pos) * stats.rec!;
  else delete grafted.rec_fd;
  if ((stats.pass_cmp ?? 0) > 0) grafted.pass_fd = fdRate(tables.fdRates.pass, playerId, pos) * stats.pass_cmp!;
  else delete grafted.pass_fd;

  for (const spec of THRESHOLD_SPECS) {
    if (grafted[spec.bonusKey] !== undefined) continue;
    const mean = spec.stat === 'rush_rec_yd' ? (stats.rush_yd ?? 0) + (stats.rec_yd ?? 0) : (stats[spec.stat] ?? 0);
    if (mean <= 0) continue;
    const prob = exceedanceProb(tables, spec, mean);
    if (prob > 0.005) {
      grafted[spec.bonusKey] = prob;
      addedBonusKeys.push(spec.bonusKey);
    }
  }

  for (const { distanceKey, baseKey } of TD_SHARE_KEYS) {
    if (grafted[distanceKey] !== undefined) continue;
    const base = stats[baseKey] ?? 0;
    if (base <= 0) continue;
    const share = tables.tdShares.get(pos)?.get(distanceKey);
    if (share && share > 0) {
      grafted[distanceKey] = base * share;
      addedBonusKeys.push(distanceKey);
    }
  }

  // Kick-return yards: unprojected by everyone. Applied only on weeks the
  // player is projected to play.
  if (grafted.kr_yd === undefined) {
    const rate = tables.krRates.get(playerId);
    const active = (stats.gp ?? 0) > 0.25 || Object.keys(stats).length > 3;
    if (rate && active) {
      grafted.kr_yd = rate * Math.min(stats.gp ?? 1, 1);
      addedKrKeys.push('kr_yd');
    }
  }

  return { grafted, addedBonusKeys, addedKrKeys };
}

export function graftTables(): GraftTables {
  return buildGraftTables();
}
