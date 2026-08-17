import { sql } from 'drizzle-orm';
import { db } from '@/db/client';

export const dynamic = 'force-dynamic';

// Cheap liveness probe for Fly health checks: proves the web process is up and
// the database file is readable without competing with page-render queries.
export function GET(): Response {
  try {
    db.get(sql`select 1`);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
