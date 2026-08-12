import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { env, SEASON, SLEEPER_USER_ID } from '@/config';
import { fetchRaw } from '@/lib/http';
import { newsItems } from '@/db/schema';
import type { JobCtx, JobReport, JobSpec } from '../types';

// Sleeper internal GraphQL (sleeper.com/graphql) — JWT-only auth, no cookies.
// Verified shape: get_player_news(sport: String!, player_id: String!, limit: Int)
// → [{ source, source_key, published, player_id, metadata { title, description, analysis?, url? } }]

const GQL_URL = 'https://sleeper.com/graphql';

const NewsSchema = z
  .object({
    source: z.string(),
    source_key: z.string(),
    published: z.number(),
    player_id: z.string(),
    metadata: z
      .object({
        title: z.string().nullish(),
        description: z.string().nullish(),
        analysis: z.string().nullish(),
        url: z.string().nullish(),
        topic_id: z.union([z.string(), z.number()]).nullish(),
      })
      .loose(),
  })
  .loose();

async function fetchNewsFor(playerId: string, jwt: string): Promise<unknown[]> {
  const query = `{ get_player_news(sport: "nfl", player_id: "${playerId}", limit: 10) { source source_key published player_id metadata } }`;
  const { text } = await fetchRaw(GQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: jwt },
    body: JSON.stringify({ query }),
    timeoutMs: 15_000,
    retries: 1,
  });
  const parsed = JSON.parse(text) as { data?: { get_player_news?: unknown[] } };
  return parsed.data?.get_player_news ?? [];
}

// Watchlist: everyone on my rosters across all leagues, plus the top ~150 by
// current league value anywhere (covers waiver-relevant free agents).
function watchlist(ctx: JobCtx): string[] {
  const rosterRows = ctx.db.all<{ player_ids: string | null }>(sql`
    select r.player_ids from rosters r
    join leagues l on l.league_id = r.league_id
    where l.season = ${SEASON} and r.owner_id = ${SLEEPER_USER_ID}
  `);
  const ids = new Set<string>();
  for (const row of rosterRows) {
    for (const id of row.player_ids ? (JSON.parse(row.player_ids) as string[]) : []) ids.add(id);
  }
  const top = ctx.db.all<{ player_id: string }>(sql`
    with latest as (select league_id, max(id) as run_id from valuation_runs group by league_id)
    select lv.player_id, max(lv.points) as pts
    from league_values lv join latest on latest.run_id = lv.run_id
    group by lv.player_id
    order by pts desc
    limit 150
  `);
  for (const row of top) ids.add(row.player_id);
  return [...ids];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const newsJob: JobSpec = {
  name: 'sleeper_gql.news',
  source: 'sleeper_gql',
  cadence: { cron: '5 * * * *', catchUp: true, staleAfterHours: 3 },
  timeoutMs: 300_000,
  async run(ctx): Promise<JobReport> {
    if (!env.SLEEPER_JWT) {
      return { fetched: 0, written: 0, warnings: ['SLEEPER_JWT not set — job skipped'] };
    }
    const players = watchlist(ctx);
    const warnings: string[] = [];
    const collected: unknown[] = [];
    let failures = 0;

    for (const playerId of players) {
      try {
        collected.push(...(await fetchNewsFor(playerId, env.SLEEPER_JWT)));
      } catch (err) {
        failures++;
        if (failures <= 3) warnings.push(`news fetch ${playerId}: ${err instanceof Error ? err.message : String(err)}`);
        if (failures > 10) {
          warnings.push(`aborting after ${failures} failures (JWT expired?)`);
          break;
        }
      }
      await sleep(60);
    }

    // One aggregate raw archive per run — not 300 files.
    ctx.raw.archive({
      source: 'sleeper_gql',
      kind: 'news',
      key: `${players.length}-players`,
      url: GQL_URL,
      body: JSON.stringify(collected),
      httpStatus: 200,
    });

    let written = 0;
    ctx.db.transaction((tx) => {
      for (const item of collected) {
        const parsed = NewsSchema.safeParse(item);
        if (!parsed.success) continue;
        const n = parsed.data;
        const body = [n.metadata.description, n.metadata.analysis].filter(Boolean).join('\n\n');
        const result = tx
          .insert(newsItems)
          .values({
            source: n.source,
            sourceNewsId: `${n.source}:${n.source_key}`,
            playerId: n.player_id,
            title: n.metadata.title ?? null,
            body: body || null,
            publishedAtMs: n.published,
            meta: { url: n.metadata.url ?? undefined, topic_id: n.metadata.topic_id ?? undefined },
            firstSeenAt: Date.now(),
          })
          .onConflictDoNothing()
          .run();
        written += result.changes;
      }
    });

    return { fetched: collected.length, written, warnings };
  },
};

export const sleeperGqlJobs: JobSpec[] = [newsJob];
