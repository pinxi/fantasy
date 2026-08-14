import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { SEASON } from '@/config';

// Prediction-vs-actual scoring against the FROZEN pre-game numbers (never the
// retro-fitted latest run). Actual team totals come from Sleeper's own
// matchups.points — the same oracle the scoring engine was validated on.

export interface TeamWeekAccuracy {
  week: number;
  predicted: number;
  p10: number | null;
  p90: number | null;
  actual: number | null; // null = not played yet
  err: number | null; // actual - predicted
}

export function teamAccuracy(leagueId: string, rosterId: number): TeamWeekAccuracy[] {
  const rows = db.all<{ week: number; total: number; p10: number | null; p90: number | null; actual: number | null }>(sql`
    select f.week, f.total, f.p10, f.p90, m.points as actual
    from frozen_team_predictions f
    left join matchups m on m.league_id = f.league_id and m.week = f.week and m.roster_id = f.roster_id
    where f.league_id = ${leagueId} and f.season = ${SEASON} and f.roster_id = ${rosterId}
    order by f.week
  `);
  return rows.map((r) => {
    const played = r.actual !== null && r.actual > 0;
    return {
      week: r.week,
      predicted: r.total,
      p10: r.p10,
      p90: r.p90,
      actual: played ? r.actual : null,
      err: played ? r.actual! - r.total : null,
    };
  });
}

export interface LeagueCalibration {
  scoredWeeks: number; // team-weeks with both a freeze and an actual
  meanBias: number | null; // mean(actual - predicted): positive = we under-project
  mae: number | null;
  bandCoverage: number | null; // share of actuals inside [p10, p90] — target ~0.8
}

export function leagueCalibration(leagueId: string): LeagueCalibration {
  const rows = db.all<{ total: number; p10: number | null; p90: number | null; actual: number }>(sql`
    select f.total, f.p10, f.p90, m.points as actual
    from frozen_team_predictions f
    join matchups m on m.league_id = f.league_id and m.week = f.week and m.roster_id = f.roster_id
    where f.league_id = ${leagueId} and f.season = ${SEASON} and m.points is not null and m.points > 0
  `);
  if (rows.length === 0) return { scoredWeeks: 0, meanBias: null, mae: null, bandCoverage: null };
  const errs = rows.map((r) => r.actual - r.total);
  const withBands = rows.filter((r) => r.p10 !== null && r.p90 !== null);
  return {
    scoredWeeks: rows.length,
    meanBias: errs.reduce((a, b) => a + b, 0) / errs.length,
    mae: errs.reduce((a, b) => a + Math.abs(b), 0) / errs.length,
    bandCoverage: withBands.length > 0 ? withBands.filter((r) => r.actual >= r.p10! && r.actual <= r.p90!).length / withBands.length : null,
  };
}
