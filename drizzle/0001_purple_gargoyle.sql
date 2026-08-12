CREATE TABLE `unmatched_assets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`source_key` text NOT NULL,
	`name` text NOT NULL,
	`pos` text,
	`context` text,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `unmatched_uq` ON `unmatched_assets` (`source`,`source_key`);