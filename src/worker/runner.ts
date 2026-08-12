import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { jobRuns, sourceHealth } from '@/db/schema';
import { log as rootLog } from '@/lib/log';
import { getNflClock } from '@/lib/nfl-clock';
import { RawStore } from '@/adapters/raw-store';
import { IdResolver } from '@/ids/resolver';
import type { JobReport, JobSpec } from '@/adapters/types';
import { allJobs } from '@/adapters';

const DEFAULT_TIMEOUT_MS = 180_000;

const raw = new RawStore();

export function getJob(name: string): JobSpec | undefined {
  return allJobs.find((j) => j.name === name);
}

export function listJobs(): JobSpec[] {
  return allJobs;
}

export async function runJob(spec: JobSpec): Promise<{ status: 'ok' | 'error' | 'partial'; report?: JobReport; error?: string }> {
  const log = rootLog.child({ job: spec.name });
  const startedAt = Date.now();
  const runRow = db
    .insert(jobRuns)
    .values({ jobName: spec.name, source: spec.source, startedAt, status: 'running' })
    .returning({ id: jobRuns.id })
    .all()[0]!;

  try {
    const clock = await getNflClock();
    if (spec.enabled && !spec.enabled(clock)) {
      db.update(jobRuns)
        .set({ finishedAt: Date.now(), status: 'ok', items: 0, warnings: ['skipped: not enabled for current nfl state'] })
        .where(eq(jobRuns.id, runRow.id))
        .run();
      log.info('skipped (not enabled for current NFL state)');
      return { status: 'ok', report: { fetched: 0, written: 0, warnings: [] } };
    }

    const ctx = { db, raw, ids: new IdResolver(), clock, log };
    const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const report = await Promise.race([
      spec.run(ctx),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`job timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);

    const status = report.warnings.length > 0 ? 'partial' : 'ok';
    db.update(jobRuns)
      .set({ finishedAt: Date.now(), status, items: report.written, warnings: report.warnings })
      .where(eq(jobRuns.id, runRow.id))
      .run();
    recordHealth(spec, true, report.warnings[0]);
    log.info({ fetched: report.fetched, written: report.written, warnings: report.warnings.length }, 'done');
    return { status, report };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.update(jobRuns).set({ finishedAt: Date.now(), status: 'error', error: message }).where(eq(jobRuns.id, runRow.id)).run();
    recordHealth(spec, false, message);
    log.error({ err: message }, 'failed');
    return { status: 'error', error: message };
  }
}

function recordHealth(spec: JobSpec, ok: boolean, message?: string): void {
  const now = Date.now();
  const existing = db.select().from(sourceHealth).where(eq(sourceHealth.source, spec.source)).get();
  if (!existing) {
    db.insert(sourceHealth)
      .values({
        source: spec.source,
        lastSuccessAt: ok ? now : null,
        lastErrorAt: ok ? null : now,
        consecutiveFailures: ok ? 0 : 1,
        staleAfterHours: spec.cadence.staleAfterHours,
        message,
      })
      .run();
    return;
  }
  db.update(sourceHealth)
    .set(
      ok
        ? { lastSuccessAt: now, consecutiveFailures: 0, staleAfterHours: spec.cadence.staleAfterHours, message: message ?? null }
        : { lastErrorAt: now, consecutiveFailures: existing.consecutiveFailures + 1, message: message ?? null },
    )
    .where(eq(sourceHealth.source, spec.source))
    .run();
}

// Serial queue — jobs never run concurrently (single SQLite writer, simple to debug).
let chain: Promise<unknown> = Promise.resolve();
const queued = new Set<string>();

export function enqueue(spec: JobSpec): Promise<unknown> {
  if (queued.has(spec.name)) return chain;
  queued.add(spec.name);
  chain = chain.then(async () => {
    queued.delete(spec.name);
    await runJob(spec);
  });
  return chain;
}
