CREATE TABLE `depth_charts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season` integer NOT NULL,
	`week` integer,
	`team` text NOT NULL,
	`position` text,
	`depth_position` text,
	`depth_rank` integer,
	`gsis_id` text,
	`full_name` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `depth_team` ON `depth_charts` (`season`,`week`,`team`);--> statement-breakpoint
CREATE TABLE `draft_picks` (
	`draft_id` text NOT NULL,
	`pick_no` integer NOT NULL,
	`round` integer,
	`draft_slot` integer,
	`roster_id` integer,
	`player_id` text,
	`amount` integer,
	`is_keeper` integer,
	`metadata` text,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`draft_id`, `pick_no`)
);
--> statement-breakpoint
CREATE TABLE `drafts` (
	`draft_id` text PRIMARY KEY NOT NULL,
	`league_id` text,
	`season` integer,
	`type` text,
	`status` text,
	`start_time_ms` integer,
	`settings` text,
	`metadata` text,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `injuries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season` integer NOT NULL,
	`week` integer,
	`team` text,
	`gsis_id` text,
	`full_name` text,
	`position` text,
	`report_status` text,
	`practice_status` text,
	`date_modified` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `injuries_week` ON `injuries` (`season`,`week`);--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_name` text NOT NULL,
	`source` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	`items` integer,
	`warnings` text,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `jobruns_name` ON `job_runs` (`job_name`,`started_at`);--> statement-breakpoint
CREATE TABLE `league_users` (
	`league_id` text NOT NULL,
	`user_id` text NOT NULL,
	`display_name` text,
	`team_name` text,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`league_id`, `user_id`)
);
--> statement-breakpoint
CREATE TABLE `league_values` (
	`run_id` integer NOT NULL,
	`player_id` text NOT NULL,
	`league_id` text NOT NULL,
	`points` real NOT NULL,
	`components` text NOT NULL,
	`vorp` real,
	`tier` integer,
	`pos_rank` integer,
	`auction_dollar` real,
	`market_value` real,
	`edge` real,
	`quantiles` text,
	PRIMARY KEY(`run_id`, `player_id`)
);
--> statement-breakpoint
CREATE INDEX `lv_league` ON `league_values` (`league_id`,`run_id`);--> statement-breakpoint
CREATE TABLE `leagues` (
	`league_id` text PRIMARY KEY NOT NULL,
	`season` integer NOT NULL,
	`name` text NOT NULL,
	`status` text,
	`total_rosters` integer,
	`scoring_settings` text NOT NULL,
	`roster_positions` text NOT NULL,
	`settings` text NOT NULL,
	`scoring_hash` text NOT NULL,
	`previous_league_id` text,
	`draft_id` text,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `market_value_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`format` text NOT NULL,
	`asset_type` text NOT NULL,
	`asset_id` text NOT NULL,
	`value` real NOT NULL,
	`rank` integer,
	`extra` text,
	`snapshot_date` text NOT NULL,
	`captured_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mkt_uq` ON `market_value_snapshots` (`source`,`format`,`asset_id`,`snapshot_date`);--> statement-breakpoint
CREATE INDEX `mkt_asset` ON `market_value_snapshots` (`asset_id`,`snapshot_date`);--> statement-breakpoint
CREATE TABLE `matchups` (
	`league_id` text NOT NULL,
	`week` integer NOT NULL,
	`roster_id` integer NOT NULL,
	`matchup_id` integer,
	`points` real,
	`players_points` text,
	`starters` text,
	`player_ids` text,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`league_id`, `week`, `roster_id`)
);
--> statement-breakpoint
CREATE TABLE `news_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`source_news_id` text NOT NULL,
	`player_id` text,
	`title` text,
	`body` text,
	`published_at_ms` integer,
	`meta` text,
	`first_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `news_uq` ON `news_items` (`source`,`source_news_id`);--> statement-breakpoint
