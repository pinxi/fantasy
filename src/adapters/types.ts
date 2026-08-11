import type { Logger } from 'pino';
import type { db } from '@/db/client';
import type { NflClock } from '@/lib/nfl-clock';
import type { RawStore } from './raw-store';
import type { IdResolver } from '@/ids/resolver';

export type SourceName =
  | 'sleeper'
  | 'sleeper_stats'
  | 'sleeper_gql'
  | 'fantasycalc'
  | 'ktc'
  | 'fantasypros'
  | 'nflverse'
  | 'valuation';

export interface JobCtx {
  db: typeof db;
  raw: RawStore;
  ids: IdResolver;
  clock: NflClock;
  log: Logger;
}

export interface JobReport {
  fetched: number;
  written: number;
  warnings: string[];
}

export interface JobSpec {
  name: string; // "sleeper.players_dump"
  source: SourceName;
  cadence: {
    cron: string;
    catchUp: boolean;
    staleAfterHours: number;
  };
  timeoutMs?: number;
  enabled?: (clock: NflClock) => boolean;
  run: (ctx: JobCtx) => Promise<JobReport>;
}
