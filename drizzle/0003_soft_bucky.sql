ALTER TABLE `skill_revisions` ADD `install_spec_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `skill_revisions_id_skill_uidx` ON `skill_revisions` (`id`,`skill_id`);--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `lease_token` text;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `lease_expires_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `sync_runs_one_running_per_source_uidx` ON `sync_runs` (`source_id`) WHERE "sync_runs"."status" = 'running';--> statement-breakpoint
ALTER TABLE `trust_assessments` ADD `immutable_ref` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `trust_assessments` ADD `content_hash` text DEFAULT '' NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_package_members` (
	`package_version_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`position` integer NOT NULL,
	`selected_by_default` integer DEFAULT true NOT NULL,
	PRIMARY KEY(`package_version_id`, `skill_id`),
	FOREIGN KEY (`package_version_id`) REFERENCES `package_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`revision_id`) REFERENCES `skill_revisions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`revision_id`,`skill_id`) REFERENCES `skill_revisions`(`id`,`skill_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_package_members`("package_version_id", "skill_id", "revision_id", "position", "selected_by_default") SELECT "package_version_id", "skill_id", "revision_id", "position", "selected_by_default" FROM `package_members`;--> statement-breakpoint
DROP TABLE `package_members`;--> statement-breakpoint
ALTER TABLE `__new_package_members` RENAME TO `package_members`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `package_members_position_uidx` ON `package_members` (`package_version_id`,`position`);