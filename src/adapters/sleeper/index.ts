import { z } from 'zod';
import { fetchRaw } from '@/lib/http';
import { statsHash } from '@/lib/hash';
import { normalizeName } from '@/ids/resolver';
import { SEASON, SLEEPER_USER_ID } from '@/config';
import {
  draftPicks,
  drafts,
  leagues,
  leagueUsers,
  matchups,
  players,
  rosters,
  transactions,
  trendingSnapshots,
} from '@/db/schema';
import { snapshotDate } from '@/lib/dates';
import type { JobCtx, JobReport, JobSpec } from '../types';

const BASE = 'https://api.sleeper.app/v1';

async function getArchived(ctx: JobCtx, kind: string, key: string | undefined, url: string): Promise<unknown> {
  const { status, text } = await fetchRaw(url);
  const rawId = ctx.raw.archive({ source: 'sleeper', kind, key, url, body: text, httpStatus: status });
  try {
    const data = JSON.parse(text) as unknown;
    ctx.raw.setParseOk(rawId, true);
    return data;
  } catch (err) {
    ctx.raw.setParseOk(rawId, false);
    throw err;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DumpPlayer = z
  .object({
    player_id: z.string(),
    full_name: z.string().nullish(),
    first_name: z.string().nullish(),
    last_name: z.string().nullish(),
    position: z.string().nullish(),
    team: z.string().nullish(),
    status: z.string().nullish(),
    injury_status: z.string().nullish(),
    age: z.number().nullish(),
    years_exp: z.number().nullish(),
    fantasy_positions: z.array(z.string()).nullish(),
    gsis_id: z.union([z.string(), z.number()]).nullish(),
    espn_id: z.union([z.string(), z.number()]).nullish(),
    yahoo_id: z.union([z.string(), z.number()]).nullish(),
    rotowire_id: z.union([z.string(), z.number()]).nullish(),
    sportradar_id: z.union([z.string(), z.number()]).nullish(),
    stats_id: z.union([z.string(), z.number()]).nullish(),
    fantasy_data_id: z.union([z.string(), z.number()]).nullish(),
  })
  .loose();

const ID_SOURCES = ['gsis', 'espn', 'yahoo', 'rotowire', 'sportradar', 'stats', 'fantasy_data'] as const;

const playersDump: JobSpec = {
  name: 'sleeper.players_dump',
  source: 'sleeper',
  cadence: { cron: '0 6 * * *', catchUp: true, staleAfterHours: 26 },
  timeoutMs: 300_000,
  async run(ctx): Promise<JobReport> {
    const data = await getArchived(ctx, 'players_dump', undefined, `${BASE}/players/nfl`);
    const entries = Object.values(data as Record<string, unknown>);
    const warnings: string[] = [];
    let written = 0;
    const now = Date.now();
    ctx.db.transaction((tx) => {
      for (const entry of entries) {
        const parsed = DumpPlayer.safeParse(entry);
        if (!parsed.success) {
          if (warnings.length < 5) warnings.push(`players_dump reject: ${parsed.error.issues[0]?.message}`);
          continue;
        }
        const p = parsed.data;
        const fullName = p.full_name ?? [p.first_name, p.last_name].filter(Boolean).join(' ') ?? p.player_id;
        tx.insert(players)
          .values({
            sleeperId: p.player_id,
            fullName: fullName || p.player_id,
            searchName: normalizeName(fullName || p.player_id),
            pos: p.position ?? null,
            team: p.team ?? null,
            status: p.status ?? null,
            injuryStatus: p.injury_status ?? null,
            meta: {
              age: p.age,
              years_exp: p.years_exp,
              fantasy_positions: p.fantasy_positions,
              gsis_id: p.gsis_id,
            },
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: players.sleeperId,
            set: {
              fullName: fullName || p.player_id,
              searchName: normalizeName(fullName || p.player_id),
              pos: p.position ?? null,
              team: p.team ?? null,
              status: p.status ?? null,
              injuryStatus: p.injury_status ?? null,
              meta: { age: p.age, years_exp: p.years_exp, fantasy_positions: p.fantasy_positions, gsis_id: p.gsis_id },
              updatedAt: now,
            },
          })
          .run();
        written++;
        for (const source of ID_SOURCES) {
          const value = p[`${source}_id` as keyof typeof p];
          if (value !== null && value !== undefined && value !== '') {
            ctx.ids.record(source, String(value).trim(), p.player_id, 'seed');
          }
        }
      }
    });
    return { fetched: entries.length, written, warnings };
  },
};

const LeagueSchema = z
  .object({
    league_id: z.string(),
    season: z.coerce.number(),
    name: z.string(),
    status: z.string().nullish(),
    total_rosters: z.number().nullish(),
    scoring_settings: z.record(z.string(), z.number()),
    roster_positions: z.array(z.string()),
    settings: z.record(z.string(), z.unknown()),
    previous_league_id: z.string().nullish(),
    draft_id: z.string().nullish(),
  })
  .loose();

function upsertLeague(ctx: JobCtx, league: z.infer<typeof LeagueSchema>): void {
  ctx.db
    .insert(leagues)
    .values({
      leagueId: league.league_id,
      season: league.season,
      name: league.name,
      status: league.status ?? null,
      totalRosters: league.total_rosters ?? null,
      scoringSettings: league.scoring_settings,
      rosterPositions: league.roster_positions,
      settings: league.settings as Record<string, unknown>,
      scoringHash: statsHash(league.scoring_settings),
      previousLeagueId: league.previous_league_id ?? null,
      draftId: league.draft_id ?? null,
      fetchedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: leagues.leagueId,
      set: {
        name: league.name,
        status: league.status ?? null,
        totalRosters: league.total_rosters ?? null,
        scoringSettings: league.scoring_settings,
        rosterPositions: league.roster_positions,
        settings: league.settings as Record<string, unknown>,
        scoringHash: statsHash(league.scoring_settings),
        previousLeagueId: league.previous_league_id ?? null,
        draftId: league.draft_id ?? null,
        fetchedAt: Date.now(),
      },
    })
    .run();
}

async function ingestLeagueUsers(ctx: JobCtx, leagueId: string): Promise<void> {
  const users = (await getArchived(ctx, 'league_users', leagueId, `${BASE}/league/${leagueId}/users`)) as Array<
    Record<string, unknown>
  >;
  for (const u of users) {
    ctx.db
      .insert(leagueUsers)
      .values({
        leagueId,
        userId: String(u.user_id),
        displayName: (u.display_name as string) ?? null,
        teamName: ((u.metadata as Record<string, unknown> | null)?.team_name as string) ?? null,
        fetchedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: [leagueUsers.leagueId, leagueUsers.userId],
        set: {
          displayName: (u.display_name as string) ?? null,
          teamName: ((u.metadata as Record<string, unknown> | null)?.team_name as string) ?? null,
          fetchedAt: Date.now(),
        },
      })
      .run();
  }
}

async function ingestRosters(ctx: JobCtx, leagueId: string): Promise<void> {
  const rosterList = (await getArchived(ctx, 'rosters', leagueId, `${BASE}/league/${leagueId}/rosters`)) as Array<
    Record<string, unknown>
  >;
  for (const r of rosterList) {
    const values = {
      leagueId,
      rosterId: Number(r.roster_id),
      ownerId: r.owner_id ? String(r.owner_id) : null,
      playerIds: (r.players as string[]) ?? null,
      starters: (r.starters as string[]) ?? null,
      reserve: (r.reserve as string[]) ?? null,
      taxi: (r.taxi as string[]) ?? null,
      settings: (r.settings as Record<string, unknown>) ?? null,
      fetchedAt: Date.now(),
    };
    ctx.db
      .insert(rosters)
      .values(values)
      .onConflictDoUpdate({ target: [rosters.leagueId, rosters.rosterId], set: { ...values } })
      .run();
  }
}

async function ingestLeagueDrafts(ctx: JobCtx, leagueId: string, season: number): Promise<void> {
  const draftList = (await getArchived(ctx, 'drafts', leagueId, `${BASE}/league/${leagueId}/drafts`)) as Array<
    Record<string, unknown>
  >;
  for (const d of draftList) {
    const draftId = String(d.draft_id);
    ctx.db
      .insert(drafts)
      .values({
        draftId,
        leagueId,
        season,
        type: (d.type as string) ?? null,
        status: (d.status as string) ?? null,
        startTimeMs: (d.start_time as number) ?? null,
        settings: (d.settings as Record<string, unknown>) ?? null,
        metadata: (d.metadata as Record<string, unknown>) ?? null,
        draftOrder: (d.draft_order as Record<string, number>) ?? null,
        fetchedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: drafts.draftId,
        set: {
          status: (d.status as string) ?? null,
          startTimeMs: (d.start_time as number) ?? null,
          settings: (d.settings as Record<string, unknown>) ?? null,
          metadata: (d.metadata as Record<string, unknown>) ?? null,
          draftOrder: (d.draft_order as Record<string, number>) ?? null,
          fetchedAt: Date.now(),
        },
      })
      .run();

    if (d.status === 'complete' || d.status === 'in_progress') {
      const picks = (await getArchived(ctx, 'draft_picks', draftId, `${BASE}/draft/${draftId}/picks`)) as Array<
        Record<string, unknown>
      >;
      ctx.db.transaction((tx) => {
        for (const p of picks) {
          const values = {
            draftId,
            pickNo: Number(p.pick_no),
            round: (p.round as number) ?? null,
            draftSlot: (p.draft_slot as number) ?? null,
            rosterId: (p.roster_id as number) ?? null,
            playerId: p.player_id ? String(p.player_id) : null,
            pickedBy: p.picked_by ? String(p.picked_by) : null,
            amount:
              p.metadata && (p.metadata as Record<string, unknown>).amount
                ? Number((p.metadata as Record<string, unknown>).amount)
                : null,
            isKeeper: (p.is_keeper as boolean) ?? null,
            metadata: (p.metadata as Record<string, unknown>) ?? null,
            fetchedAt: Date.now(),
          };
          tx.insert(draftPicks)
            .values(values)
            .onConflictDoUpdate({ target: [draftPicks.draftId, draftPicks.pickNo], set: { ...values } })
            .run();
        }
      });
    }
  }
}

const leaguesJob: JobSpec = {
  name: 'sleeper.leagues',
  source: 'sleeper',
  cadence: { cron: '10 6 * * *', catchUp: true, staleAfterHours: 26 },
  timeoutMs: 300_000,
  async run(ctx): Promise<JobReport> {
    const warnings: string[] = [];
    let written = 0;
    const list = z
      .array(LeagueSchema)
      .parse(await getArchived(ctx, 'leagues', String(SEASON), `${BASE}/user/${SLEEPER_USER_ID}/leagues/nfl/${SEASON}`));

    for (const league of list) {
      upsertLeague(ctx, league);
      written++;
      await ingestLeagueUsers(ctx, league.league_id);
      await ingestRosters(ctx, league.league_id);
      await ingestLeagueDrafts(ctx, league.league_id, league.season);
      await sleep(60);
    }
    return { fetched: list.length, written, warnings };
  },
};

const MatchupSchema = z
  .object({
    roster_id: z.number(),
    matchup_id: z.number().nullish(),
    points: z.number().nullish(),
    players_points: z.record(z.string(), z.number()).nullish(),
    starters: z.array(z.string().nullable()).nullish(),
    players: z.array(z.string()).nullish(),
  })
  .loose();

async function ingestMatchupWeek(ctx: JobCtx, leagueId: string, week: number): Promise<number> {
  const data = await getArchived(ctx, 'matchups', `${leagueId}-w${week}`, `${BASE}/league/${leagueId}/matchups/${week}`);
  const rows = z.array(MatchupSchema).parse(data);
  ctx.db.transaction((tx) => {
    for (const m of rows) {
      tx.insert(matchups)
        .values({
          leagueId,
          week,
          rosterId: m.roster_id,
          matchupId: m.matchup_id ?? null,
          points: m.points ?? null,
          playersPoints: m.players_points ?? null,
          starters: (m.starters?.filter(Boolean) as string[]) ?? null,
          playerIds: m.players ?? null,
          fetchedAt: Date.now(),
        })
        .onConflictDoUpdate({
          target: [matchups.leagueId, matchups.week, matchups.rosterId],
          set: {
            matchupId: m.matchup_id ?? null,
            points: m.points ?? null,
            playersPoints: m.players_points ?? null,
            starters: (m.starters?.filter(Boolean) as string[]) ?? null,
            playerIds: m.players ?? null,
            fetchedAt: Date.now(),
          },
        })
        .run();
    }
  });
  return rows.length;
}

const matchupsJob: JobSpec = {
  name: 'sleeper.matchups',
  source: 'sleeper',
  cadence: { cron: '0 */6 * * *', catchUp: false, staleAfterHours: 12 },
  enabled: (clock) => clock.seasonType === 'regular' || clock.seasonType === 'post',
  async run(ctx): Promise<JobReport> {
    const myLeagues = ctx.db.select({ leagueId: leagues.leagueId }).from(leagues).all().filter(Boolean);
    let written = 0;
    for (const l of myLeagues) {
      const league = ctx.db.select().from(leagues).all().find((x) => x.leagueId === l.leagueId);
      if (!league || league.season !== SEASON) continue;
      written += await ingestMatchupWeek(ctx, l.leagueId, ctx.clock.week);
      await sleep(60);
    }
    return { fetched: written, written, warnings: [] };
  },
};

// Walk previous_league_id chains from the 2026 leagues to their 2025 versions and
// pull full-season matchups (players_points = the scoring-validation oracle).
const backfill2025: JobSpec = {
  name: 'sleeper.matchups_backfill_2025',
  source: 'sleeper',
  cadence: { cron: '0 7 1 * *', catchUp: true, staleAfterHours: 24 * 14 },
  timeoutMs: 600_000,
  async run(ctx): Promise<JobReport> {
    const warnings: string[] = [];
    let written = 0;
    const current = ctx.db.select().from(leagues).all().filter((l) => l.season === SEASON);
    for (const league of current) {
      let prevId = league.previousLeagueId;
      let hops = 0;
      while (prevId && hops < 3) {
        const doc = LeagueSchema.parse(await getArchived(ctx, 'league_doc', prevId, `${BASE}/league/${prevId}`));
        upsertLeague(ctx, doc);
        if (doc.season === 2025) {
          for (let week = 1; week <= 18; week++) {
            try {
              written += await ingestMatchupWeek(ctx, doc.league_id, week);
            } catch (err) {
              warnings.push(`backfill ${doc.league_id} w${week}: ${err instanceof Error ? err.message : String(err)}`);
            }
            await sleep(60);
          }
          break;
        }
        prevId = doc.previous_league_id ?? null;
        hops++;
      }
    }
    return { fetched: written, written, warnings };
  },
};

async function ingestTransactionWeek(ctx: JobCtx, leagueId: string, week: number): Promise<number> {
  const data = (await getArchived(
    ctx,
    'transactions',
    `${leagueId}-w${week}`,
    `${BASE}/league/${leagueId}/transactions/${week}`,
  )) as Array<Record<string, unknown>> | null;
  let written = 0;
  for (const t of data ?? []) {
    const values = {
      leagueId,
      transactionId: String(t.transaction_id),
      week,
      type: (t.type as string) ?? null,
      status: (t.status as string) ?? null,
      rosterIds: (t.roster_ids as number[]) ?? null,
      adds: (t.adds as Record<string, number>) ?? null,
      drops: (t.drops as Record<string, number>) ?? null,
      faabBid: ((t.settings as Record<string, unknown> | null)?.waiver_bid as number) ?? null,
      tradedPicks:
        (t.draft_picks as Array<{ season: string; round: number; roster_id: number; previous_owner_id: number; owner_id: number }>) ??
        null,
      waiverBudget: (t.waiver_budget as Array<{ sender: number; receiver: number; amount: number }>) ?? null,
      metadata: (t.metadata as Record<string, unknown>) ?? null,
      createdAtMs: (t.created as number) ?? null,
      fetchedAt: Date.now(),
    };
    ctx.db
      .insert(transactions)
      .values(values)
      .onConflictDoUpdate({ target: [transactions.leagueId, transactions.transactionId], set: { ...values } })
      .run();
    written++;
  }
  return written;
}

const transactionsJob: JobSpec = {
  name: 'sleeper.transactions',
  source: 'sleeper',
  cadence: { cron: '20 6 * * *', catchUp: true, staleAfterHours: 26 },
  timeoutMs: 300_000,
  async run(ctx): Promise<JobReport> {
    let written = 0;
    const warnings: string[] = [];
    const current = ctx.db.select().from(leagues).all().filter((l) => l.season === SEASON);
    const maxWeek = ctx.clock.seasonType === 'regular' || ctx.clock.seasonType === 'post' ? ctx.clock.week : 1;
    for (const league of current) {
      for (let week = 1; week <= maxWeek; week++) {
        written += await ingestTransactionWeek(ctx, league.leagueId, week);
        await sleep(40);
      }
    }
    return { fetched: written, written, warnings };
  },
};

// Walk each current league's previous_league_id chain and ingest the complete
// historical record — users, rosters, drafts + picks, and every transaction
// week. Raw material for manager tendency profiles (draft position timing,
// auction bidding shape, trade/FAAB behavior). Completed seasons never change,
// so this runs monthly; re-runs are idempotent upserts.
const leagueHistory: JobSpec = {
  name: 'sleeper.league_history',
  source: 'sleeper',
  cadence: { cron: '40 7 1 * *', catchUp: true, staleAfterHours: 24 * 30 },
  timeoutMs: 1_800_000,
  async run(ctx): Promise<JobReport> {
    const warnings: string[] = [];
    let written = 0;
    const current = ctx.db.select().from(leagues).all().filter((l) => l.season === SEASON);
    for (const league of current) {
      let prevId = league.previousLeagueId;
      let hops = 0;
      while (prevId && prevId !== '0' && hops < 10) {
        let doc: z.infer<typeof LeagueSchema>;
        try {
          doc = LeagueSchema.parse(await getArchived(ctx, 'league_doc', prevId, `${BASE}/league/${prevId}`));
        } catch (err) {
          warnings.push(`history ${prevId}: ${err instanceof Error ? err.message : String(err)}`);
          break;
        }
        upsertLeague(ctx, doc);
        written++;
        try {
          await ingestLeagueUsers(ctx, doc.league_id);
          await ingestRosters(ctx, doc.league_id);
          await ingestLeagueDrafts(ctx, doc.league_id, doc.season);
          for (let week = 1; week <= 18; week++) {
            written += await ingestTransactionWeek(ctx, doc.league_id, week);
            await sleep(40);
          }
        } catch (err) {
          warnings.push(`history ${doc.league_id} (${doc.season}): ${err instanceof Error ? err.message : String(err)}`);
        }
        prevId = doc.previous_league_id ?? null;
        hops++;
        await sleep(60);
      }
    }
    return { fetched: written, written, warnings };
  },
};

const trendingJob: JobSpec = {
  name: 'sleeper.trending',
  source: 'sleeper',
  cadence: { cron: '15 */6 * * *', catchUp: true, staleAfterHours: 7 },
  async run(ctx): Promise<JobReport> {
    let written = 0;
    for (const type of ['add', 'drop'] as const) {
      const data = (await getArchived(ctx, 'trending', type, `${BASE}/players/nfl/trending/${type}?limit=200`)) as Array<{
        player_id: string;
        count: number;
      }>;
      const date = snapshotDate();
      ctx.db.transaction((tx) => {
        for (const item of data) {
          tx.insert(trendingSnapshots)
            .values({ type, playerId: item.player_id, count: item.count, snapshotDate: date, capturedAt: Date.now() })
            .onConflictDoUpdate({
              target: [trendingSnapshots.type, trendingSnapshots.playerId, trendingSnapshots.snapshotDate],
              set: { count: item.count, capturedAt: Date.now() },
            })
            .run();
          written++;
        }
      });
    }
    return { fetched: written, written, warnings: [] };
  },
};

export const sleeperJobs: JobSpec[] = [playersDump, leaguesJob, matchupsJob, backfill2025, transactionsJob, trendingJob, leagueHistory];
