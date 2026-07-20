CREATE TABLE `audit_records` (
	`id` text PRIMARY KEY NOT NULL,
	`revision_id` text,
	`source_listing_id` text,
	`scope` text NOT NULL,
	`provider` text NOT NULL,
	`provider_slug` text,
	`status` text NOT NULL,
	`summary` text NOT NULL,
	`risk_level` text,
	`upstream_content_hash` text,
	`scanner_version` text,
	`observed_at` integer NOT NULL,
	`raw_json` text NOT NULL,
	FOREIGN KEY (`revision_id`) REFERENCES `skill_revisions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_listing_id`) REFERENCES `source_listings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `audit_records_revision_idx` ON `audit_records` (`revision_id`);--> statement-breakpoint
CREATE INDEX `audit_records_listing_idx` ON `audit_records` (`source_listing_id`);--> statement-breakpoint
CREATE INDEX `audit_records_provider_idx` ON `audit_records` (`provider`,`observed_at`);--> statement-breakpoint
CREATE TABLE `catalog_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`mode` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`upstream_identifier` text NOT NULL,
	`terms_url` text,
	`coverage_state` text DEFAULT 'not-synced' NOT NULL,
	`last_successful_sync_at` integer,
	`record_count` integer DEFAULT 0 NOT NULL,
	`unavailable_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`exclusions_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `catalog_sources_mode_idx` ON `catalog_sources` (`mode`);--> statement-breakpoint
CREATE INDEX `catalog_sources_coverage_idx` ON `catalog_sources` (`coverage_state`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`sort_order` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_slug_uidx` ON `categories` (`slug`);--> statement-breakpoint
CREATE TABLE `package_members` (
	`package_version_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`position` integer NOT NULL,
	`selected_by_default` integer DEFAULT true NOT NULL,
	PRIMARY KEY(`package_version_id`, `skill_id`),
	FOREIGN KEY (`package_version_id`) REFERENCES `package_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`revision_id`) REFERENCES `skill_revisions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `package_members_position_uidx` ON `package_members` (`package_version_id`,`position`);--> statement-breakpoint
CREATE TABLE `package_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`package_id` text NOT NULL,
	`version` integer NOT NULL,
	`published_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`package_id`) REFERENCES `packages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `package_versions_package_version_uidx` ON `package_versions` (`package_id`,`version`);--> statement-breakpoint
CREATE TABLE `packages` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`published` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `packages_slug_uidx` ON `packages` (`slug`);--> statement-breakpoint
CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`normalized_url` text NOT NULL,
	`owner` text,
	`name` text,
	`visibility` text DEFAULT 'public' NOT NULL,
	`default_branch` text,
	`last_seen_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_provider_url_uidx` ON `repositories` (`provider`,`normalized_url`);--> statement-breakpoint
CREATE INDEX `repositories_visibility_idx` ON `repositories` (`visibility`);--> statement-breakpoint
CREATE TABLE `skill_aliases` (
	`id` text PRIMARY KEY NOT NULL,
	`skill_id` text NOT NULL,
	`provider` text NOT NULL,
	`alias` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_aliases_provider_alias_uidx` ON `skill_aliases` (`provider`,`alias`);--> statement-breakpoint
