CREATE TABLE `collection_members` (
	`collection_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`position` integer NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`collection_id`, `skill_id`),
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collection_members_position_uidx` ON `collection_members` (`collection_id`,`position`);--> statement-breakpoint
CREATE INDEX `collection_members_skill_idx` ON `collection_members` (`skill_id`);--> statement-breakpoint
CREATE TABLE `collections` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`owner_kind` text DEFAULT 'anonymous' NOT NULL,
	`owner_account_id` text,
	`owner_token_hash` text,
	`public` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collections_slug_uidx` ON `collections` (`slug`);--> statement-breakpoint
CREATE INDEX `collections_public_updated_idx` ON `collections` (`public`,`updated_at`);--> statement-breakpoint
CREATE INDEX `collections_owner_account_idx` ON `collections` (`owner_account_id`);