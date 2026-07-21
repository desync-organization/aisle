ALTER TABLE `catalog_sources`
ADD COLUMN `freshness_policy` text DEFAULT 'retain' NOT NULL;
--> statement-breakpoint
ALTER TABLE `sync_runs`
ADD COLUMN `observation_sweep_complete` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `source_listings`
ADD COLUMN `last_completed_observation_run_id` text;
--> statement-breakpoint
CREATE INDEX `source_listings_freshness_idx`
ON `source_listings` (`source_id`, `last_completed_observation_run_id`);
--> statement-breakpoint
UPDATE `catalog_sources`
SET `freshness_policy` = 'latest-completed-observation'
WHERE `id` = 'clawhub';
