CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`action` text NOT NULL,
	`detail` text,
	`ip` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_user_idx` ON `audit_log` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `auth_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`purpose` text NOT NULL,
	`challenge` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`key` text PRIMARY KEY NOT NULL,
	`failures` integer NOT NULL,
	`window_start` integer NOT NULL,
	`locked_until` integer
);
--> statement-breakpoint
CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text,
	`device_type` text,
	`backed_up` integer DEFAULT false NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `passkeys_user_idx` ON `passkeys` (`user_id`);--> statement-breakpoint
CREATE TABLE `recovery_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recovery_user_idx` ON `recovery_codes` (`user_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`method` text NOT NULL,
	`ip` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`absolute_expires_at` integer NOT NULL,
	`step_up_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`password_hash` text,
	`totp_secret_enc` text,
	`totp_pending_enc` text,
	`totp_enabled` integer DEFAULT false NOT NULL,
	`totp_last_step` integer,
	`webauthn_user_id` text NOT NULL,
	`avatar` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
-- X-UI v1 identity marker (see src/db/identity.ts). Idempotent: on Node it was written before
-- this migration ran; on D1 (wrangler d1 migrations apply) it is created here.
CREATE TABLE IF NOT EXISTS `xui_v1_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `xui_v1_meta` (`key`, `value`, `created_at`) VALUES ('db_identity', 'x-ui-product-v1', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
