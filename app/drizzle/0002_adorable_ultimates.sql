ALTER TABLE `deletion` ADD `scheduled_for` integer;--> statement-breakpoint
ALTER TABLE `deletion` ADD `cancelled_at` integer;--> statement-breakpoint
ALTER TABLE `deletion` ADD `cancelled_by` text;--> statement-breakpoint
ALTER TABLE `deletion` ADD `cancel_reason` text;--> statement-breakpoint
CREATE INDEX `deletion_state_scheduled_for_idx` ON `deletion` (`state`,`scheduled_for`);--> statement-breakpoint
CREATE INDEX `deletion_sso_state_idx` ON `deletion` (`sso_username`,`state`);