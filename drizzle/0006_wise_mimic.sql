CREATE TABLE `frozen_predictions` (
	`league_id` text NOT NULL,
	`season` integer NOT NULL,
	`week` integer NOT NULL,
	`player_id` text NOT NULL,
	`pts` real NOT NULL,
	`p10` real,
	`p25` real,
	`p75` real,
	`p90` real,
	`run_id` integer NOT NULL,
	`frozen_at` integer NOT NULL,
	PRIMARY KEY(`league_id`, `season`, `week`, `player_id`)
);
--> statement-breakpoint
CREATE TABLE `frozen_team_predictions` (
	`league_id` text NOT NULL,
	`season` integer NOT NULL,
	`week` integer NOT NULL,
	`roster_id` integer NOT NULL,
	`total` real NOT NULL,
	`p10` real,
	`p90` real,
	`starters` text,
	`run_id` integer NOT NULL,
	`frozen_at` integer NOT NULL,
	PRIMARY KEY(`league_id`, `season`, `week`, `roster_id`)
);
