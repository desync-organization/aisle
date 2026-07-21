CREATE TABLE `skill_duplicates` (
	`skill_id` text PRIMARY KEY NOT NULL,
	`duplicate_of_skill_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`detected_at` integer NOT NULL,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`duplicate_of_skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `skill_duplicates_canonical_idx` ON `skill_duplicates` (`duplicate_of_skill_id`);