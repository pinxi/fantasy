import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import type { StatLine } from '@/scoring/engine';
import { THRESHOLD_SPECS } from './exceedance';

// Historical-comp resampling: a player-week's outcome distribution is drawn
// from real 2024-25 player-weeks at the same (position, volume bucket),
// ratio-scaled so the pool mean matches OUR grafted projection. Real games
// carry realistic variance, fat tails, and within-line correlation (yds↔TDs↔
// FDs) for free. Threshold bonus flags are RECOMPUTED from the scaled line so
// they always agree with it; stats the pool lacks (a returner's kr_yd) are
// added as constants. Samples are deterministic per (player, week) so runs
// reproduce.

export const SAMPLE_COUNT = 300;
const BUCKETS = 6;
const MIN_POOL = 40; // merge buckets until each has at least this many comps

// Keys never scaled: indicators and bookkeeping. Threshold flags are
// recomputed; distance-TD flags ride along from the comp unscaled.
const NO_SCALE_RE = /^bonus_|_40p$|_50p$|^gp$|^gs$|^gms|^pts_|^pos_rank|^adp_|^anytime|^first_td/;
const THRESHOLD_KEYS = new Set(THRESHOLD_SPECS.map((s) => s.bonusKey));

export type SparseSample = Record<string, number>;

const VOLUME_METRIC: Record<string, (s: StatLine) => number> = {
  QB: (s) => (s.pass_att ?? 0) + 2 * (s.rush_att ?? 0),
  RB: (s) => (s.rush_att ?? 0) + (s.rec_tgt ?? s.rec ?? 0),
  WR: (s) => (s.rec_tgt ?? s.rec ?? 0) + (s.rush_att ?? 0),
  TE: (s) => (s.rec_tgt ?? s.rec ?? 0),
  K: (s) => (s.fga ?? s.fgm ?? 0) + (s.xpa ?? s.xpm ?? 0),
  DEF: () => 1,
  DL: (s) => (s.idp_tkl ?? 0) + 2 * (s.idp_sack ?? 0),
  LB: (s) => s.idp_tkl ?? 0,
  DB: (s) => s.idp_tkl ?? 0,
};

interface Bucket {
  minVolume: number;
  lines: StatLine[];
  means: Map<string, number>; // per-stat mean over the bucket (continuous keys)
}

type Pool = Map<string, Bucket[]>; // pos -> volume-ascending buckets

let cachedPool: Pool | null = null;

export function buildComparablePool(): Pool {
  if (cachedPool) return cachedPool;

  const posRows = new Map(
    db
      .all<{ sleeper_id: string; pos: string | null }>(sql`select sleeper_id, pos from players`)
      .map((r) => [r.sleeper_id, r.pos]),
  );
  const rows = db.all<{ player_id: string; stats: string }>(sql`
    select player_id, stats from stat_actuals where source = 'sleeper' and season in (2024, 2025)
  `);

  const byPos = new Map<string, Array<{ volume: number; line: StatLine }>>();
  for (const row of rows) {
    const pos = posRows.get(row.player_id);
    if (!pos || !(pos in VOLUME_METRIC)) continue;
    const line = JSON.parse(row.stats) as StatLine;
    if ((line.gp ?? 1) <= 0) continue;
    const volume = VOLUME_METRIC[pos]!(line);
    if (volume <= 0) continue;
    let list = byPos.get(pos);
    if (!list) byPos.set(pos, (list = []));
    list.push({ volume, line });
  }

  const pool: Pool = new Map();
  for (const [pos, list] of byPos) {
    list.sort((a, b) => a.volume - b.volume);
    const perBucket = Math.max(Math.ceil(list.length / BUCKETS), MIN_POOL);
    const buckets: Bucket[] = [];
    for (let i = 0; i < list.length; i += perBucket) {
      const slice = list.slice(i, i + perBucket);
      if (slice.length < MIN_POOL && buckets.length > 0) {
        buckets[buckets.length - 1]!.lines.push(...slice.map((x) => x.line));
        continue;
      }
      buckets.push({ minVolume: slice[0]!.volume, lines: slice.map((x) => x.line), means: new Map() });
    }
    for (const bucket of buckets) {
      const sums = new Map<string, number>();
      for (const line of bucket.lines) {
        for (const [key, value] of Object.entries(line)) {
          if (NO_SCALE_RE.test(key)) continue;
          sums.set(key, (sums.get(key) ?? 0) + value);
        }
      }
      for (const [key, sum] of sums) bucket.means.set(key, sum / bucket.lines.length);
    }
    pool.set(pos, buckets);
  }
  cachedPool = pool;
  return pool;
}

