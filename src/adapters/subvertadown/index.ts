import { env } from '@/config';
import { fetchRaw } from '@/lib/http';
import { snapshotDate } from '@/lib/dates';
import { rankingSnapshots } from '@/db/schema';
import { clearUnmatched, recordUnmatched } from '@/ids/unmatched';
import type { JobCtx, JobReport, JobSpec } from '../types';

// Subvertadown streaming values (QB/K/DST) — the streaming-baseline source for
// Phase 4. Free-account cookie required (pages redirect to /login without it).
// ARCHIVE-FIRST like draftsharks: raw pages persist even while parsing is
// best-effort.

const PAGES: Array<{ path: string; alternates?: string[]; profile: string; pos: string }> = [
  { path: 'rest-of-season/quarterback', profile: 'ros_qb_standard', pos: 'QB' },
  { path: 'rest-of-season/kicker', profile: 'ros_k_standard', pos: 'K' },
  { path: 'rest-of-season/defense', alternates: ['rest-of-season/dst'], profile: 'ros_dst_standard', pos: 'DEF' },
];

interface ParsedRow {
  rank: number;
  name: string;
  value: number | null;
}

// Generic table parse: first cell with letters = name, last numeric cell = value.
export function parseSubvertadownTable(html: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  const tableMatch = /<table[\s\S]*?<\/table>/.exec(html);
  if (!tableMatch) return rows;
  const rowRe = /<tr[\s\S]*?<\/tr>/g;
  let match: RegExpExecArray | null;
  while ((match = rowRe.exec(tableMatch[0])) !== null) {
    const cells = [...match[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) =>
      m[1]!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    );
    if (cells.length < 2) continue;
    const name = cells.find((c) => /[a-zA-Z]{3,}/.test(c) && !/^(rank|player|team|value|proj)/i.test(c));
    const numeric = [...cells].reverse().find((c) => /^-?\d+(\.\d+)?$/.test(c));
    if (!name) continue;
    rows.push({ rank: rows.length + 1, name, value: numeric ? Number(numeric) : null });
  }
  return rows;
}

function looksLikeLogin(html: string): boolean {
  return /type="password"|href="\/login"|log in to view/i.test(html) && !/<table/.test(html);
}

const valuesJob: JobSpec = {
  name: 'subvertadown.values',
  source: 'subvertadown',
  cadence: { cron: '20 7 * * *', catchUp: true, staleAfterHours: 30 },
  timeoutMs: 300_000,
  async run(ctx): Promise<JobReport> {
    if (!env.SUBVERTADOWN_COOKIE) {
      return { fetched: 0, written: 0, warnings: ['SUBVERTADOWN_COOKIE not set — job skipped'] };
    }
    const warnings: string[] = [];
    let fetched = 0;
    let written = 0;
    const date = snapshotDate();

    for (const page of PAGES) {
      let html = '';
      let status = 0;
      let fetchedOk = false;
      for (const path of [page.path, ...(page.alternates ?? [])]) {
        try {
          ({ text: html, status } = await fetchRaw(`https://subvertadown.com/${path}?week_offset=1&scoring_type=standard`, {
            headers: { cookie: env.SUBVERTADOWN_COOKIE },
            timeoutMs: 30_000,
            retries: 1,
          }));
          fetchedOk = true;
          break;
        } catch {
          // try alternate path
        }
      }
      if (!fetchedOk) {
        warnings.push(`${page.profile}: all paths failed`);
        continue;
      }
      ctx.raw.archive({ source: 'subvertadown', kind: 'ros', key: page.profile, body: html, httpStatus: status });

      if (looksLikeLogin(html)) {
        warnings.push(`${page.profile}: cookie missing/expired (login page returned)`);
        continue;
      }
      const rows = parseSubvertadownTable(html);
      fetched += rows.length;
      if (rows.length === 0) {
        warnings.push(`${page.profile}: 0 rows parsed — structure discovery pending (raw archived)`);
        continue;
      }

      ctx.db.transaction((tx) => {
        for (const row of rows) {
          // DST rows may be team names ("Broncos") — resolveByName handles full
          // team names; short forms land in the unmatched queue for mapping.
          const sleeperId = ctx.ids.resolveByName(row.name, page.pos) ?? ctx.ids.resolveByName(row.name);
          if (!sleeperId) {
            recordUnmatched('subvertadown', `${row.name}|${page.pos}`, row.name, page.pos, page.profile);
            continue;
          }
          clearUnmatched('subvertadown', `${row.name}|${page.pos}`);
          tx.insert(rankingSnapshots)
            .values({
              source: 'subvertadown',
              profile: page.profile,
              expert: 'subvertadown',
              playerId: sleeperId,
              rank: row.rank,
              extra: row.value !== null ? { value: row.value } : null,
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
              set: { rank: row.rank, extra: row.value !== null ? { value: row.value } : null, capturedAt: Date.now() },
            })
            .run();
          written++;
        }
      });
    }
    return { fetched, written, warnings };
  },
};

export const subvertadownJobs: JobSpec[] = [valuesJob];