CREATE TABLE `skill_categories` (
	`skill_id` text NOT NULL,
	`category_id` text NOT NULL,
	`attribution` text DEFAULT 'aisle' NOT NULL,
	PRIMARY KEY(`skill_id`, `category_id`),
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `skill_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`skill_id` text NOT NULL,
	`immutable_ref` text NOT NULL,
	`content_hash` text NOT NULL,
	`upstream_hash` text,
	`install_url` text NOT NULL,
	`license` text DEFAULT 'unknown' NOT NULL,
	`metadata_json` text,
	`is_current` integer DEFAULT false NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_revisions_skill_ref_uidx` ON `skill_revisions` (`skill_id`,`immutable_ref`);--> statement-breakpoint
CREATE INDEX `skill_revisions_content_hash_idx` ON `skill_revisions` (`content_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `skill_revisions_one_current_uidx` ON `skill_revisions` (`skill_id`) WHERE "skill_revisions"."is_current" = 1;--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`canonical_key` text NOT NULL,
	`provider` text NOT NULL,
	`repository_id` text,
	`source_url` text NOT NULL,
	`skill_path` text NOT NULL,
	`upstream_name` text NOT NULL,
	`upstream_description` text,
	`compatibility` text,
	`license` text DEFAULT 'unknown' NOT NULL,
	`lifecycle` text DEFAULT 'current' NOT NULL,
	`public` integer DEFAULT true NOT NULL,
	`internal` integer DEFAULT false NOT NULL,
	`official_provenance` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skills_canonical_key_uidx` ON `skills` (`canonical_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `skills_provider_source_path_uidx` ON `skills` (`provider`,`source_url`,`skill_path`);--> statement-breakpoint
CREATE INDEX `skills_name_idx` ON `skills` (`upstream_name`);--> statement-breakpoint
CREATE INDEX `skills_lifecycle_public_idx` ON `skills` (`lifecycle`,`public`,`internal`);--> statement-breakpoint
CREATE INDEX `skills_repository_idx` ON `skills` (`repository_id`);--> statement-breakpoint
CREATE TABLE `source_listings` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`upstream_id` text NOT NULL,
	`skill_id` text,
	`source_type` text NOT NULL,
	`install_url` text,
	`source_hash` text,
	`installs` integer DEFAULT 0 NOT NULL,
	`duplicate_indicator` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'unresolved' NOT NULL,
	`raw_json` text NOT NULL,
	`last_seen_run_id` text,
	`missed_complete_crawls` integer DEFAULT 0 NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `catalog_sources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`last_seen_run_id`) REFERENCES `sync_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_listings_source_upstream_uidx` ON `source_listings` (`source_id`,`upstream_id`);--> statement-breakpoint
CREATE INDEX `source_listings_skill_idx` ON `source_listings` (`skill_id`);--> statement-breakpoint
CREATE INDEX `source_listings_status_idx` ON `source_listings` (`status`);--> statement-breakpoint
CREATE INDEX `source_listings_hash_idx` ON `source_listings` (`source_hash`);--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`cursor` text,
	`next_page` integer DEFAULT 0 NOT NULL,
	`page_count` integer DEFAULT 0 NOT NULL,
	`source_total` integer,
	`processed_count` integer DEFAULT 0 NOT NULL,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`next_retry_at` integer,
	`failure` text,
	`complete_crawl` integer DEFAULT false NOT NULL,
	`checkpoint_json` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `catalog_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sync_runs_source_started_idx` ON `sync_runs` (`source_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `sync_runs_status_idx` ON `sync_runs` (`status`);--> statement-breakpoint
CREATE TABLE `trust_assessments` (
	`id` text PRIMARY KEY NOT NULL,
	`revision_id` text NOT NULL,
	`scanner` text NOT NULL,
	`scanner_version` text NOT NULL,
	`state` text NOT NULL,
	`quarantine_reason` text,
	`scanned_at` integer NOT NULL,
	FOREIGN KEY (`revision_id`) REFERENCES `skill_revisions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trust_assessments_revision_scanner_uidx` ON `trust_assessments` (`revision_id`,`scanner`);--> statement-breakpoint
CREATE INDEX `trust_assessments_state_idx` ON `trust_assessments` (`state`);--> statement-breakpoint
CREATE TABLE `trust_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`assessment_id` text NOT NULL,
	`code` text NOT NULL,
	`severity` text NOT NULL,
	`path` text,
	`message` text NOT NULL,
	`evidence` text,
	FOREIGN KEY (`assessment_id`) REFERENCES `trust_assessments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `trust_findings_assessment_idx` ON `trust_findings` (`assessment_id`);