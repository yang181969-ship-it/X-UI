ALTER TABLE `trades` ADD `cash_account_id` text;--> statement-breakpoint
ALTER TABLE `users` ADD `avatar` text;--> statement-breakpoint
-- Until now the cash leg was booked in the trade's own account: record that as the cash account.
UPDATE `trades` SET `cash_account_id` = `account_id` WHERE `transaction_id` IS NOT NULL;
