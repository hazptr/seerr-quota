CREATE TABLE `app_setting` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`actor` text NOT NULL,
	`actor_role` text NOT NULL,
	`on_behalf_of` text,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`before` text,
	`after` text,
	`outcome` text NOT NULL,
	`detail` text,
	`source` text NOT NULL,
	`correlation_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_ts_idx` ON `audit` (`ts`);--> statement-breakpoint
CREATE INDEX `audit_actor_idx` ON `audit` (`actor`);--> statement-breakpoint
CREATE INDEX `audit_action_idx` ON `audit` (`action`);--> statement-breakpoint
CREATE INDEX `audit_target_id_idx` ON `audit` (`target_id`);--> statement-breakpoint
CREATE INDEX `audit_correlation_id_idx` ON `audit` (`correlation_id`);--> statement-breakpoint
CREATE TABLE `claim` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title_id` text NOT NULL,
	`sso_username` text NOT NULL,
	`seerr_request_id` integer,
	`charged_bytes` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`released_at` integer,
	`released_by` text,
	FOREIGN KEY (`title_id`) REFERENCES `title`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sso_username`) REFERENCES `member`(`sso_username`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `claim_sso_active_idx` ON `claim` (`sso_username`,`active`);--> statement-breakpoint
CREATE INDEX `claim_title_active_idx` ON `claim` (`title_id`,`active`);--> statement-breakpoint
CREATE UNIQUE INDEX `claim_title_sso_active_unique` ON `claim` (`title_id`,`sso_username`) WHERE "claim"."active" = 1;--> statement-breakpoint
CREATE TABLE `deletion` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sso_username` text NOT NULL,
	`title_id` text NOT NULL,
	`mode` text NOT NULL,
	`state` text NOT NULL,
	`bytes_claimed` integer NOT NULL,
	`bytes_freed` integer,
	`arr_call` text,
	`arr_status` integer,
	`error` text,
	`requested_at` integer NOT NULL,
	`executed_at` integer,
	FOREIGN KEY (`title_id`) REFERENCES `title`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `member` (
	`sso_username` text PRIMARY KEY NOT NULL,
	`authentik_uuid` text,
	`display_name` text,
	`email` text,
	`entitled` integer DEFAULT false NOT NULL,
	`is_operator` integer DEFAULT false NOT NULL,
	`seerr_user_id` integer,
	`jellyfin_user_id` text,
	`sync_status` text DEFAULT 'no_seerr_account' NOT NULL,
	`last_hold_notified_at` integer,
	`sync_note` text,
	`first_seen_at` integer NOT NULL,
	`last_synced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `playback` (
	`title_id` text NOT NULL,
	`jellyfin_user_id` text NOT NULL,
	`play_count` integer DEFAULT 0 NOT NULL,
	`played` integer DEFAULT false NOT NULL,
	`position_ticks` integer DEFAULT 0 NOT NULL,
	`episodes_played` integer,
	`episodes_total` integer,
	`last_played_at` integer,
	`last_synced_at` integer NOT NULL,
	PRIMARY KEY(`title_id`, `jellyfin_user_id`),
	FOREIGN KEY (`title_id`) REFERENCES `title`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `quota_policy` (
	`sso_username` text PRIMARY KEY NOT NULL,
	`quota_bytes` integer,
	`source` text DEFAULT 'default' NOT NULL,
	`note` text,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `request_decision` (
	`seerr_request_id` integer PRIMARY KEY NOT NULL,
	`sso_username` text NOT NULL,
	`decision` text NOT NULL,
	`reason` text NOT NULL,
	`enforced` integer DEFAULT true NOT NULL,
	`usage_bytes` integer,
	`quota_bytes` integer,
	`source` text NOT NULL,
	`seerr_status` integer,
	`held_since` integer,
	`notified_at` integer,
	`decided_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_run` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`steps` text DEFAULT '{}' NOT NULL,
	`ok` integer
);
--> statement-breakpoint
CREATE TABLE `title` (
	`id` text PRIMARY KEY NOT NULL,
	`media_type` text NOT NULL,
	`arr_instance` text NOT NULL,
	`arr_id` integer NOT NULL,
	`tmdb_id` integer,
	`tvdb_id` integer,
	`title` text NOT NULL,
	`year` integer,
	`size_bytes` integer NOT NULL,
	`path` text NOT NULL,
	`added_at` integer,
	`protected` integer DEFAULT false NOT NULL,
	`protected_reason` text,
	`watched_by_anyone` integer DEFAULT false NOT NULL,
	`last_played_any_at` integer,
	`last_synced_at` integer NOT NULL
);
