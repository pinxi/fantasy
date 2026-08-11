import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from '@/db/client';
import { scoreBreakdown, scoreStatLine, type StatLine } from '@/scoring/engine';
import { actualsVocabulary, leagueCoverage, projectionsVocabulary } from '@/scoring/coverage';
import { SEASON } from '@/config';

// The oracle: Sleeper's official players_points from real 2025 matchups.
// The engine must reproduce them within ±0.011 (Sleeper rounds to 2dp).

const TOLERANCE = 0.011;
const ORACLE_SEASON = 2025;

interface Mismatch {
  league: string;
  week: number;
  playerId: string;
  official: number;
  computed: number;
  diff: number;
}

function loadActuals(season: number): Map<string, StatLine> {
  const rows = db.all<{ week: number; player_id: string; stats: string }>(sql`
    select week, player_id, stats from stat_actuals where source = 'sleeper' and season = ${season}
  `);
  const map = new Map<string, StatLine>();
  for (const row of rows) map.set(`${row.week}:${row.player_id}`, JSON.parse(row.stats) as StatLine);
  return map;
}

function main(): void {
  migrate(db, { migrationsFolder: './drizzle' });
  const actuals = loadActuals(ORACLE_SEASON);

  const oracleLeagues = db.all<{ league_id: string; name: string; scoring_settings: string }>(sql`
    select distinct l.league_id, l.name, l.scoring_settings
    from leagues l
    join matchups m on m.league_id = l.league_id
    where l.season = ${ORACLE_SEASON}
  `);

  const matchupRows = db.all<{ league_id: string; week: number; players_points: string | null }>(sql`
    select m.league_id, m.week, m.players_points
    from matchups m
    join leagues l on l.league_id = m.league_id
    where l.season = ${ORACLE_SEASON} and m.players_points is not null
  `);

  let total = 0;
  let failed = 0;
  const mismatches: Mismatch[] = [];
  const perLeague = new Map<string, { name: string; total: number; failed: number }>();

  const scoringByLeague = new Map(oracleLeagues.map((l) => [l.league_id, JSON.parse(l.scoring_settings) as Record<string, number>]));
  for (const l of oracleLeagues) perLeague.set(l.league_id, { name: l.name, total: 0, failed: 0 });

  for (const row of matchupRows) {
    const scoring = scoringByLeague.get(row.league_id);
    const bucket = perLeague.get(row.league_id);
    if (!scoring || !bucket || !row.players_points) continue;
    const playersPoints = JSON.parse(row.players_points) as Record<string, number>;
    for (const [playerId, official] of Object.entries(playersPoints)) {
      const stats = actuals.get(`${row.week}:${playerId}`) ?? {};
      const computed = scoreStatLine(stats, scoring);
      total++;
      bucket.total++;
      if (Math.abs(computed - official) > TOLERANCE) {
        failed++;
        bucket.failed++;
        mismatches.push({ league: bucket.name, week: row.week, playerId, official, computed, diff: Math.abs(computed - official) });
      }
    }
  }

  console.log('== scoring validation vs 2025 oracle ==\n');
  for (const { name, total: t, failed: f } of perLeague.values()) {
    const pct = t === 0 ? 100 : ((t - f) / t) * 100;
    console.log(`  ${name.padEnd(42)} ${String(t).padStart(6)} player-weeks   ${pct.toFixed(3)}% match${f > 0 ? `   (${f} mismatches)` : ''}`);
  }
  const passRate = total === 0 ? 0 : ((total - failed) / total) * 100;
  console.log(`\n  OVERALL: ${total} player-weeks, ${failed} mismatches — ${passRate.toFixed(4)}% match (requirement: ≥99.9%)\n`);

  if (mismatches.length > 0) {
    console.log('== worst mismatches ==');
    mismatches.sort((a, b) => b.diff - a.diff);
    for (const m of mismatches.slice(0, 10)) {
      console.log(`  ${m.league} w${m.week} player ${m.playerId}: official ${m.official} vs computed ${m.computed.toFixed(3)} (Δ${m.diff.toFixed(3)})`);
      const stats = actuals.get(`${m.week}:${m.playerId}`);
      const scoring = [...scoringByLeague.entries()].find(([id]) => perLeague.get(id)?.name === m.league)?.[1];
      if (stats && scoring) {
        const breakdown = scoreBreakdown(stats, scoring);
        const top = Object.entries(breakdown)
          .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a))
          .slice(0, 6)
          .map(([k, v]) => `${k}=${v.toFixed(2)}`)
          .join(' ');
        console.log(`      breakdown: ${top || '(no scoring stats present)'}`);
      }
    }
    console.log();
  }

  console.log('== coverage report (2026 leagues) ==\n');
  const actualsVocab = actualsVocabulary(ORACLE_SEASON);
  const projVocab = projectionsVocabulary(SEASON);
  const currentLeagues = db.all<{ league_id: string; name: string; scoring_settings: string }>(sql`
    select league_id, name, scoring_settings from leagues where season = ${SEASON}
  `);
  for (const l of currentLeagues) {
    const cov = leagueCoverage(
      { leagueId: l.league_id, name: l.name, scoringSettings: JSON.parse(l.scoring_settings) as Record<string, number> },
      actualsVocab,
      projVocab,
    );
    console.log(`  ${cov.name} (${cov.activeKeys} active keys)`);
    console.log(`    unscoreable (absent from actuals): ${cov.unscoreable.length > 0 ? cov.unscoreable.join(', ') : '— none'}`);
    console.log(`    projection-blind (graft targets):  ${cov.projectionBlind.length > 0 ? cov.projectionBlind.join(', ') : '— none'}`);
  }

  if (passRate < 99.9) {
    console.error(`\nFAIL: pass rate ${passRate.toFixed(4)}% below 99.9% requirement`);
    process.exitCode = 1;
  } else {
    console.log(`\nPASS`);
  }
}

main();
