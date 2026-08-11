import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db, sqlite } from './client';

migrate(db, { migrationsFolder: './drizzle' });
console.log('migrations applied:', sqlite.prepare('select count(*) as n from sqlite_master where type = ?').get('table'));
