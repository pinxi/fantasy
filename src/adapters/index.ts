import type { JobSpec } from './types';
import { sleeperJobs } from './sleeper';
import { sleeperStatsJobs } from './sleeper-stats';
import { fantasycalcJobs } from './fantasycalc';
import { ktcJobs } from './ktc';
import { fantasyprosJobs } from './fantasypros';
import { valuationJobs } from '@/valuation/job';

export const allJobs: JobSpec[] = [
  ...sleeperJobs,
  ...sleeperStatsJobs,
  ...fantasycalcJobs,
  ...ktcJobs,
  ...fantasyprosJobs,
  ...valuationJobs,
];
