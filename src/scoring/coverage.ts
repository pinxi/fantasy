import { sql } from 'drizzle-orm';
import { db } from '@/db/client';

// Distinct stat keys observed in a feed — the vocabulary a league's scoring
// keys are checked against.
export function actualsVocabulary(season: number): Set<string> {
  const rows = db.all<{ key: string }>(sql`
    select distinct je.key as key
    from stat_actuals, json_each(stat_actuals.stats) je
    where season = ${season}
  `);
  return new Set(rows.map((r) => r.key));
}

export function projectionsVocabulary(season: number): Set<string> {
  const rows = db.all<{ key: string }>(sql`
    select distinct je.key as key
    from projection_snapshots, json_each(projection_snapshots.stats) je
    where season = ${season} and week > 0
  `);
  return new Set(rows.map((r) => r.key));
}

export interface LeagueCoverage {
  leagueId: string;
  name: string;
  activeKeys: number;
  // Scoring keys with nonzero weight that never appear in actuals — these would
  // silently score zero. Must be surfaced, never hidden.
  unscoreable: string[];
  // Keys that DO appear in actuals but never in projections — the projection
  // blind spots the valuation layer must graft (KR yards, threshold bonuses…).
  projectionBlind: string[];
}

export function leagueCoverage(
  league: { leagueId: string; name: string; scoringSettings: Record<string, number> },
  actualsVocab: Set<string>,
  projectionVocab: Set<string>,
): LeagueCoverage {
  const active = Object.entries(league.scoringSettings)
    .filter(([, weight]) => weight !== 0)
    .map(([key]) => key);
  const unscoreable = active.filter((key) => !actualsVocab.has(key)).sort();
  const projectionBlind = active
    .filter((key) => actualsVocab.has(key) && !projectionVocab.has(key))
    .sort();
  return { leagueId: league.leagueId, name: league.name, activeKeys: active.length, unscoreable, projectionBlind };
}
