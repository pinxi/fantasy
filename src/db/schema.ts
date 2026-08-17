import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// Convention: timestamps are epoch ms integers; snapshot_date is an
// America/New_York calendar date string (YYYY-MM-DD); JSON lives in text
// columns with { mode: 'json' }. week=0 means "season aggregate".

export const players = sqliteTable(
  'players',
  {
    sleeperId: text('sleeper_id').primaryKey(),
    fullName: text('full_name').notNull(),
    searchName: text('search_name').notNull(),
    pos: text('pos'),
    team: text('team'),
    status: text('status'),
    injuryStatus: text('injury_status'),
    meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('players_pos_team').on(t.pos, t.team), index('players_search').on(t.searchName)],
);

export const playerIdMap = sqliteTable(
  'player_id_map',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    source: text('source').notNull(),
    sourceId: text('source_id').notNull(),
    sleeperId: text('sleeper_id').notNull(),
    method: text('method').$type<'seed' | 'exact' | 'fuzzy' | 'manual'>().notNull(),
    confidence: real('confidence'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('idmap_source_sourceid').on(t.source, t.sourceId), index('idmap_sleeper').on(t.sleeperId)],
);

export const leagues = sqliteTable('leagues', {
  leagueId: text('league_id').primaryKey(),
  season: integer('season').notNull(),
  name: text('name').notNull(),
  status: text('status'),
  totalRosters: integer('total_rosters'),
  scoringSettings: text('scoring_settings', { mode: 'json' }).$type<Record<string, number>>().notNull(),
  rosterPositions: text('roster_positions', { mode: 'json' }).$type<string[]>().notNull(),
  settings: text('settings', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  scoringHash: text('scoring_hash').notNull(),
  previousLeagueId: text('previous_league_id'),
  draftId: text('draft_id'),
  fetchedAt: integer('fetched_at').notNull(),
});

export const leagueUsers = sqliteTable(
  'league_users',
  {
    leagueId: text('league_id').notNull(),
    userId: text('user_id').notNull(),
    displayName: text('display_name'),
    teamName: text('team_name'),
    fetchedAt: integer('fetched_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.leagueId, t.userId] })],
);

export const rosters = sqliteTable(
  'rosters',
  {
    leagueId: text('league_id').notNull(),
    rosterId: integer('roster_id').notNull(),
    ownerId: text('owner_id'),
    playerIds: text('player_ids', { mode: 'json' }).$type<string[]>(),
    starters: text('starters', { mode: 'json' }).$type<string[]>(),
    reserve: text('reserve', { mode: 'json' }).$type<string[]>(),
    taxi: text('taxi', { mode: 'json' }).$type<string[]>(),
    settings: text('settings', { mode: 'json' }).$type<Record<string, unknown>>(),
    fetchedAt: integer('fetched_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.leagueId, t.rosterId] })],
);

export const matchups = sqliteTable(
  'matchups',
  {
    leagueId: text('league_id').notNull(),
    week: integer('week').notNull(),
    rosterId: integer('roster_id').notNull(),
    matchupId: integer('matchup_id'),
    points: real('points'),
    playersPoints: text('players_points', { mode: 'json' }).$type<Record<string, number>>(),
    starters: text('starters', { mode: 'json' }).$type<string[]>(),
    playerIds: text('player_ids', { mode: 'json' }).$type<string[]>(),
    fetchedAt: integer('fetched_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.leagueId, t.week, t.rosterId] })],
);

export const transactions = sqliteTable(
  'transactions',
  {
    leagueId: text('league_id').notNull(),
    transactionId: text('transaction_id').notNull(),
    week: integer('week'),
    type: text('type'),
    status: text('status'),
    rosterIds: text('roster_ids', { mode: 'json' }).$type<number[]>(),
    adds: text('adds', { mode: 'json' }).$type<Record<string, number>>(),
    drops: text('drops', { mode: 'json' }).$type<Record<string, number>>(),
    faabBid: integer('faab_bid'),
    tradedPicks: text('traded_picks', { mode: 'json' }).$type<
      Array<{ season: string; round: number; roster_id: number; previous_owner_id: number; owner_id: number }>
    >(),
    waiverBudget: text('waiver_budget', { mode: 'json' }).$type<Array<{ sender: number; receiver: number; amount: number }>>(),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAtMs: integer('created_at_ms'),
    fetchedAt: integer('fetched_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.leagueId, t.transactionId] }), index('tx_league_week').on(t.leagueId, t.week)],
);

export const drafts = sqliteTable('drafts', {
  draftId: text('draft_id').primaryKey(),
  leagueId: text('league_id'),
  season: integer('season'),
  type: text('type'),
  status: text('status'),
  startTimeMs: integer('start_time_ms'),
  settings: text('settings', { mode: 'json' }).$type<Record<string, unknown>>(),
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
  draftOrder: text('draft_order', { mode: 'json' }).$type<Record<string, number>>(),
  fetchedAt: integer('fetched_at').notNull(),
});

export const draftPicks = sqliteTable(
  'draft_picks',
  {
    draftId: text('draft_id').notNull(),
    pickNo: integer('pick_no').notNull(),
    round: integer('round'),
    draftSlot: integer('draft_slot'),
    rosterId: integer('roster_id'),
    playerId: text('player_id'),
    pickedBy: text('picked_by'),
    amount: integer('amount'),
    isKeeper: integer('is_keeper', { mode: 'boolean' }),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
    fetchedAt: integer('fetched_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.draftId, t.pickNo] })],
);

export const projectionSnapshots = sqliteTable(
  'projection_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    source: text('source').notNull(),
    season: integer('season').notNull(),
    week: integer('week').notNull(), // 0 = season aggregate
    playerId: text('player_id').notNull(),
    stats: text('stats', { mode: 'json' }).$type<Record<string, number>>().notNull(),
    statsHash: text('stats_hash').notNull(),
    snapshotDate: text('snapshot_date').notNull(),
    capturedAt: integer('captured_at').notNull(),
  },
  (t) => [
    uniqueIndex('proj_uq').on(t.source, t.season, t.week, t.playerId, t.snapshotDate),
    index('proj_player').on(t.playerId, t.season, t.snapshotDate),
    index('proj_board').on(t.source, t.season, t.week, t.snapshotDate),
  ],
);

export const statActuals = sqliteTable(
  'stat_actuals',
  {
    source: text('source').notNull(),
    season: integer('season').notNull(),
    week: integer('week').notNull(),
    playerId: text('player_id').notNull(),
    stats: text('stats', { mode: 'json' }).$type<Record<string, number>>().notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.source, t.season, t.week, t.playerId] }), index('actuals_week').on(t.season, t.week)],
);

export const marketValueSnapshots = sqliteTable(
  'market_value_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    source: text('source').notNull(),
    format: text('format').notNull(), // dynasty_sf, dynasty_1qb, redraft_sf, redraft_1qb
    assetType: text('asset_type').$type<'player' | 'pick'>().notNull(),
    assetId: text('asset_id').notNull(), // sleeper_id for players, label like "2027 1st" for picks
    value: real('value').notNull(),
    rank: integer('rank'),
    extra: text('extra', { mode: 'json' }).$type<Record<string, unknown>>(),
    snapshotDate: text('snapshot_date').notNull(),
    capturedAt: integer('captured_at').notNull(),
  },
  (t) => [
    uniqueIndex('mkt_uq').on(t.source, t.format, t.assetId, t.snapshotDate),
    index('mkt_asset').on(t.assetId, t.snapshotDate),
  ],
);

export const rankingSnapshots = sqliteTable(
  'ranking_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    source: text('source').notNull(),
    profile: text('profile').notNull(), // e.g. ppr, half, sf_ppr, dynasty_sf
    expert: text('expert').notNull().default('consensus'),
    playerId: text('player_id').notNull(),
    rank: real('rank').notNull(),
    rankMin: integer('rank_min'),
    rankMax: integer('rank_max'),
    stdev: real('stdev'),
    adp: real('adp'),
    extra: text('extra', { mode: 'json' }).$type<Record<string, unknown>>(),
    snapshotDate: text('snapshot_date').notNull(),
    capturedAt: integer('captured_at').notNull(),
  },
  (t) => [
    uniqueIndex('rank_uq').on(t.source, t.profile, t.expert, t.playerId, t.snapshotDate),
    index('rank_player').on(t.playerId, t.snapshotDate),
  ],
);

export const trendingSnapshots = sqliteTable(
  'trending_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    type: text('type').$type<'add' | 'drop'>().notNull(),
    playerId: text('player_id').notNull(),
    count: integer('count').notNull(),
    snapshotDate: text('snapshot_date').notNull(),
    capturedAt: integer('captured_at').notNull(),
  },
  (t) => [uniqueIndex('trend_uq').on(t.type, t.playerId, t.snapshotDate)],
);

export const newsItems = sqliteTable(
  'news_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    source: text('source').notNull(),
    sourceNewsId: text('source_news_id').notNull(),
    playerId: text('player_id'),
    title: text('title'),
    body: text('body'),
    publishedAtMs: integer('published_at_ms'),
    meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>(),
    firstSeenAt: integer('first_seen_at').notNull(),
  },
  (t) => [uniqueIndex('news_uq').on(t.source, t.sourceNewsId), index('news_player').on(t.playerId, t.publishedAtMs)],
);

export const nflverseWeekly = sqliteTable(
  'nflverse_weekly',
  {
    season: integer('season').notNull(),
    week: integer('week').notNull(),
    gsisId: text('gsis_id').notNull(),
    playerId: text('player_id'), // resolved sleeper id, null until crosswalked
    stats: text('stats', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.season, t.week, t.gsisId] }), index('nflverse_player').on(t.playerId, t.season)],
);

export const depthCharts = sqliteTable(
  'depth_charts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    season: integer('season').notNull(),
    week: integer('week'),
    team: text('team').notNull(),
    position: text('position'),
    depthPosition: text('depth_position'),
    depthRank: integer('depth_rank'),
    gsisId: text('gsis_id'),
    fullName: text('full_name'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('depth_team').on(t.season, t.week, t.team)],
);

export const injuries = sqliteTable(
  'injuries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    season: integer('season').notNull(),
    week: integer('week'),
    team: text('team'),
    gsisId: text('gsis_id'),
    fullName: text('full_name'),
    position: text('position'),
    reportStatus: text('report_status'),
    practiceStatus: text('practice_status'),
    dateModified: text('date_modified'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('injuries_week').on(t.season, t.week)],
);

export const valuationRuns = sqliteTable('valuation_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  leagueId: text('league_id').notNull(),
  horizon: text('horizon').notNull(), // 'ros' | 'week_N' | 'season'
  ranAt: integer('ran_at').notNull(),
  config: text('config', { mode: 'json' }).$type<Record<string, unknown>>(),
  inputs: text('inputs', { mode: 'json' }).$type<Record<string, unknown>>(),
  durationMs: integer('duration_ms'),
});

