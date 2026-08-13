import { env, SEASON } from '@/config';
import { fetchRaw } from '@/lib/http';
import { snapshotDate } from '@/lib/dates';
import { rankingSnapshots } from '@/db/schema';
import { clearUnmatched, recordUnmatched } from '@/ids/unmatched';
import type { JobCtx, JobReport, JobSpec } from '../types';

// Footballguys per-ranker boards — server-rendered HTML tables. Public pages
// show a 15-row teaser; the full board requires the subscriber cookie
// (FBG_COOKIE). leagueid pins Casey's FBG scoring profile so ranks arrive
// scored to his league config.

const FBG_LEAGUE_PROFILE = '8012';
const FBG_USER_ID = '932063';

// Casey's 17 staffers to archive daily (slug = FBG url segment).
const RANKERS = [
  'jeff-blaylock',
  'andy-hicks',
  'ryan-weisse',
  'corey-spala',
  'gary-davenport',
  'craig-lakins',
  'jason-wood',
  'jeff-bell',
  'john-norton',
  'kyle-bellefeuil',
  'sigmund-bloom',
  'jeff-haseley',
  'dan-hindery',
  'dave-kluge',
  'josh-fahlsing',
  'darin-tietgen',
  'joseph-haggan',
];

const POSITIONS: Array<{ param: string; pos: string }> = [
  { param: 'qb', pos: 'QB' },
  { param: 'rb', pos: 'RB' },
  { param: 'wr', pos: 'WR' },
  { param: 'te', pos: 'TE' },
  { param: 'pk', pos: 'K' },
  { param: 'def', pos: 'DEF' },
  { param: 'dl', pos: 'DL' },
  { param: 'lb', pos: 'LB' },
  { param: 'db', pos: 'DB' },
];

const TEASER_ROWS = 15;

interface ParsedRow {
  rank: number;
  name: string;
}

// Rows are <tr class="player-row"> with the name inside the sticky name cell.
export function parseFbgBoard(html: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  const rowRe = /<tr[^>]*class="[^"]*player-row[^"]*"[\s\S]*?<\/tr>/g;
  const nameCellRe = /class="[^"]*name player-col[^"]*"[^>]*>([\s\S]*?)<\/td>/;
  let match: RegExpExecArray | null;
  while ((match = rowRe.exec(html)) !== null) {
    const cell = nameCellRe.exec(match[0]);
    if (!cell) continue;
    const name = cell[1]!
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\s*\(?[A-Z]{2,3}\)?\s*$/, '') // trailing team code ("Brian Branch DET")
      .trim();
    if (name) rows.push({ rank: rows.length + 1, name });
  }
  return rows;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const rankingsJob: JobSpec = {
  name: 'footballguys.rankings',
  source: 'footballguys',
  cadence: { cron: '0 7 * * *', catchUp: true, staleAfterHours: 30 },
  timeoutMs: 600_000,
  async run(ctx): Promise<JobReport> {
    if (!env.FBG_COOKIE) {
      return { fetched: 0, written: 0, warnings: ['FBG_COOKIE not set — job skipped'] };
    }
    const durations = ctx.clock.seasonType === 'regular' ? ['dynasty', 'ros'] : ['dynasty'];
    const warnings: string[] = [];
    let fetched = 0;
    let written = 0;
    let teaserBoards = 0;
    let boards = 0;
    const date = snapshotDate();
    const aggregate: Array<{ expert: string; profile: string; rows: number }> = [];

    for (const slug of RANKERS) {
      for (const duration of durations) {
        for (const { param, pos } of POSITIONS) {
          const url =
            `https://www.footballguys.com/rankings/ranker/${slug}/duration/${duration}` +
            `?leagueid=${FBG_LEAGUE_PROFILE}&pos=${param}&year=${SEASON}&week=0&durationTypeKey=${duration}` +
            `&userId=${FBG_USER_ID}&stafferName=${slug}`;
          let html: string;
          try {
            ({ text: html } = await fetchRaw(url, { headers: { cookie: env.FBG_COOKIE }, timeoutMs: 30_000, retries: 1 }));
          } catch (err) {
            if (warnings.length < 5) warnings.push(`${slug}/${duration}/${param}: ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }
          const rows = parseFbgBoard(html);
          if (rows.length === 0) continue; // ranker doesn't cover this position/duration
          boards++;
          fetched += rows.length;
          if (rows.length <= TEASER_ROWS) {
            teaserBoards++;
            if (teaserBoards === 1) {
              ctx.raw.archive({ source: 'footballguys', kind: 'teaser-sample', key: `${slug}-${param}`, url, body: html, httpStatus: 200 });
            }
          }
          const profile = `${duration}_${param}`;
          aggregate.push({ expert: slug, profile, rows: rows.length });

          ctx.db.transaction((tx) => {
            for (const row of rows) {
              const sleeperId = ctx.ids.resolve('footballguys', `${row.name}|${pos}`) ?? ctx.ids.resolveByName(row.name, pos);
              if (!sleeperId) {
                const ignored = recordUnmatched('footballguys', `${row.name}|${pos}`, row.name, pos, profile);
                void ignored;
                continue;
              }
              ctx.ids.record('footballguys', `${row.name}|${pos}`, sleeperId, 'exact');
              clearUnmatched('footballguys', `${row.name}|${pos}`);
              tx.insert(rankingSnapshots)
                .values({
                  source: 'footballguys',
                  profile,
                  expert: slug,
                  playerId: sleeperId,
                  rank: row.rank,
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
                  set: { rank: row.rank, capturedAt: Date.now() },
                })
                .run();
              written++;
            }
          });
          await sleep(200);
        }
      }
    }

    ctx.raw.archive({
      source: 'footballguys',
      kind: 'boards-summary',
      key: date,
      body: JSON.stringify(aggregate),
      httpStatus: 200,
    });

    if (boards > 0 && teaserBoards > boards / 2) {
      warnings.push(`FBG cookie appears logged out — ${teaserBoards}/${boards} boards returned teaser rows only`);
    }
    return { fetched, written, warnings };
  },
};

export const footballguysJobs: JobSpec[] = [rankingsJob];
