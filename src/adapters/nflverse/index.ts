import Papa from 'papaparse';
import { eq } from 'drizzle-orm';
import { fetchRaw } from '@/lib/http';
import { SEASON } from '@/config';
import { depthCharts, injuries, nflverseWeekly } from '@/db/schema';
import { seedCrosswalkFromFfverse } from '@/ids/seed';
import type { JobCtx, JobReport, JobSpec } from '../types';

// nflverse flat files (GitHub release CSVs) — historical/derived layer:
// weekly player stats (first downs, snaps context), depth charts (KR/PR role
// detection), injuries. No auth, no API keys, just files.

const RELEASE = 'https://github.com/nflverse/nflverse-data/releases/download';

async function fetchCsv(ctx: JobCtx, kind: string, url: string): Promise<Record<string, string>[] | null> {
  let text: string;
  let status: number;
  try {
    ({ text, status } = await fetchRaw(url, { timeoutMs: 120_000 }));
  } catch (err) {
    // Missing season files (e.g. 2026 preseason) are expected, not failures.
    if (err instanceof Error && /HTTP 404/.test(err.message)) return null;
    throw err;
  }
  ctx.raw.archive({ source: 'nflverse', kind, url, body: text, httpStatus: status });
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  return parsed.data;
}

function num(v: string | undefined): number | null {
  if (v === undefined || v === '' || v === 'NA') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function ingestWeeklySeason(ctx: JobCtx, rows: Record<string, string>[], season: number): { written: number; unresolved: number } {
  let written = 0;
  let unresolved = 0;
  ctx.db.transaction((tx) => {
    for (const row of rows) {
      const gsisId = (row.player_id ?? row.gsis_id)?.trim();
      const week = num(row.week);
      if (!gsisId || week === null) continue;
      const playerId = ctx.ids.resolve('gsis', gsisId);
      if (!playerId) unresolved++;
      const stats: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        if (['player_id', 'player_name', 'player_display_name', 'season', 'week'].includes(key)) continue;
        const n = Number(value);
        stats[key] = value === '' || value === 'NA' ? null : Number.isFinite(n) && value !== '' ? n : value;
      }
      tx.insert(nflverseWeekly)
        .values({ season, week, gsisId, playerId, stats, updatedAt: Date.now() })
        .onConflictDoUpdate({
          target: [nflverseWeekly.season, nflverseWeekly.week, nflverseWeekly.gsisId],
          set: { playerId, stats, updatedAt: Date.now() },
        })
        .run();
      written++;
    }
  });
  return { written, unresolved };
}

async function runWeekly(ctx: JobCtx, seasons: number[]): Promise<JobReport> {
  const warnings: string[] = [];
  let fetched = 0;
  let written = 0;
  for (const season of seasons) {
    // nflverse 2025+ naming: stats_player/stats_player_week_{season}.csv
    // (unified all-positions weekly file; also serves historical seasons).
    const rows = await fetchCsv(ctx, `stats_player_week_${season}`, `${RELEASE}/stats_player/stats_player_week_${season}.csv`);
    if (!rows) {
      warnings.push(`stats_player_week_${season}.csv not published yet`);
      continue;
    }
    fetched += rows.length;
    const result = ingestWeeklySeason(ctx, rows, season);
    written += result.written;
    if (result.unresolved > rows.length * 0.05) {
      warnings.push(`${season}: ${result.unresolved}/${rows.length} rows unresolved to sleeper ids`);
    }
  }
  return { fetched, written, warnings };
}

const weeklyJob: JobSpec = {
  name: 'nflverse.weekly',
  source: 'nflverse',
  cadence: { cron: '15 9 * * 2', catchUp: true, staleAfterHours: 24 * 8 },
  timeoutMs: 600_000,
  run: (ctx) => runWeekly(ctx, [SEASON]),
};

const weeklyBackfill: JobSpec = {
  name: 'nflverse.weekly_backfill',
  source: 'nflverse',
  cadence: { cron: '30 9 1 * *', catchUp: true, staleAfterHours: 24 * 30 },
  timeoutMs: 600_000,
  run: (ctx) => runWeekly(ctx, [2023, 2024, 2025]),
};

