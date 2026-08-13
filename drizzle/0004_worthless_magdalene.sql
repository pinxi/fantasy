CREATE TABLE `league_weekly_points` (
	`run_id` integer NOT NULL,
	`player_id` text NOT NULL,
	`week` integer NOT NULL,
	`pts` real NOT NULL,
	PRIMARY KEY(`run_id`, `player_id`, `week`)
);
