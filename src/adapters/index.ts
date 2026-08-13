import type { JobSpec } from './types';
import { sleeperJobs } from './sleeper';
import { sleeperStatsJobs } from './sleeper-stats';
import { fantasycalcJobs } from './fantasycalc';
import { ktcJobs } from './ktc';
import { fantasyprosJobs } from './fantasypros';
import { sleeperGqlJobs } from './sleeper-gql';
import { footballguysJobs } from './footballguys';
import { draftsharksJobs } from './draftsharks';
import { subvertadownJobs } from './subvertadown';
import { valuationJobs } from '@/valuation/job';

export const allJobs: JobSpec[] = [
  ...sleeperJobs,
  ...sleeperStatsJobs,
  ...sleeperGqlJobs,
  ...fantasycalcJobs,
  ...ktcJobs,
  ...fantasyprosJobs,
  ...footballguysJobs,
  ...draftsharksJobs,
  ...subvertadownJobs,
  ...valuationJobs,
];