export const leagueValues = sqliteTable(
  'league_values',
  {
    runId: integer('run_id').notNull(),
    playerId: text('player_id').notNull(),
    leagueId: text('league_id').notNull(),
    points: real('points').notNull(),
    components: text('components', { mode: 'json' }).$type<Record<string, number>>().notNull(),
    vorp: real('vorp'),
    tier: integer('tier'),
    posRank: integer('pos_rank'),
    auctionDollar: real('auction_dollar'),
    marketValue: real('market_value'),
    edge: real('edge'),
    quantiles: text('quantiles', { mode: 'json' }).$type<Record<string, number>>(), // distribution seam
  },
  (t) => [primaryKey({ columns: [t.runId, t.playerId] }), index('lv_league').on(t.leagueId, t.runId)],
);

// Weekly league-scored points per player, persisted at valuation time — the
// trade lab reads these instantly instead of recomputing grafted weeks (~10s).
// Invariant: SUM(pts) over weeks == league_values.points for the same
// (run_id, player_id). Also the Monte Carlo seam (samples/quantiles can key
// off the same rows later) and Phase 4's streamer-baseline raw material.
export const leagueWeeklyPoints = sqliteTable(
  'league_weekly_points',
  {
    runId: integer('run_id').notNull(),
    playerId: text('player_id').notNull(),
    week: integer('week').notNull(),
    pts: real('pts').notNull(),
    // Resampled distribution quantiles, recentered on pts (null = not sampled).
    p10: real('p10'),
    p25: real('p25'),
    p75: real('p75'),
    p90: real('p90'),
  },
  (t) => [primaryKey({ columns: [t.runId, t.playerId, t.week] })],
);

