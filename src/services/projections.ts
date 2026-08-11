import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import type { StatLine } from '@/scoring/engine';

// Latest snapshot per player for one (season, week) — "current belief".
export function latestWeekProjections(season: number, week: number, source = 'sleeper'): Map<string, StatLine> {
  const rows = db.all<{ player_id: string; stats: string }>(sql`
    select ps.player_id, ps.stats
    from projection_snapshots ps
    join (
      select player_id, max(id) as max_id
      from projection_snapshots
      where source = ${source} and season = ${season} and week = ${week}
      group by player_id
    ) latest on latest.max_id = ps.id
  `);
  return new Map(rows.map((r) => [r.player_id, JSON.parse(r.stats) as StatLine]));
}

// ROS stat lines = sum of latest weekly projections from fromWeek..toWeek.
// (Decision from the M1 spike: the season-aggregate endpoint is ADP-only, so
// rest-of-season is always a sum of weeks.)
export function rosStatLines(season: number, fromWeek: number, toWeek = 18, source = 'sleeper'): Map<string, StatLine> {
  const totals = new Map<string, StatLine>();
  for (let week = fromWeek; week <= toWeek; week++) {
    for (const [playerId, stats] of latestWeekProjections(season, week, source)) {
      const acc = totals.get(playerId) ?? {};
      for (const [key, value] of Object.entries(stats)) {
        acc[key] = (acc[key] ?? 0) + value;
      }
      totals.set(playerId, acc);
    }
  }
  return totals;
}
