import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { unmatchedAssets } from '@/db/schema';

// Draft-relevant assets that failed ID resolution get recorded by NAME so the
// /crosswalk page can offer one-click manual mappings — never silent skips.

export function recordUnmatched(source: string, sourceKey: string, name: string, pos?: string | null, context?: string): void {
  db.insert(unmatchedAssets)
    .values({ source, sourceKey, name, pos: pos ?? null, context: context ?? null, lastSeenAt: Date.now() })
    .onConflictDoUpdate({
      target: [unmatchedAssets.source, unmatchedAssets.sourceKey],
      set: { name, pos: pos ?? null, context: context ?? null, lastSeenAt: Date.now() },
    })
    .run();
}

export function clearUnmatched(source: string, sourceKey: string): void {
  db.delete(unmatchedAssets)
    .where(and(eq(unmatchedAssets.source, source), eq(unmatchedAssets.sourceKey, sourceKey)))
    .run();
}
