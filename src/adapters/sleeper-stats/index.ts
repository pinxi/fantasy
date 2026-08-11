import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { fetchRaw } from '@/lib/http';
import { statsHash } from '@/lib/hash';
import { snapshotDate } from '@/lib/dates';
import { SEASON } from '@/config';
import { projectionSnapshots, statActuals } from '@/db/schema';
import type { JobCtx, JobReport, JobSpec } from '../types';

const BASE = 'https://api.sleeper.com';
const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB'];

function positionsQuery(): string {
  return POSITIONS.map((p) => `position%5B%5D=${p}`).join('&');
}

const StatRow = z
  .object({
    player_id: z.string(),
    stats: z.record(z.string(), z.number().nullable()),
  })
  .loose();

function cleanStats(stats: Record<string, number | null>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(stats)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

async function fetchStatRows(ctx: JobCtx, source: 'projections' | 'stats', season: number, week: number | null): Promise<z.infer<typeof StatRow>[]> {
  const path = week === null ? `/${source}/nfl/${season}` : `/${source}/nfl/${season}/${week}`;
  const url = `${BASE}${path}?season_type=regular&${positionsQuery()}`;
  const { status, text } = await fetchRaw(url, { timeoutMs: 60_000 });
  const rawId = ctx.raw.archive({
    source: 'sleeper_stats',
    kind: source,
    key: `${season}-${week ?? 'season'}`,
    url,
    body: text,
    httpStatus: status,
  });
  try {
    const parsed = z.array(StatRow).parse(JSON.parse(text));
    ctx.raw.setParseOk(rawId, true);
    return parsed;
  } catch (err) {
    ctx.raw.setParseOk(rawId, false);
    throw err;
  }
}

// Latest stored hash per player for (source, season, week) — sparse snapshots
// insert only when the stat line actually changed.
function latestHashes(ctx: JobCtx, season: number, week: number): Map<string, string> {
  const rows = ctx.db.all<{ player_id: string; stats_hash: string }>(sql`
    select ps.player_id, ps.stats_hash
    from projection_snapshots ps
    join (
      select player_id, max(id) as max_id
      from projection_snapshots
      where source = 'sleeper' and season = ${season} and week = ${week}
      group by player_id
    ) latest on latest.max_id = ps.id
  `);
  return new Map(rows.map((r) => [r.player_id, r.stats_hash]));
}

function ingestProjectionWeek(ctx: JobCtx, rows: z.infer<typeof StatRow>[], season: number, week: number): number {
  const existing = latestHashes(ctx, season, week);
  const date = snapshotDate();
  let written = 0;
  ctx.db.transaction((tx) => {
    for (const row of rows) {
      const stats = cleanStats(row.stats);
      if (Object.keys(stats).length === 0) continue;
      const hash = statsHash(stats);
      if (existing.get(row.player_id) === hash) continue;
      tx.insert(projectionSnapshots)
        .values({
          source: 'sleeper',
          season,
          week,
          playerId: row.player_id,
          stats,
          statsHash: hash,
          snapshotDate: date,
          capturedAt: Date.now(),
        })
        .onConflictDoUpdate({
          target: [
            projectionSnapshots.source,
            projectionSnapshots.season,
            projectionSnapshots.week,
            projectionSnapshots.playerId,
            projectionSnapshots.snapshotDate,
          ],
          set: { stats, statsHash: hash, capturedAt: Date.now() },
        })
        .run();
      written++;
    }
  });
  return written;
}

const projectionsJob: JobSpec = {
  name: 'sleeper_stats.projections',
  source: 'sleeper_stats',
  cadence: { cron: '30 6 * * *', catchUp: true, staleAfterHours: 26 },
  timeoutMs: 600_000,
  async run(ctx): Promise<JobReport> {
    const warnings: string[] = [];
    let fetched = 0;
    let written = 0;

    const startWeek = ctx.clock.seasonType === 'regular' ? ctx.clock.week : 1;
    for (let week = startWeek; week <= 18; week++) {
      const rows = await fetchStatRows(ctx, 'projections', SEASON, week);
      fetched += rows.length;
      written += ingestProjectionWeek(ctx, rows, SEASON, week);
    }

    // Season-aggregate endpoint (week 0). If Sleeper stops serving it, warn —
    // ROS then falls back to sum-of-weeks downstream.
    try {
      const seasonRows = await fetchStatRows(ctx, 'projections', SEASON, null);
      if (seasonRows.length > 0) {
        fetched += seasonRows.length;
        written += ingestProjectionWeek(ctx, seasonRows, SEASON, 0);
      } else {
        warnings.push('season-aggregate projections endpoint returned 0 rows');
      }
    } catch (err) {
      warnings.push(`season-aggregate projections unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }

    return { fetched, written, warnings };
  },
};

function ingestActualsWeek(ctx: JobCtx, rows: z.infer<typeof StatRow>[], season: number, week: number): number {
  let written = 0;
  ctx.db.transaction((tx) => {
    for (const row of rows) {
      const stats = cleanStats(row.stats);
      if (Object.keys(stats).length === 0) continue;
      tx.insert(statActuals)
        .values({ source: 'sleeper', season, week, playerId: row.player_id, stats, updatedAt: Date.now() })
        .onConflictDoUpdate({
          target: [statActuals.source, statActuals.season, statActuals.week, statActuals.playerId],
          set: { stats, updatedAt: Date.now() },
        })
        .run();
      written++;
    }
  });
  return written;
}

const actualsJob: JobSpec = {
  name: 'sleeper_stats.actuals',
  source: 'sleeper_stats',
  cadence: { cron: '0 8 * * 2,4', catchUp: true, staleAfterHours: 26 * 7 },
  timeoutMs: 600_000,
  enabled: (clock) => clock.seasonType === 'regular' || clock.seasonType === 'post',
  async run(ctx): Promise<JobReport> {
    let fetched = 0;
    let written = 0;
    for (let week = 1; week <= ctx.clock.week; week++) {
      const rows = await fetchStatRows(ctx, 'stats', SEASON, week);
      fetched += rows.length;
      written += ingestActualsWeek(ctx, rows, SEASON, week);
    }
    return { fetched, written, warnings: [] };
  },
};

// Historical actuals for the scoring-validation oracle (M2) and CV buckets /
// KR rates (M3).
const actualsBackfill: JobSpec = {
  name: 'sleeper_stats.actuals_backfill',
  source: 'sleeper_stats',
  cadence: { cron: '0 9 1 * *', catchUp: true, staleAfterHours: 24 * 30 },
  timeoutMs: 600_000,
  async run(ctx): Promise<JobReport> {
    let fetched = 0;
    let written = 0;
    const warnings: string[] = [];
    for (const season of [2024, 2025]) {
      for (let week = 1; week <= 18; week++) {
        try {
          const rows = await fetchStatRows(ctx, 'stats', season, week);
          fetched += rows.length;
          written += ingestActualsWeek(ctx, rows, season, week);
        } catch (err) {
          warnings.push(`actuals ${season} w${week}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return { fetched, written, warnings };
  },
};

export const sleeperStatsJobs: JobSpec[] = [projectionsJob, actualsJob, actualsBackfill];
