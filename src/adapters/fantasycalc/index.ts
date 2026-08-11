import { z } from 'zod';
import { fetchRaw } from '@/lib/http';
import { snapshotDate } from '@/lib/dates';
import { marketValueSnapshots } from '@/db/schema';
import type { JobCtx, JobReport, JobSpec } from '../types';

const Item = z
  .object({
    player: z
      .object({
        name: z.string(),
        sleeperId: z.string().nullish(),
        mflId: z.union([z.string(), z.number()]).nullish(),
        position: z.string().nullish(),
      })
      .loose(),
    value: z.number(),
    overallRank: z.number().nullish(),
    positionRank: z.number().nullish(),
    trend30Day: z.number().nullish(),
  })
  .loose();

const CONFIGS: Array<{ format: string; params: string }> = [
  { format: 'dynasty_sf', params: 'isDynasty=true&numQbs=2&numTeams=12&ppr=1' },
  { format: 'dynasty_1qb', params: 'isDynasty=true&numQbs=1&numTeams=12&ppr=1' },
  { format: 'redraft_sf', params: 'isDynasty=false&numQbs=2&numTeams=12&ppr=1' },
  { format: 'redraft_1qb', params: 'isDynasty=false&numQbs=1&numTeams=12&ppr=1' },
];

const PICK_RE = /\b(pick|1st|2nd|3rd|4th|round)\b/i;

const valuesJob: JobSpec = {
  name: 'fantasycalc.values',
  source: 'fantasycalc',
  cadence: { cron: '40 6 * * *', catchUp: true, staleAfterHours: 26 },
  timeoutMs: 300_000,
  async run(ctx): Promise<JobReport> {
    const warnings: string[] = [];
    let fetched = 0;
    let written = 0;
    const date = snapshotDate();

    for (const config of CONFIGS) {
      const url = `https://api.fantasycalc.com/values/current?${config.params}`;
      const { status, text } = await fetchRaw(url, { timeoutMs: 60_000 });
      const rawId = ctx.raw.archive({ source: 'fantasycalc', kind: 'values', key: config.format, url, body: text, httpStatus: status });

      let items: z.infer<typeof Item>[];
      try {
        items = z.array(Item).parse(JSON.parse(text));
        ctx.raw.setParseOk(rawId, true);
      } catch (err) {
        ctx.raw.setParseOk(rawId, false);
        warnings.push(`${config.format}: parse failed — ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      fetched += items.length;

      let unresolved = 0;
      ctx.db.transaction((tx) => {
        for (const item of items) {
          let assetType: 'player' | 'pick' = 'player';
          let assetId = item.player.sleeperId ?? null;

          if (!assetId) {
            if (PICK_RE.test(item.player.name) || item.player.position === 'PICK') {
              assetType = 'pick';
              assetId = item.player.name.trim();
            } else {
              assetId =
                (item.player.mflId != null ? ctx.ids.resolve('mfl', String(item.player.mflId)) : null) ??
                ctx.ids.resolveByName(item.player.name, item.player.position ?? undefined);
              if (!assetId) {
                unresolved++;
                continue;
              }
            }
          }

          tx.insert(marketValueSnapshots)
            .values({
              source: 'fantasycalc',
              format: config.format,
              assetType,
              assetId,
              value: item.value,
              rank: item.overallRank ?? null,
              extra: { positionRank: item.positionRank, trend30Day: item.trend30Day },
              snapshotDate: date,
              capturedAt: Date.now(),
            })
            .onConflictDoUpdate({
              target: [
                marketValueSnapshots.source,
                marketValueSnapshots.format,
                marketValueSnapshots.assetId,
                marketValueSnapshots.snapshotDate,
              ],
              set: { value: item.value, rank: item.overallRank ?? null, capturedAt: Date.now() },
            })
            .run();
          written++;
        }
      });
      if (unresolved > 0) warnings.push(`${config.format}: ${unresolved} unresolved players skipped`);
    }
    return { fetched, written, warnings };
  },
};

export const fantasycalcJobs: JobSpec[] = [valuesJob];
