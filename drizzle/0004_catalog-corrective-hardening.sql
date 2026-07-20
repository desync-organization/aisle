CREATE TABLE `package_member_quarantines` (
	`id` text PRIMARY KEY NOT NULL,
	`package_version_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`position` integer NOT NULL,
	`selected_by_default` integer NOT NULL,
	`reason` text NOT NULL,
	`quarantined_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `package_member_quarantines_version_idx` ON `package_member_quarantines` (`package_version_id`);
--> statement-breakpoint
DROP INDEX IF EXISTS `sync_runs_one_running_per_source_uidx`;
--> statement-breakpoint
UPDATE `sync_runs`
SET `status` = 'partial',
	`failure` = 'Superseded duplicate running sync during lease hardening',
	`finished_at` = COALESCE(`finished_at`, `started_at`),
	`lease_token` = NULL,
	`lease_expires_at` = NULL
WHERE `status` = 'running'
	AND EXISTS (
		SELECT 1 FROM `sync_runs` AS `newer`
		WHERE `newer`.`source_id` = `sync_runs`.`source_id`
			AND `newer`.`status` = 'running'
			AND (
				`newer`.`started_at` > `sync_runs`.`started_at`
				OR (
					`newer`.`started_at` = `sync_runs`.`started_at`
					AND `newer`.`id` > `sync_runs`.`id`
				)
			)
	);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_runs_one_running_per_source_uidx`
	ON `sync_runs` (`source_id`) WHERE `sync_runs`.`status` = 'running';
--> statement-breakpoint
UPDATE `trust_assessments`
SET `immutable_ref` = COALESCE((
		SELECT `skill_revisions`.`immutable_ref`
		FROM `skill_revisions`
		WHERE `skill_revisions`.`id` = `trust_assessments`.`revision_id`
	), ''),
	`content_hash` = COALESCE((
		SELECT `skill_revisions`.`content_hash`
		FROM `skill_revisions`
		WHERE `skill_revisions`.`id` = `trust_assessments`.`revision_id`
	), '');
--> statement-breakpoint
UPDATE `skill_revisions` SET `upstream_hash` = NULL;
--> statement-breakpoint
UPDATE `trust_assessments`
SET `state` = 'unreviewed',
	`quarantine_reason` = 'Legacy provider-hash binding invalidated after a latest failing upstream observation'
WHERE `revision_id` IN (
	SELECT `skill_revisions`.`id`
	FROM `skill_revisions`
	INNER JOIN `source_listings`
		ON `source_listings`.`skill_id` = `skill_revisions`.`skill_id`
	INNER JOIN `audit_records`
		ON `audit_records`.`source_listing_id` = `source_listings`.`id`
	WHERE `audit_records`.`scope` = 'observation'
		AND `audit_records`.`status` = 'fail'
		AND NOT EXISTS (
			SELECT 1 FROM `audit_records` AS `newer`
			WHERE `newer`.`source_listing_id` = `audit_records`.`source_listing_id`
				AND `newer`.`provider` = `audit_records`.`provider`
				AND COALESCE(`newer`.`provider_slug`, '') = COALESCE(`audit_records`.`provider_slug`, '')
				AND COALESCE(`newer`.`upstream_content_hash`, '') = COALESCE(`audit_records`.`upstream_content_hash`, '')
				AND (
					`newer`.`observed_at` > `audit_records`.`observed_at`
					OR (
						`newer`.`observed_at` = `audit_records`.`observed_at`
						AND `newer`.`id` > `audit_records`.`id`
					)
				)
		)
);
--> statement-breakpoint
UPDATE `trust_assessments`
SET `state` = 'unreviewed',
	`quarantine_reason` = 'Legacy trust invalidated until a valid immutable install specification is rehydrated'
WHERE `revision_id` IN (
	SELECT `id`
	FROM `skill_revisions`
	WHERE CASE
		WHEN json_valid(`install_spec_json`) = 0 THEN 1
		WHEN json_extract(`install_spec_json`, '$.kind') = 'source' THEN NOT (
			json_type(`install_spec_json`, '$.sourceUrl') = 'text'
			AND length(trim(json_extract(`install_spec_json`, '$.sourceUrl'))) > 0
			AND json_type(`install_spec_json`, '$.immutableRef') = 'text'
			AND length(trim(json_extract(`install_spec_json`, '$.immutableRef'))) > 0
			AND json_type(`install_spec_json`, '$.skillPath') = 'text'
			AND length(trim(json_extract(`install_spec_json`, '$.skillPath'))) > 0
		)
		WHEN json_extract(`install_spec_json`, '$.kind') = 'registry' THEN NOT (
			json_type(`install_spec_json`, '$.registry') = 'text'
			AND length(trim(json_extract(`install_spec_json`, '$.registry'))) > 0
			AND json_type(`install_spec_json`, '$.identifier') = 'text'
			AND length(trim(json_extract(`install_spec_json`, '$.identifier'))) > 0
			AND json_type(`install_spec_json`, '$.version') = 'text'
			AND length(trim(json_extract(`install_spec_json`, '$.version'))) > 0
		)
		ELSE 1
	END
);
--> statement-breakpoint
INSERT INTO `package_member_quarantines` (
	`id`,
	`package_version_id`,
	`skill_id`,
	`revision_id`,
	`position`,
	`selected_by_default`,
	`reason`,
	`quarantined_at`
)
SELECT
	`package_version_id` || ':' || `skill_id` || ':' || `revision_id`,
	`package_version_id`,
	`skill_id`,
	`revision_id`,
	`position`,
	`selected_by_default`,
	'Revision does not belong to the package member skill',
	unixepoch('now') * 1000
FROM `package_members`
WHERE NOT EXISTS (
	SELECT 1 FROM `skill_revisions`
	WHERE `skill_revisions`.`id` = `package_members`.`revision_id`
		AND `skill_revisions`.`skill_id` = `package_members`.`skill_id`
);
--> statement-breakpoint
UPDATE `package_versions`
SET `published_at` = NULL
WHERE `id` IN (
	SELECT `package_version_id` FROM `package_member_quarantines`
);
--> statement-breakpoint
UPDATE `packages`
SET `published` = false,
	`updated_at` = unixepoch('now') * 1000
WHERE `id` IN (
	SELECT `package_versions`.`package_id`
	FROM `package_versions`
	INNER JOIN `package_member_quarantines`
		ON `package_member_quarantines`.`package_version_id` = `package_versions`.`id`
);
--> statement-breakpoint
DELETE FROM `package_members`
WHERE NOT EXISTS (
	SELECT 1 FROM `skill_revisions`
	WHERE `skill_revisions`.`id` = `package_members`.`revision_id`
		AND `skill_revisions`.`skill_id` = `package_members`.`skill_id`
);
