import { scoreStatLine, type ScoringSettings, type StatLine } from '@/scoring/engine';
import { THRESHOLD_SPECS } from './exceedance';
import { percentile, recenter, sampleWeek, SAMPLE_COUNT, type SparseSample } from './samples';
import type { GraftedWeeks } from './compute';

// One sample generation per (player, week), scored across every league —
// samples are league-independent; only the scoring dot-product differs.
// Weekly quantiles are recentered to the deterministic weekly points; season
// quantiles come from index-aligned sample paths (week outcomes assumed
// independent; the shared index is the common-random-numbers seam Monte Carlo
// will reuse).

export interface WeeklyQuantiles {
  p10: number;
  p25: number;
  p75: number;
  p90: number;
}

export interface LeagueDistributions {
  weekly: Map<string, Map<number, WeeklyQuantiles>>; // playerId -> week -> quantiles
  season: Map<string, { p10: number; p25: number; p50: number; p75: number; p90: number }>;
}

const THRESHOLD_KEYS = new Set(THRESHOLD_SPECS.map((s) => s.bonusKey));

// Strip expected-bonus fractions the graft wrote — bonuses are emergent from
// samples (recomputed flags), so the projection fed to the sampler must not
// double-carry them.
function projectionForSampling(grafted: StatLine): StatLine {
  const out: StatLine = {};
  for (const [key, value] of Object.entries(grafted)) {
    if (THRESHOLD_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

export interface DistributionLeague {
  leagueId: string;
  scoring: ScoringSettings;
  playerIds: Set<string>; // players needing distributions in this league
}

const MIN_WEEKLY_PTS = 1.5; // skip distribution work for irrelevant weeks

export function computeAllDistributions(leagues: DistributionLeague[], graftedWeeks: GraftedWeeks): Map<string, LeagueDistributions> {
  const result = new Map<string, LeagueDistributions>();
  const seasonSamples = new Map<string, Map<string, Float64Array>>(); // leagueId -> playerId -> per-sample season totals
  for (const league of leagues) {
    result.set(league.leagueId, { weekly: new Map(), season: new Map() });
    seasonSamples.set(league.leagueId, new Map());
  }

  const union = new Set<string>();
  for (const league of leagues) for (const id of league.playerIds) union.add(id);

  for (const [week, weekMap] of graftedWeeks) {
    for (const playerId of union) {
      const entry = weekMap.get(playerId);
      if (!entry) continue;

      let samples: SparseSample[] | null = null;
      let samplePts: Float64Array | null = null;

      for (const league of leagues) {
        if (!league.playerIds.has(playerId)) continue;
        const detPts = scoreStatLine(entry.grafted, league.scoring);
        if (detPts < MIN_WEEKLY_PTS) continue;

        if (!samples) {
          samples = sampleWeek(entry.pos, projectionForSampling(entry.grafted), `${playerId}:${week}`);
          samplePts = new Float64Array(samples.length);
        }
        // Score this league: sparse dot product per sample.
        for (let i = 0; i < samples.length; i++) {
          let pts = 0;
          const sample = samples[i]!;
          for (const key in sample) {
            const weight = league.scoring[key];
            if (weight) pts += sample[key]! * weight;
          }
          samplePts![i] = pts;
        }
        const shifted = recenter(samplePts!, detPts);

        const leagueResult = result.get(league.leagueId)!;
        let playerWeekly = leagueResult.weekly.get(playerId);
        if (!playerWeekly) leagueResult.weekly.set(playerId, (playerWeekly = new Map()));
        const sorted = Float64Array.from(shifted).sort();
        playerWeekly.set(week, {
          p10: percentile(sorted, 0.1),
          p25: percentile(sorted, 0.25),
          p75: percentile(sorted, 0.75),
          p90: percentile(sorted, 0.9),
        });

        const perLeagueSeason = seasonSamples.get(league.leagueId)!;
        let acc = perLeagueSeason.get(playerId);
        if (!acc) perLeagueSeason.set(playerId, (acc = new Float64Array(SAMPLE_COUNT)));
        for (let i = 0; i < shifted.length; i++) acc[i]! += shifted[i]!;
      }
    }
  }

  for (const league of leagues) {
    const leagueResult = result.get(league.leagueId)!;
    for (const [playerId, acc] of seasonSamples.get(league.leagueId)!) {
      const sorted = Float64Array.from(acc).sort();
      leagueResult.season.set(playerId, {
        p10: percentile(sorted, 0.1),
        p25: percentile(sorted, 0.25),
        p50: percentile(sorted, 0.5),
        p75: percentile(sorted, 0.75),
        p90: percentile(sorted, 0.9),
      });
    }
  }
  return result;
}
