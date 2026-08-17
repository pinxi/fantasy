CREATE TABLE `season_odds_cache` (
	`league_id` text PRIMARY KEY NOT NULL,
	`run_id` integer NOT NULL,
	`payload` text NOT NULL,
	`computed_at` integer NOT NULL
);
