import Papa from 'papaparse';
import { IdResolver } from './resolver';
import { fetchRaw } from '@/lib/http';

// Seed/refresh the player ID crosswalk from dynastyprocess/ffverse db_playerids.
// Idempotent — used by the one-off script and the weekly nflverse.playerids job.

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

export async function seedCrosswalkFromFfverse(): Promise<{ rows: number; counts: Record<string, number> }> {
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
  return { rows: parsed.data.length, counts };
}
