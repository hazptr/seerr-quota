ALTER TABLE `member` ADD `login_alias` text;--> statement-breakpoint
CREATE UNIQUE INDEX `member_login_alias_unique_idx` ON `member` (`login_alias`);