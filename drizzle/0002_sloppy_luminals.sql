ALTER TABLE `draft_picks` ADD `picked_by` text;--> statement-breakpoint
ALTER TABLE `drafts` ADD `draft_order` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `traded_picks` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `waiver_budget` text;