CREATE INDEX `news_player` ON `news_items` (`player_id`,`published_at_ms`);--> statement-breakpoint
CREATE TABLE `nflverse_weekly` (
	`season` integer NOT NULL,
	`week` integer NOT NULL,
	`gsis_id` text NOT NULL,
	`player_id` text,
	`stats` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`season`, `week`, `gsis_id`)
);
--> statement-breakpoint
CREATE INDEX `nflverse_player` ON `nflverse_weekly` (`player_id`,`season`);--> statement-breakpoint
CREATE TABLE `player_id_map` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`source_id` text NOT NULL,
	`sleeper_id` text NOT NULL,
	`method` text NOT NULL,
	`confidence` real,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idmap_source_sourceid` ON `player_id_map` (`source`,`source_id`);--> statement-breakpoint
CREATE INDEX `idmap_sleeper` ON `player_id_map` (`sleeper_id`);--> statement-breakpoint
CREATE TABLE `players` (
	`sleeper_id` text PRIMARY KEY NOT NULL,
	`full_name` text NOT NULL,
	`search_name` text NOT NULL,
	`pos` text,
	`team` text,
	`status` text,
	`injury_status` text,
	`meta` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `players_pos_team` ON `players` (`pos`,`team`);--> statement-breakpoint
CREATE INDEX `players_search` ON `players` (`search_name`);--> statement-breakpoint
CREATE TABLE `projection_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`season` integer NOT NULL,
	`week` integer NOT NULL,
	`player_id` text NOT NULL,
	`stats` text NOT NULL,
	`stats_hash` text NOT NULL,
	`snapshot_date` text NOT NULL,
	`captured_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proj_uq` ON `projection_snapshots` (`source`,`season`,`week`,`player_id`,`snapshot_date`);--> statement-breakpoint
CREATE INDEX `proj_player` ON `projection_snapshots` (`player_id`,`season`,`snapshot_date`);--> statement-breakpoint
CREATE INDEX `proj_board` ON `projection_snapshots` (`source`,`season`,`week`,`snapshot_date`);--> statement-breakpoint
CREATE TABLE `ranking_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`profile` text NOT NULL,
	`expert` text DEFAULT 'consensus' NOT NULL,
	`player_id` text NOT NULL,
	`rank` real NOT NULL,
	`rank_min` integer,
	`rank_max` integer,
	`stdev` real,
	`adp` real,
	`extra` text,
	`snapshot_date` text NOT NULL,
	`captured_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rank_uq` ON `ranking_snapshots` (`source`,`profile`,`expert`,`player_id`,`snapshot_date`);--> statement-breakpoint
CREATE INDEX `rank_player` ON `ranking_snapshots` (`player_id`,`snapshot_date`);--> statement-breakpoint
CREATE TABLE `raw_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`kind` text NOT NULL,
	`key` text,
	`url` text,
	`captured_at` integer NOT NULL,
	`file_path` text NOT NULL,
	`sha256` text NOT NULL,
	`bytes` integer NOT NULL,
	`http_status` integer,
	`parse_ok` integer
);
--> statement-breakpoint
CREATE INDEX `raw_source_kind` ON `raw_snapshots` (`source`,`kind`,`captured_at`);--> statement-breakpoint
CREATE TABLE `rosters` (
	`league_id` text NOT NULL,
	`roster_id` integer NOT NULL,
	`owner_id` text,
	`player_ids` text,
	`starters` text,
	`reserve` text,
	`taxi` text,
	`settings` text,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`league_id`, `roster_id`)
);
--> statement-breakpoint
CREATE TABLE `source_health` (
	`source` text PRIMARY KEY NOT NULL,
	`last_success_at` integer,
	`last_error_at` integer,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`stale_after_hours` integer NOT NULL,
	`message` text
);
--> statement-breakpoint
CREATE TABLE `stat_actuals` (
	`source` text NOT NULL,
	`season` integer NOT NULL,
	`week` integer NOT NULL,
	`player_id` text NOT NULL,
	`stats` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`source`, `season`, `week`, `player_id`)
);
--> statement-breakpoint
CREATE INDEX `actuals_week` ON `stat_actuals` (`season`,`week`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`league_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`week` integer,
	`type` text,
	`status` text,
	`roster_ids` text,
	`adds` text,
	`drops` text,
	`faab_bid` integer,
	`metadata` text,
	`created_at_ms` integer,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`league_id`, `transaction_id`)
);
--> statement-breakpoint
CREATE INDEX `tx_league_week` ON `transactions` (`league_id`,`week`);--> statement-breakpoint
CREATE TABLE `trending_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`player_id` text NOT NULL,
	`count` integer NOT NULL,
	`snapshot_date` text NOT NULL,
	`captured_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trend_uq` ON `trending_snapshots` (`type`,`player_id`,`snapshot_date`);--> statement-breakpoint
CREATE TABLE `valuation_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`league_id` text NOT NULL,
	`horizon` text NOT NULL,
	`ran_at` integer NOT NULL,
	`config` text,
	`inputs` text,
	`duration_ms` integer
);
