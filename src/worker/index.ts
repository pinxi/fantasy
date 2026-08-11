import cron from 'node-cron';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from '@/db/client';
import { log } from '@/lib/log';
import { catchupSweep } from './catchup';
import { enqueue, listJobs } from './runner';

// The worker is the single migration runner (never Next.js boot).
migrate(db, { migrationsFolder: './drizzle' });
log.info('migrations applied');

for (const spec of listJobs()) {
  cron.schedule(spec.cadence.cron, () => void enqueue(spec), { timezone: 'America/New_York' });
  log.info({ job: spec.name, cron: spec.cadence.cron }, 'scheduled');
}

catchupSweep();
log.info({ jobs: listJobs().length }, 'worker up');
