import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import { DATA_DIR, DB_PATH } from '@/config';
import * as schema from './schema';

// Singleton across Next.js HMR reloads; worker/mcp get one per process.
const globalForDb = globalThis as unknown as {
  __sqlite?: Database.Database;
  __drizzle?: BetterSQLite3Database<typeof schema>;
};

function open(): Database.Database {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('temp_store = MEMORY');
  return sqlite;
}

export const sqlite = globalForDb.__sqlite ?? (globalForDb.__sqlite = open());
export const db = globalForDb.__drizzle ?? (globalForDb.__drizzle = drizzle(sqlite, { schema }));
export { schema };
