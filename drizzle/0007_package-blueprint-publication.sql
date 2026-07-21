-- Package publication follows source freshness (0005) and versioned category
-- evidence (0006), so existing catalogs gain provenance fences before bundles.
ALTER TABLE `package_versions` ADD `blueprint_schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `package_versions` ADD `blueprint_digest` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `package_versions` ADD `editorial_json` text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE `package_members` ADD `upstream_repository_url` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `package_members` ADD `upstream_skill_path` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `package_members` ADD `upstream_skill_name` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `package_members` ADD `observed_head` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `package_members` ADD `observed_license` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `package_members` ADD `license_evidence_class` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `package_members` ADD `license_evidence_path` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `package_members` ADD `publisher_class` text DEFAULT 'legacy' NOT NULL;
--> statement-breakpoint
UPDATE `package_versions`
SET `blueprint_schema_version` = 0,
	`blueprint_digest` = 'legacy:' || `id`,
	`editorial_json` = json_object(
		'title', COALESCE((SELECT `title` FROM `packages` WHERE `packages`.`id` = `package_versions`.`package_id`), ''),
		'summary', COALESCE((SELECT `description` FROM `packages` WHERE `packages`.`id` = `package_versions`.`package_id`), ''),
		'outcome', '',
		'audience', json('[]'),
		'category', 'uncategorized',
		'tags', json('[]'),
		'featured', json('false'),
		'reviewedAt', '',
		'visual', json_object('iconToken', 'brackets', 'colorToken', 'iris')
	)
WHERE `blueprint_digest` = '';