function bucketFor(pool: Pool, pos: string, volume: number): Bucket | null {
  const buckets = pool.get(pos);
  if (!buckets || buckets.length === 0) return null;
  let chosen = buckets[0]!;
  for (const bucket of buckets) {
    if (volume >= bucket.minVolume) chosen = bucket;
  }
  return chosen;
}

// Deterministic PRNG (mulberry32) seeded from the player/week identity.
export function seededRng(seedString: string): () => number {
  let h = 1779033703;
  for (let i = 0; i < seedString.length; i++) {
    h = Math.imul(h ^ seedString.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function recomputeThresholds(sample: SparseSample): void {
  for (const spec of THRESHOLD_SPECS) {
    const value = spec.stat === 'rush_rec_yd' ? (sample.rush_yd ?? 0) + (sample.rec_yd ?? 0) : (sample[spec.stat] ?? 0);
    if (value >= spec.threshold) sample[spec.bonusKey] = 1;
    else delete sample[spec.bonusKey];
  }
}

// Generate N samples for one player-week. `projection` is the grafted mean
// line WITHOUT expected-bonus fractions (they are emergent here).
export function sampleWeek(pos: string, projection: StatLine, seed: string, n = SAMPLE_COUNT): SparseSample[] {
  const pool = buildComparablePool();
  const volume = (VOLUME_METRIC[pos] ?? (() => 1))(projection);
  const bucket = bucketFor(pool, pos, volume);
  const rng = seededRng(seed);

  // Scale factors target our projection; near-zero pool means become constants.
  const scales = new Map<string, number>();
  const constants = new Map<string, number>();
  for (const [key, mean] of Object.entries(projection)) {
    if (NO_SCALE_RE.test(key) || THRESHOLD_KEYS.has(key)) continue;
    const poolMean = bucket?.means.get(key) ?? 0;
    if (poolMean > 0.05) scales.set(key, mean / poolMean);
    else if (mean > 0) constants.set(key, mean);
  }

  const samples: SparseSample[] = [];
  for (let i = 0; i < n; i++) {
    const comp = bucket ? bucket.lines[Math.floor(rng() * bucket.lines.length)]! : {};
    const sample: SparseSample = {};
    for (const [key, scale] of scales) {
      const raw = comp[key] ?? 0;
      if (raw !== 0) sample[key] = raw * scale;
    }
    for (const [key, value] of Object.entries(comp)) {
      // Distance-TD indicators ride along unscaled (not derivable from the line).
      if (/_40p$|_50p$/.test(key) && value > 0 && !THRESHOLD_KEYS.has(key)) sample[key] = value;
    }
    for (const [key, value] of constants) sample[key] = value;
    recomputeThresholds(sample);
    samples.push(sample);
  }
  return samples;
}

// Shift sampled points so their mean equals the deterministic projection —
// quantiles then describe spread around the number the app already displays
// (keeps the M2 sum-invariant untouched). Clamped at zero.
export function recenter(samplePts: Float64Array, targetMean: number): Float64Array {
  let sum = 0;
  for (const v of samplePts) sum += v;
  const shift = samplePts.length > 0 ? targetMean - sum / samplePts.length : 0;
  const out = new Float64Array(samplePts.length);
  for (let i = 0; i < samplePts.length; i++) out[i] = Math.max(samplePts[i]! + shift, 0);
  return out;
}

export function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

// ---------- inverse-CDF resampling from persisted quantiles ----------
// Consumers (week page, team pages, freeze job, season sim) draw from the
// stored p10/p25/median/p75/p90 rather than re-running the comp-pool engine.

export interface PlayerWeekDist {
  pts: number;
  p10: number | null;
  p25: number | null;
  p75: number | null;
  p90: number | null;
}

// Piecewise-linear inverse CDF through (0.10,p10)(0.25,p25)(0.50,pts)(0.75,p75)(0.90,p90),
// with linear tail extensions, clamped at zero. Degenerates to the constant
// mean when quantiles are missing.
export function invCdfSampler(d: PlayerWeekDist): (u: number) => number {
  if (d.p10 === null || d.p25 === null || d.p75 === null || d.p90 === null) {
    return () => d.pts;
  }
  const lo = Math.max(0, d.p10 - (d.p25 - d.p10) * 1.5);
  const hi = d.p90 + (d.p90 - d.p75) * 1.5;
  const xs = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
  const ys = [lo, d.p10, d.p25, d.pts, d.p75, d.p90, hi];
  return (u: number) => {
    const x = Math.min(Math.max(u, 0), 1);
    for (let i = 1; i < xs.length; i++) {
      if (x <= xs[i]!) {
        const t = (x - xs[i - 1]!) / (xs[i]! - xs[i - 1]!);
        return Math.max(ys[i - 1]! + t * (ys[i]! - ys[i - 1]!), 0);
      }
    }
    return Math.max(hi, 0);
  };
}
