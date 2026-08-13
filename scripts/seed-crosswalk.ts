import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from '@/db/client';
import { seedCrosswalkFromFfverse } from '@/ids/seed';

async function main(): Promise<void> {
  migrate(db, { migrationsFolder: './drizzle' });
  const { rows, counts } = await seedCrosswalkFromFfverse();
  console.log(`seeded from ${rows} ffverse rows:`);
  for (const [source, n] of Object.entries(counts)) console.log(`  ${source.padEnd(14)} ${n}`);
}

void main();
