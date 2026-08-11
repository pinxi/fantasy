import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from '@/db/client';
import { getJob, listJobs, runJob } from './runner';

// CLI: `pnpm job <name>` runs one job once; `pnpm job --all` runs everything
// serially; no args lists the registry.
async function main(): Promise<void> {
  migrate(db, { migrationsFolder: './drizzle' });
  const arg = process.argv[2];

  if (!arg) {
    console.log('jobs:');
    for (const spec of listJobs()) console.log(`  ${spec.name.padEnd(34)} ${spec.cadence.cron}`);
    return;
  }

  const specs = arg === '--all' ? listJobs() : [getJob(arg) ?? fail(`unknown job: ${arg}`)];
  let failed = 0;
  for (const spec of specs) {
    const result = await runJob(spec);
    console.log(`${spec.name}: ${result.status}${result.error ? ` — ${result.error}` : ''}`);
    if (result.status === 'error') failed++;
  }
  // Explicit exit: undici's fetch keep-alive sockets can hold the event loop
  // open for up to 600s after the last request. All DB writes are synchronous.
  process.exit(failed > 0 ? 1 : 0);
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

void main();