// Predictions of record: copied from the latest valuation run just before the
// week's games (Thursday freeze job) and never overwritten or pruned — the
// honest pre-game numbers that prediction-vs-actual trends score against.
export const frozenPredictions = sqliteTable(
  'frozen_predictions',
  {
    leagueId: text('league_id').notNull(),
    season: integer('season').notNull(),
    week: integer('week').notNull(),
    playerId: text('player_id').notNull(),
    pts: real('pts').notNull(),
    p10: real('p10'),
    p25: real('p25'),
    p75: real('p75'),
    p90: real('p90'),
    runId: integer('run_id').notNull(),
    frozenAt: integer('frozen_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.leagueId, t.season, t.week, t.playerId] })],
);

export const frozenTeamPredictions = sqliteTable(
  'frozen_team_predictions',
  {
    leagueId: text('league_id').notNull(),
    season: integer('season').notNull(),
    week: integer('week').notNull(),
    rosterId: integer('roster_id').notNull(),
    total: real('total').notNull(),
    p10: real('p10'),
    p90: real('p90'),
    starters: text('starters', { mode: 'json' }).$type<string[]>(),
    runId: integer('run_id').notNull(),
    frozenAt: integer('frozen_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.leagueId, t.season, t.week, t.rosterId] })],
);

// Season-sim results computed by the worker (valuation.odds job) so web
// requests read instead of running 500-world Monte Carlo on a shared vCPU.
export const seasonOddsCache = sqliteTable('season_odds_cache', {
  leagueId: text('league_id').primaryKey(),
  runId: integer('run_id').notNull(),
  payload: text('payload').notNull(), // SeasonOdds JSON
  computedAt: integer('computed_at').notNull(),
});

export const jobRuns = sqliteTable(
  'job_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobName: text('job_name').notNull(),
    source: text('source').notNull(),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
    status: text('status').$type<'ok' | 'error' | 'partial' | 'running'>().notNull(),
    items: integer('items'),
    warnings: text('warnings', { mode: 'json' }).$type<string[]>(),
    error: text('error'),
  },
  (t) => [index('jobruns_name').on(t.jobName, t.startedAt)],
);

export const sourceHealth = sqliteTable('source_health', {
  source: text('source').primaryKey(),
  lastSuccessAt: integer('last_success_at'),
  lastErrorAt: integer('last_error_at'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  staleAfterHours: integer('stale_after_hours').notNull(),
  message: text('message'),
});

export const unmatchedAssets = sqliteTable(
  'unmatched_assets',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    source: text('source').notNull(),
    sourceKey: text('source_key').notNull(),
    name: text('name').notNull(),
    pos: text('pos'),
    context: text('context'),
    // Sticky dismissal: ignored assets stay recorded (so re-ingestion doesn't
    // resurface them) but don't count as warnings or appear on /crosswalk.
    ignored: integer('ignored', { mode: 'boolean' }).notNull().default(false),
    lastSeenAt: integer('last_seen_at').notNull(),
  },
  (t) => [uniqueIndex('unmatched_uq').on(t.source, t.sourceKey)],
);

export const rawSnapshots = sqliteTable(
  'raw_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    source: text('source').notNull(),
    kind: text('kind').notNull(),
    key: text('key'),
    url: text('url'),
    capturedAt: integer('captured_at').notNull(),
    filePath: text('file_path').notNull(),
    sha256: text('sha256').notNull(),
    bytes: integer('bytes').notNull(),
    httpStatus: integer('http_status'),
    parseOk: integer('parse_ok', { mode: 'boolean' }),
  },
  (t) => [index('raw_source_kind').on(t.source, t.kind, t.capturedAt)],
);
