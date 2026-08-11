import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { jobRuns } from '@/db/schema';
import { log } from '@/lib/log';
import { enqueue, listJobs } from './runner';

// Anacron semantics: on worker start, any catch-up job with no successful run
// inside its staleness window runs immediately. This is what saves the archive
// after laptop sleep — snapshot history cannot be backfilled.
export function catchupSweep(): void {
  for (const spec of listJobs()) {
    if (!spec.cadence.catchUp) continue;
    const last = db
      .select({ startedAt: jobRuns.startedAt })
      .from(jobRuns)
      .where(and(eq(jobRuns.jobName, spec.name), inArray(jobRuns.status, ['ok', 'partial'])))
      .orderBy(desc(jobRuns.startedAt))
      .limit(1)
      .get();
    const staleMs = spec.cadence.staleAfterHours * 3600 * 1000;
    if (!last || Date.now() - last.startedAt > staleMs) {
      log.info({ job: spec.name, lastSuccess: last?.startedAt ?? null }, 'catch-up: enqueueing');
      void enqueue(spec);
    }
  }
}
