import type { JobReport, JobSpec } from '@/adapters/types';
import { runAllValuations } from './compute';

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

export const valuationJobs: JobSpec[] = [nightlyJob];
