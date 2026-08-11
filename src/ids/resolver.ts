import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { playerIdMap, players } from '@/db/schema';

// Normalize a player name for matching: lowercase, strip punctuation and
// generational suffixes, collapse whitespace.
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.'’-]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class IdResolver {
  private cache = new Map<string, string | null>();

  // Resolution order: explicit map (manual beats seed) > exact normalized name.
  // Fuzzy is NEVER auto-accepted — unresolved returns null and callers record a warning.
  resolve(source: string, sourceId: string): string | null {
    const cacheKey = `${source}:${sourceId}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)!;
    const row = db
      .select({ sleeperId: playerIdMap.sleeperId })
      .from(playerIdMap)
      .where(and(eq(playerIdMap.source, source), eq(playerIdMap.sourceId, sourceId)))
      .get();
    const result = row?.sleeperId ?? null;
    this.cache.set(cacheKey, result);
    return result;
  }

  resolveByName(name: string, pos?: string): string | null {
    const search = normalizeName(name);
    const cacheKey = `name:${search}:${pos ?? ''}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)!;
    const rows = db
      .select({ sleeperId: players.sleeperId, pos: players.pos })
      .from(players)
      .where(eq(players.searchName, search))
      .all();
    const filtered = pos ? rows.filter((r) => r.pos === pos) : rows;
    // Exactly one match required — ambiguity is not a match.
    const result = filtered.length === 1 ? filtered[0]!.sleeperId : null;
    this.cache.set(cacheKey, result);
    return result;
  }

  record(source: string, sourceId: string, sleeperId: string, method: 'seed' | 'exact' | 'fuzzy' | 'manual', confidence?: number): void {
    db.insert(playerIdMap)
      .values({ source, sourceId, sleeperId, method, confidence, updatedAt: Date.now() })
      .onConflictDoUpdate({
        target: [playerIdMap.source, playerIdMap.sourceId],
        set: { sleeperId, method, confidence, updatedAt: Date.now() },
      })
      .run();
    this.cache.set(`${source}:${sourceId}`, sleeperId);
  }
}
