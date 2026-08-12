import { z } from 'zod';
import { fetchRaw } from '@/lib/http';
import { snapshotDate } from '@/lib/dates';
import { marketValueSnapshots } from '@/db/schema';
import { clearUnmatched, recordUnmatched } from '@/ids/unmatched';
import type { JobCtx, JobReport, JobSpec } from '../types';

const Item = z
  .object({
    playerName: z.string(),
    slug: z.string().nullish(),
    position: z.string().nullish(),
    team: z.string().nullish(),
    oneQBValues: z.object({ value: z.number().nullish() }).loose().nullish(),
    superflexValues: z.object({ value: z.number().nullish() }).loose().nullish(),
  })
  .loose();

const PLAYER_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);

// KTC embeds the full rankings dataset as `var playersArray = [...]` in the page source.
function extractPlayersArray(html: string): unknown[] {
  const marker = 'var playersArray = ';
  const start = html.indexOf(marker);
  if (start === -1) throw new Error('playersArray marker not found — KTC page layout changed');
  const jsonStart = start + marker.length;
  // Bracket-match to the end of the array literal.
  let depth = 0;
  let end = -1;
  let inString = false;
  let escape = false;
  for (let i = jsonStart; i < html.length; i++) {
    const ch = html[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === '[') depth++;
    if (ch === ']') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) throw new Error('playersArray not terminated — KTC page layout changed');
  return JSON.parse(html.slice(jsonStart, end)) as unknown[];
}

const PAGES: Array<{ url: string; kind: string; formatPrefix: 'dynasty' | 'redraft' }> = [
  { url: 'https://keeptradecut.com/dynasty-rankings', kind: 'dynasty', formatPrefix: 'dynasty' },
  { url: 'https://keeptradecut.com/fantasy-rankings', kind: 'redraft', formatPrefix: 'redraft' },
];

const valuesJob: JobSpec = {
  name: 'ktc.values',
  source: 'ktc',
  cadence: { cron: '50 6 * * *', catchUp: true, staleAfterHours: 30 },
  timeoutMs: 300_000,
  async run(ctx): Promise<JobReport> {
    const warnings: string[] = [];
    let fetched = 0;
    let written = 0;
    const date = snapshotDate();

    // Politeness jitter so we don't hit KTC at an exact fixed second daily.
    await new Promise((r) => setTimeout(r, Math.random() * 15_000));

    for (const page of PAGES) {
      const { status, text } = await fetchRaw(page.url, { timeoutMs: 60_000 });
      const rawId = ctx.raw.archive({ source: 'ktc', kind: page.kind, url: page.url, body: text, httpStatus: status });

      let items: z.infer<typeof Item>[];
      try {
        items = z.array(Item).parse(extractPlayersArray(text));
        ctx.raw.setParseOk(rawId, true);
      } catch (err) {
        ctx.raw.setParseOk(rawId, false);
        warnings.push(`${page.kind}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      // KTC embeds its top 500 in the page; fewer than 450 means the layout changed.
      if (page.kind === 'dynasty' && items.length < 450) {
        warnings.push(`dynasty: only ${items.length} entries parsed (expected ~500) — page structure may have changed`);
      }
      fetched += items.length;

      let unresolved = 0;
      ctx.db.transaction((tx) => {
        for (const item of items) {
          const isPlayer = PLAYER_POSITIONS.has(item.position ?? '');
          let assetType: 'player' | 'pick' = isPlayer ? 'player' : 'pick';
          let assetId: string | null = null;

          if (isPlayer) {
            const slug = item.slug ?? item.playerName;
            assetId = ctx.ids.resolve('ktc', slug) ?? ctx.ids.resolveByName(item.playerName, item.position ?? undefined);
            if (assetId) {
              ctx.ids.record('ktc', slug, assetId, 'exact');
              clearUnmatched('ktc', slug);
            } else {
              recordUnmatched('ktc', slug, item.playerName, item.position, page.kind);
              unresolved++;
              continue;
            }
          } else {
            assetId = item.playerName.trim();
          }

          for (const [suffix, values] of [
            ['1qb', item.oneQBValues],
            ['sf', item.superflexValues],
          ] as const) {
            const value = values?.value;
            if (typeof value !== 'number') continue;
            tx.insert(marketValueSnapshots)
              .values({
                source: 'ktc',
                format: `${page.formatPrefix}_${suffix}`,
                assetType,
                assetId,
                value,
                rank: null,
                extra: { team: item.team, position: item.position },
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
                set: { value, capturedAt: Date.now() },
              })
              .run();
            written++;
          }
        }
      });
      if (unresolved > 0) warnings.push(`${page.kind}: ${unresolved} unresolved players skipped`);
    }
    return { fetched, written, warnings };
  },
};

export const ktcJobs: JobSpec[] = [valuesJob];
