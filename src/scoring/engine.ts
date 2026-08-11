// Sleeper's stat feeds already contain every derived stat (bonus_* achievement
// flags, position-conditional receptions like bonus_rec_te, first downs, return
// yards), so league scoring is a pure dot product: sum(stats[key] * weight).
// Reproducing Sleeper's official numbers exactly is validated by
// scripts/validate-scoring.ts against real 2025 matchup results.

export type StatLine = Record<string, number>;
export type ScoringSettings = Record<string, number>;

export function scoreStatLine(stats: StatLine, scoring: ScoringSettings): number {
  let points = 0;
  for (const key in scoring) {
    const weight = scoring[key];
    if (!weight) continue;
    const value = stats[key];
    if (value) points += value * weight;
  }
  return points;
}

// Per-key contributions — powers the "hidden points" breakdown in the UI.
export function scoreBreakdown(stats: StatLine, scoring: ScoringSettings): Record<string, number> {
  const breakdown: Record<string, number> = {};
  for (const key in scoring) {
    const weight = scoring[key];
    if (!weight) continue;
    const value = stats[key];
    if (value) breakdown[key] = value * weight;
  }
  return breakdown;
}

// Group a breakdown into the component buckets stored on league_values.
const FD_KEYS = /^(rush|rec|pass)_fd$/;
const RETURN_KEYS = /^(kr|pr)(_yd|_td)?$|^st_/;
const BONUS_KEYS = /^bonus_/;
const IDP_KEYS = /^(idp_|tkl|sack|ff$|int$|pass_def|qb_hit|blk_kick|safe)/;
const DEF_KEYS = /^(def_|pts_allow|yds_allow|fum_rec$)/;

export function componentBuckets(breakdown: Record<string, number>): Record<string, number> {
  const buckets: Record<string, number> = { base: 0, fd: 0, kr_pr: 0, bonus: 0, idp: 0, def: 0 };
  for (const [key, points] of Object.entries(breakdown)) {
    if (FD_KEYS.test(key)) buckets.fd! += points;
    else if (BONUS_KEYS.test(key)) buckets.bonus! += points;
    else if (RETURN_KEYS.test(key)) buckets.kr_pr! += points;
    else if (IDP_KEYS.test(key)) buckets.idp! += points;
    else if (DEF_KEYS.test(key)) buckets.def! += points;
    else buckets.base! += points;
  }
  return buckets;
}
