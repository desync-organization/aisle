CREATE UNIQUE INDEX `source_listings_id_skill_uidx`
ON `source_listings` (`id`, `skill_id`);
--> statement-breakpoint
CREATE TABLE `skill_category_observations` (
	`source_listing_id` text NOT NULL,
	`observed_run_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`source_hash` text NOT NULL,
	`observed_at` integer NOT NULL,
	PRIMARY KEY(`source_listing_id`, `observed_run_id`),
	FOREIGN KEY (`source_listing_id`, `skill_id`) REFERENCES `source_listings`(`id`, `skill_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`revision_id`, `skill_id`) REFERENCES `skill_revisions`(`id`, `skill_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`observed_run_id`) REFERENCES `sync_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `skill_category_observations_skill_idx`
ON `skill_category_observations` (`skill_id`);
--> statement-breakpoint
CREATE INDEX `skill_category_observations_run_idx`
ON `skill_category_observations` (`observed_run_id`);
--> statement-breakpoint
CREATE TABLE `skill_category_evidence` (
	`source_listing_id` text NOT NULL,
	`observed_run_id` text NOT NULL,
	`category_id` text NOT NULL,
	PRIMARY KEY(`source_listing_id`, `observed_run_id`, `category_id`),
	FOREIGN KEY (`source_listing_id`, `observed_run_id`) REFERENCES `skill_category_observations`(`source_listing_id`, `observed_run_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `skill_category_evidence_listing_idx`
ON `skill_category_evidence` (`source_listing_id`);
--> statement-breakpoint
DELETE FROM `skill_categories`
WHERE `attribution` = 'aisle:source-metadata-v1';
