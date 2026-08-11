import { z } from 'zod';
import { env, SEASON } from '@/config';
import { fetchRaw } from '@/lib/http';
import { snapshotDate } from '@/lib/dates';
import { rankingSnapshots } from '@/db/schema';
import type { JobCtx, JobReport, JobSpec } from '../types';

const Player = z
  .object({
    player_id: z.union([z.string(), z.number()]),
    player_name: z.string(),
    player_positions: z.union([z.string(), z.array(z.string())]).nullish(),
    rank_ecr: z.number().nullish(),
    rank_ave: z.union([z.string(), z.number()]).nullish(),
    rank_min: z.union([z.string(), z.number()]).nullish(),
    rank_max: z.union([z.string(), z.number()]).nullish(),
    rank_std: z.union([z.string(), z.number()]).nullish(),
  })
  .loose();

const Response = z.object({ players: z.array(Player) }).loose();

const PROFILES: Array<{ profile: string; params: string }> = [
  { profile: 'draft_ppr', params: `type=draft&scoring=PPR&position=ALL&week=0` },
  { profile: 'draft_half', params: `type=draft&scoring=HALF&position=ALL&week=0` },
  { profile: 'draft_superflex', params: `type=draft&scoring=PPR&position=OP&week=0` },
];

function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

const rankingsJob: JobSpec = {
  name: 'fantasypros.rankings',
  source: 'fantasypros',
  cadence: { cron: '45 6 * * *', catchUp: true, staleAfterHours: 30 },
  timeoutMs: 300_000,
  async run(ctx): Promise<JobReport> {
    if (!env.FANTASYPROS_API_KEY) {
      return { fetched: 0, written: 0, warnings: ['FANTASYPROS_API_KEY not set — job skipped'] };
    }
    const warnings: string[] = [];
    let fetched = 0;
    let written = 0;
    const date = snapshotDate();

    for (const { profile, params } of PROFILES) {
      const url = `https://api.fantasypros.com/public/v2/json/nfl/${SEASON}/consensus-rankings?${params}`;
      let text: string;
      let status: number;
      try {
        ({ text, status } = await fetchRaw(url, {
          headers: { 'x-api-key': env.FANTASYPROS_API_KEY },
          timeoutMs: 60_000,
        }));
      } catch (err) {
        warnings.push(`${profile}: request failed — ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const rawId = ctx.raw.archive({ source: 'fantasypros', kind: 'consensus', key: profile, url, body: text, httpStatus: status });

      let players: z.infer<typeof Player>[];
      try {
        players = Response.parse(JSON.parse(text)).players;
        ctx.raw.setParseOk(rawId, true);
      } catch (err) {
        ctx.raw.setParseOk(rawId, false);
        warnings.push(`${profile}: parse failed — ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      fetched += players.length;

      let unresolved = 0;
      ctx.db.transaction((tx) => {
        for (const p of players) {
          const fpId = String(p.player_id);
          const positions = Array.isArray(p.player_positions) ? p.player_positions : (p.player_positions ?? '').split(',');
          const pos = positions[0]?.trim() || undefined;
          const sleeperId = ctx.ids.resolve('fantasypros', fpId) ?? ctx.ids.resolveByName(p.player_name, pos);
          if (!sleeperId) {
            unresolved++;
            continue;
          }
          ctx.ids.record('fantasypros', fpId, sleeperId, 'exact');
          const rank = p.rank_ecr ?? num(p.rank_ave);
          if (rank === null) continue;
          tx.insert(rankingSnapshots)
            .values({
              source: 'fantasypros',
              profile,
              expert: 'consensus',
              playerId: sleeperId,
              rank,
              rankMin: num(p.rank_min) === null ? null : Math.round(num(p.rank_min)!),
              rankMax: num(p.rank_max) === null ? null : Math.round(num(p.rank_max)!),
              stdev: num(p.rank_std),
              adp: null,
              snapshotDate: date,
              capturedAt: Date.now(),
            })
            .onConflictDoUpdate({
              target: [
                rankingSnapshots.source,
                rankingSnapshots.profile,
                rankingSnapshots.expert,
                rankingSnapshots.playerId,
                rankingSnapshots.snapshotDate,
              ],
              set: { rank, capturedAt: Date.now() },
            })
            .run();
          written++;
        }
      });
      if (unresolved > 0) warnings.push(`${profile}: ${unresolved} unresolved players skipped`);
    }
    return { fetched, written, warnings };
  },
};

export const fantasyprosJobs: JobSpec[] = [rankingsJob];