const depthChartsJob: JobSpec = {
  name: 'nflverse.depth_charts',
  source: 'nflverse',
  cadence: { cron: '20 9 * * *', catchUp: true, staleAfterHours: 30 },
  timeoutMs: 600_000,
  async run(ctx): Promise<JobReport> {
    const warnings: string[] = [];
    let fetched = 0;
    let written = 0;
    for (const season of [2025, SEASON]) {
      const rows = await fetchCsv(ctx, `depth_charts_${season}`, `${RELEASE}/depth_charts/depth_charts_${season}.csv`);
      if (!rows) {
        warnings.push(`depth_charts_${season}.csv not published yet`);
        continue;
      }
      fetched += rows.length;
      // Real columns: dt (snapshot timestamp), team, player_name, gsis_id,
      // pos_grp ("Special Teams"), pos_name ("Kick Returner"), pos_abb ("KR"),
      // pos_rank (depth). The file is a history of daily snapshots — keep only
      // the LATEST chart per season (raw archive retains full history for
      // future context modeling).
      const maxDt = rows.reduce((acc, r) => (r.dt && r.dt > acc ? r.dt : acc), '');
      const latest = rows.filter((r) => r.dt === maxDt);
      ctx.db.transaction((tx) => {
        tx.delete(depthCharts).where(eq(depthCharts.season, season)).run();
        for (const row of latest) {
          const team = (row.team ?? '').trim();
          const posAbb = (row.pos_abb ?? '').trim();
          if (!team || !posAbb) continue;
          tx.insert(depthCharts)
            .values({
              season,
              week: null,
              team,
              position: (row.pos_name ?? '').trim() || null,
              depthPosition: posAbb,
              depthRank: num(row.pos_rank),
              gsisId: (row.gsis_id ?? '').trim() || null,
              fullName: (row.player_name ?? '').trim() || null,
              updatedAt: Date.now(),
            })
            .run();
          written++;
        }
      });
    }
    return { fetched, written, warnings };
  },
};

const injuriesJob: JobSpec = {
  name: 'nflverse.injuries',
  source: 'nflverse',
  cadence: { cron: '25 9 * * *', catchUp: true, staleAfterHours: 30 },
  timeoutMs: 600_000,
  enabled: (clock) => clock.seasonType === 'regular' || clock.seasonType === 'post' || clock.seasonType === 'pre',
  async run(ctx): Promise<JobReport> {
    const warnings: string[] = [];
    let fetched = 0;
    let written = 0;
    const rows = await fetchCsv(ctx, `injuries_${SEASON}`, `${RELEASE}/injuries/injuries_${SEASON}.csv`);
    if (!rows) {
      return { fetched: 0, written: 0, warnings: [`injuries_${SEASON}.csv not published yet`] };
    }
    fetched = rows.length;
    ctx.db.transaction((tx) => {
      tx.delete(injuries).where(eq(injuries.season, SEASON)).run();
      for (const row of rows) {
        tx.insert(injuries)
          .values({
            season: SEASON,
            week: num(row.week),
            team: (row.team ?? '').trim() || null,
            gsisId: (row.gsis_id ?? '').trim() || null,
            fullName: (row.full_name ?? '').trim() || null,
            position: (row.position ?? '').trim() || null,
            reportStatus: (row.report_status ?? '').trim() || null,
            practiceStatus: (row.practice_status ?? '').trim() || null,
            dateModified: (row.date_modified ?? '').trim() || null,
            updatedAt: Date.now(),
          })
          .run();
        written++;
      }
    });
    return { fetched, written, warnings };
  },
};

const playeridsJob: JobSpec = {
  name: 'nflverse.playerids',
  source: 'nflverse',
  cadence: { cron: '35 9 * * 2', catchUp: true, staleAfterHours: 24 * 8 },
  timeoutMs: 300_000,
  async run(): Promise<JobReport> {
    const { rows, counts } = await seedCrosswalkFromFfverse();
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return { fetched: rows, written: total, warnings: [] };
  },
};

export const nflverseJobs: JobSpec[] = [weeklyJob, weeklyBackfill, depthChartsJob, injuriesJob, playeridsJob];
