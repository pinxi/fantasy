import { env } from '@/config';
import { fetchRaw } from '@/lib/http';
import { snapshotDate } from '@/lib/dates';
import { rankingSnapshots } from '@/db/schema';
import { clearUnmatched, recordUnmatched } from '@/ids/unmatched';
import type { JobCtx, JobReport, JobSpec } from '../types';

// DraftSharks league-synced free-agent rankings. Requires DS_COOKIE (site
// redirects to login otherwise). ARCHIVE-FIRST: the authenticated page is
// archived every run even while the parser is best-effort — replay retrofits
// parsing without losing history.

const DS_LEAGUES: Array<{ dsLeagueId: string; profile: string }> = [
  { dsLeagueId: '1058077', profile: 'squidward_fa' }, // Squidward Dynasty (Sleeper sync)
];

interface ParsedRow {
  rank: number;
  name: string;
}

// Best-effort: player-profile links are the most stable marker on DS pages.
export function parseDsFreeAgents(html: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  const seen = new Set<string>();
  const linkRe = /<a[^>]*href="\/(?:player|nfl-player)[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(html)) !== null) {
    const name = match[1]!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!name || name.length < 4 || seen.has(name)) continue;
    seen.add(name);
    rows.push({ rank: rows.length + 1, name });
  }
  return rows;
}

function looksLikeLogin(html: string): boolean {
  return /type="password"|\/login|Sign In to Your Account/i.test(html) && html.length < 60_000;
}

const leagueFaJob: JobSpec = {
  name: 'draftsharks.league_fa',
  source: 'draftsharks',
  cadence: { cron: '10 7 * * *', catchUp: true, staleAfterHours: 30 },
  timeoutMs: 300_000,
  async run(ctx): Promise<JobReport> {
    if (!env.DS_COOKIE) {
      return { fetched: 0, written: 0, warnings: ['DS_COOKIE not set — job skipped'] };
    }
    const warnings: string[] = [];
    let fetched = 0;
    let written = 0;
    const date = snapshotDate();

    for (const league of DS_LEAGUES) {
      const url = `https://www.draftsharks.com/league/free-agent/${league.dsLeagueId}`;
      let html: string;
      let status: number;
      try {
        ({ text: html, status } = await fetchRaw(url, { headers: { cookie: env.DS_COOKIE }, timeoutMs: 30_000 }));
      } catch (err) {
        warnings.push(`${league.profile}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      ctx.raw.archive({ source: 'draftsharks', kind: 'league_fa', key: league.dsLeagueId, url, body: html, httpStatus: status });

      if (looksLikeLogin(html)) {
        warnings.push(`${league.profile}: DS cookie missing/expired (login page returned)`);
        continue;
      }
      const rows = parseDsFreeAgents(html);
      fetched += rows.length;
      if (rows.length === 0) {
        warnings.push(`${league.profile}: 0 rows parsed — structure discovery pending (raw archived for replay)`);
        continue;
      }

      ctx.db.transaction((tx) => {
        for (const row of rows) {
          const sleeperId = ctx.ids.resolveByName(row.name);
          if (!sleeperId) {
            recordUnmatched('draftsharks', row.name, row.name, null, league.profile);
            continue;
          }
          clearUnmatched('draftsharks', row.name);
          tx.insert(rankingSnapshots)
            .values({
              source: 'draftsharks',
              profile: league.profile,
              expert: 'draftsharks',
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
    }
    return { fetched, written, warnings };
  },
};

export const draftsharksJobs: JobSpec[] = [leagueFaJob];
