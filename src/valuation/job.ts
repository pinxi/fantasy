import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { SEASON } from '@/config';
import { computeSeasonOdds } from '@/services/odds';
import type { JobReport, JobSpec } from '@/adapters/types';
import { runAllValuations } from './compute';
import { freezeAllLeagues } from './freeze';

// Nightly re-valuation after the morning ingestion sweep.
const nightlyJob: JobSpec = {
  name: 'valuation.nightly',
  source: 'valuation',
  cadence: { cron: '55 6 * * *', catchUp: true, staleAfterHours: 26 },
  timeoutMs: 600_000,
  async run(ctx): Promise<JobReport> {
    const summaries = runAllValuations();
    for (const s of summaries) {
      ctx.log.info({ league: s.league, players: s.players, format: s.format, runId: s.runId }, 'valued');
    }
    return { fetched: summaries.length, written: summaries.reduce((n, s) => n + s.players, 0), warnings: [] };
  },
};

// Thursday-morning freeze: lock the week's prediction of record before any
// games kick off. First freeze wins (re-runs skip); catch-up covers a slept
// Thursday, at the cost of a later — timestamped — freeze.
const freezeJob: JobSpec = {
  name: 'valuation.freeze_week',
  source: 'valuation',
  cadence: { cron: '0 9 * * 4', catchUp: true, staleAfterHours: 24 * 8 },
  enabled: (clock) => clock.seasonType === 'regular',
  timeoutMs: 300_000,
  async run(ctx): Promise<JobReport> {
    const results = freezeAllLeagues(ctx.clock.week);
    const warnings: string[] = [];
    let written = 0;
    for (const r of results) {
      if (r.skipped) continue;
      written += r.players + r.teams;
      ctx.log.info({ league: r.leagueId, players: r.players, teams: r.teams }, 'frozen');
    }
    if (results.every((r) => r.skipped)) warnings.push(`week ${ctx.clock.week}: nothing to freeze (already frozen or no weekly rows)`);
    return { fetched: results.length, written, warnings };
  },
};

// Season-sim odds after the nightly revalue (serial queue means this waits for
// the nightly to finish). Web requests read the persisted result — the sim is
// too heavy for a shared vCPU at request time.
const oddsJob: JobSpec = {
  name: 'valuation.odds',
  source: 'valuation',
  cadence: { cron: '10 7 * * *', catchUp: true, staleAfterHours: 26 },
  timeoutMs: 600_000,
  async run(ctx): Promise<JobReport> {
    const leagues = db.all<{ league_id: string }>(sql`select league_id from leagues where season = ${SEASON}`);
    const warnings: string[] = [];
    let written = 0;
    for (const l of leagues) {
      const result = await computeSeasonOdds(l.league_id, { persist: true });
      if ('error' in result) {
        warnings.push(result.error);
      } else {
        written++;
        ctx.log.info({ league: result.league, teams: result.teams.length }, 'odds cached');
      }
    }
    return { fetched: leagues.length, written, warnings };
  },
};

export const valuationJobs: JobSpec[] = [nightlyJob, freezeJob, oddsJob];
