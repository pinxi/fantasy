import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { unmatchedAssets } from '@/db/schema';

// Draft-relevant assets that failed ID resolution get recorded by NAME so the
// /crosswalk page can offer one-click manual mappings — never silent skips.

// Returns true when the asset is ignored (sticky dismissal) — callers skip the
// warning count for ignored assets.
export function recordUnmatched(source: string, sourceKey: string, name: string, pos?: string | null, context?: string): boolean {
  db.insert(unmatchedAssets)
    .values({ source, sourceKey, name, pos: pos ?? null, context: context ?? null, lastSeenAt: Date.now() })
    .onConflictDoUpdate({
      target: [unmatchedAssets.source, unmatchedAssets.sourceKey],
      set: { name, pos: pos ?? null, context: context ?? null, lastSeenAt: Date.now() },
    })
    .run();
  const row = db
    .select({ ignored: unmatchedAssets.ignored })
    .from(unmatchedAssets)
    .where(and(eq(unmatchedAssets.source, source), eq(unmatchedAssets.sourceKey, sourceKey)))
    .get();
  return row?.ignored ?? false;
}

export function clearUnmatched(source: string, sourceKey: string): void {
  db.delete(unmatchedAssets)
    .where(and(eq(unmatchedAssets.source, source), eq(unmatchedAssets.sourceKey, sourceKey)))
    .run();
}

export function ignoreUnmatched(source: string, sourceKey: string): void {
  db.update(unmatchedAssets)
    .set({ ignored: true })
    .where(and(eq(unmatchedAssets.source, source), eq(unmatchedAssets.sourceKey, sourceKey)))
    .run();
}
