ALTER TABLE `package_versions` ADD `blueprint_schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `package_versions` ADD `blueprint_digest` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `package_versions` ADD `editorial_json` text DEFAULT '{}' NOT NULL;
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
