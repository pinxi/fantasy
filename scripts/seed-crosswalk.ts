import Papa from 'papaparse';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from '@/db/client';
import { IdResolver } from '@/ids/resolver';
import { fetchRaw } from '@/lib/http';

// Seed the player ID crosswalk from dynastyprocess/ffverse db_playerids.
const URL = 'https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv';

const SOURCE_COLUMNS: Array<[csvColumn: string, source: string]> = [
  ['fantasypros_id', 'fantasypros'],
  ['gsis_id', 'gsis'],
  ['mfl_id', 'mfl'],
  ['espn_id', 'espn'],
  ['yahoo_id', 'yahoo'],
  ['rotowire_id', 'rotowire'],
  ['sportradar_id', 'sportradar'],
  ['pff_id', 'pff'],
  ['ktc_id', 'ktc_numeric'],
];

async function main(): Promise<void> {
  migrate(db, { migrationsFolder: './drizzle' });
  const { text } = await fetchRaw(URL, { timeoutMs: 120_000 });
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  const ids = new IdResolver();
  const counts: Record<string, number> = {};

  for (const row of parsed.data) {
    const sleeperId = row.sleeper_id?.trim();
    if (!sleeperId) continue;
    for (const [column, source] of SOURCE_COLUMNS) {
      const value = row[column]?.trim();
      if (!value || value === 'NA') continue;
      ids.record(source, value, sleeperId, 'seed');
      counts[source] = (counts[source] ?? 0) + 1;
    }
  }

  console.log(`seeded from ${parsed.data.length} ffverse rows:`);
  for (const [source, n] of Object.entries(counts)) console.log(`  ${source.padEnd(14)} ${n}`);
}

void main();
