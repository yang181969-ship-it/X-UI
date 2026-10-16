CREATE TABLE `account_currencies` (
	`account_id` text NOT NULL,
	`user_id` text NOT NULL,
	`currency` text NOT NULL,
	`opening_balance` integer DEFAULT 0 NOT NULL,
	`include_in_total` integer DEFAULT true NOT NULL,
	`balance` integer DEFAULT 0 NOT NULL,
	`tx_count` integer DEFAULT 0 NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`account_id`, `currency`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `acc_cur_user_idx` ON `account_currencies` (`user_id`);--> statement-breakpoint
CREATE TABLE `fx_rates` (
	`currency` text PRIMARY KEY NOT NULL,
	`per_usd` real NOT NULL,
	`as_of` text NOT NULL,
	`source` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `securities` (
	`symbol` text PRIMARY KEY NOT NULL,
	`name` text,
	`currency` text DEFAULT 'USD' NOT NULL,
	`price_micros` integer,
	`price_at` integer,
	`source` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trades` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text,
	`symbol` text NOT NULL,
	`side` text NOT NULL,
	`quantity_micros` integer NOT NULL,
	`price_micros` integer NOT NULL,
	`amount` integer NOT NULL,
	`fee` integer DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`trade_date` text NOT NULL,
	`transaction_id` text,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `trades_user_idx` ON `trades` (`user_id`,`symbol`,`trade_date`);--> statement-breakpoint
DROP INDEX `tx_account_idx`;--> statement-breakpoint
ALTER TABLE `transactions` ADD `currency` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `tx_account_idx` ON `transactions` (`account_id`,`currency`);--> statement-breakpoint
ALTER TABLE `cards` ADD `form` text DEFAULT 'physical' NOT NULL;--> statement-breakpoint
ALTER TABLE `cards` ADD `parent_card_id` text;--> statement-breakpoint
ALTER TABLE `cards` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `cards` ADD `spend_limit` integer;--> statement-breakpoint
ALTER TABLE `cards` ADD `limit_period` text;--> statement-breakpoint
ALTER TABLE `cards` ADD `single_use` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `cards` ADD `merchant` text;--> statement-breakpoint
ALTER TABLE `cards` ADD `bin_info` text;--> statement-breakpoint
ALTER TABLE `credit_statements` ADD `currency` text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Data carried over from the single-currency schema.
UPDATE `transactions` SET `currency` = (SELECT `accounts`.`currency` FROM `accounts` WHERE `accounts`.`id` = `transactions`.`account_id`) WHERE `currency` = '';--> statement-breakpoint
INSERT INTO `account_currencies` (`account_id`, `user_id`, `currency`, `opening_balance`, `include_in_total`, `balance`, `tx_count`, `sort`) SELECT `a`.`id`, `a`.`user_id`, `a`.`currency`, `a`.`opening_balance`, 1, `a`.`opening_balance` + coalesce((SELECT sum(`t`.`amount`) FROM `transactions` `t` WHERE `t`.`account_id` = `a`.`id`), 0), (SELECT count(*) FROM `transactions` `t` WHERE `t`.`account_id` = `a`.`id`), 0 FROM `accounts` `a`;--> statement-breakpoint
UPDATE `credit_statements` SET `currency` = (SELECT `a`.`currency` FROM `cards` `c` JOIN `accounts` `a` ON `a`.`id` = `c`.`account_id` WHERE `c`.`id` = `credit_statements`.`card_id`) WHERE `currency` = '';--> statement-breakpoint
UPDATE `bills` SET `kind` = 'subscription' WHERE `kind` <> 'once';--> statement-breakpoint
UPDATE `cards` SET `bin` = substr(`bin`, 1, 6) WHERE length(`bin`) > 6;--> statement-breakpoint
ALTER TABLE `accounts` DROP COLUMN `opening_balance`;
