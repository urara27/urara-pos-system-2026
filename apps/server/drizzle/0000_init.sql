CREATE TABLE `audit_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`action` text NOT NULL,
	`employee_id` integer,
	`device_id` integer,
	`target_type` text,
	`target_id` text,
	`before` text,
	`after` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_logs_created_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE TABLE `business_days` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`opened_at` integer NOT NULL,
	`closed_at` integer,
	`closed_by` text,
	`closed_by_employee_id` integer,
	FOREIGN KEY (`closed_by_employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `business_days_date_unique` ON `business_days` (`date`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `counters` (
	`key` text PRIMARY KEY NOT NULL,
	`value` integer NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `devices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`token_hash` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`paired_at` integer NOT NULL,
	`last_seen_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_token_hash_unique` ON `devices` (`token_hash`);--> statement-breakpoint
CREATE TABLE `discounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`value` integer NOT NULL,
	`scope` text NOT NULL,
	`valid_from` integer,
	`valid_to` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `employees` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`pin_hash` text NOT NULL,
	`password_hash` text,
	`role` text DEFAULT 'staff' NOT NULL,
	`can_manual_discount` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `employees_code_unique` ON `employees` (`code`);--> statement-breakpoint
CREATE TABLE `option_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`selection` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `options` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_id` integer NOT NULL,
	`name` text NOT NULL,
	`kitchen_name` text DEFAULT '' NOT NULL,
	`price_delta` integer DEFAULT 0 NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`station` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`sold_out` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `option_groups`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `options_group_idx` ON `options` (`group_id`);--> statement-breakpoint
CREATE TABLE `order_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`type` text NOT NULL,
	`from_status` text,
	`to_status` text,
	`station` text,
	`device_id` integer,
	`employee_id` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `order_events_order_idx` ON `order_events` (`order_id`);--> statement-breakpoint
CREATE TABLE `order_station_status` (
	`order_id` integer NOT NULL,
	`station` text NOT NULL,
	`has_items` integer NOT NULL,
	`completed_at` integer,
	PRIMARY KEY(`order_id`, `station`),
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`transaction_id` integer NOT NULL,
	`business_day_id` integer NOT NULL,
	`order_number` integer NOT NULL,
	`numbering_mode` text NOT NULL,
	`dining_option` text NOT NULL,
	`status` text DEFAULT 'accepted' NOT NULL,
	`accepted_at` integer NOT NULL,
	`called_at` integer,
	`completed_at` integer,
	`cancelled_at` integer,
	`modified_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_day_id`) REFERENCES `business_days`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_transaction_id_unique` ON `orders` (`transaction_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_active_number_uq` ON `orders` (`order_number`) WHERE status IN ('accepted', 'calling');--> statement-breakpoint
CREATE INDEX `orders_status_idx` ON `orders` (`status`);--> statement-breakpoint
CREATE TABLE `pairing_codes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`role` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`used_by_device_id` integer,
	`created_by_employee_id` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`used_by_device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pairing_codes_code_idx` ON `pairing_codes` (`code`);--> statement-breakpoint
CREATE TABLE `product_option_groups` (
	`product_id` integer NOT NULL,
	`group_id` integer NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`product_id`, `group_id`),
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`group_id`) REFERENCES `option_groups`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kitchen_name` text DEFAULT '' NOT NULL,
	`price_eat_in` integer NOT NULL,
	`price_take_out` integer,
	`reduced_tax_eligible` integer DEFAULT true NOT NULL,
	`category_id` integer NOT NULL,
	`station` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`button_color` text DEFAULT '' NOT NULL,
	`sold_out` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `products_category_idx` ON `products` (`category_id`);--> statement-breakpoint
CREATE TABLE `register_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`register_id` integer NOT NULL,
	`device_id` integer NOT NULL,
	`business_day_id` integer NOT NULL,
	`opened_by_employee_id` integer NOT NULL,
	`opened_at` integer NOT NULL,
	`opening_cash` integer NOT NULL,
	`closed_by_employee_id` integer,
	`closed_at` integer,
	`counted_cash` integer,
	`expected_cash` integer,
	`cash_difference` integer,
	FOREIGN KEY (`register_id`) REFERENCES `registers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_day_id`) REFERENCES `business_days`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`opened_by_employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`closed_by_employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `register_sessions_open_uq` ON `register_sessions` (`register_id`) WHERE closed_at IS NULL;--> statement-breakpoint
CREATE TABLE `registers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`number` integer NOT NULL,
	`name` text NOT NULL,
	`numbering_mode` text DEFAULT 'auto' NOT NULL,
	`printer_id` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `registers_number_unique` ON `registers` (`number`);--> statement-breakpoint
CREATE TABLE `staff_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_hash` text NOT NULL,
	`employee_id` integer NOT NULL,
	`device_id` integer,
	`kind` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `staff_sessions_token_hash_unique` ON `staff_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `staff_sessions_employee_idx` ON `staff_sessions` (`employee_id`);--> statement-breakpoint
CREATE TABLE `store_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`store_code` text DEFAULT 'STORE01' NOT NULL,
	`store_name` text DEFAULT '' NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`invoice_registration_number` text DEFAULT '' NOT NULL,
	`receipt_header` text DEFAULT '' NOT NULL,
	`receipt_footer` text DEFAULT '' NOT NULL,
	`tax_rounding` text DEFAULT 'floor' NOT NULL,
	`business_day_cutover_minutes` integer DEFAULT 240 NOT NULL,
	`ticket_number_min` integer DEFAULT 1 NOT NULL,
	`ticket_number_max` integer DEFAULT 99 NOT NULL,
	`auto_number_min` integer DEFAULT 100 NOT NULL,
	`auto_number_max` integer DEFAULT 999 NOT NULL,
	`auto_number_reset_daily` integer DEFAULT true NOT NULL,
	`kitchen_warn_seconds` integer DEFAULT 300 NOT NULL,
	`kitchen_alert_seconds` integer DEFAULT 600 NOT NULL,
	`handover_undo_seconds` integer DEFAULT 300 NOT NULL,
	`customer_message` text DEFAULT '' NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transaction_discounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`transaction_id` integer NOT NULL,
	`line_id` integer,
	`discount_id` integer,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`value` integer NOT NULL,
	`scope` text NOT NULL,
	`seq` integer NOT NULL,
	`amount` integer NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`line_id`) REFERENCES `transaction_lines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`discount_id`) REFERENCES `discounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `transaction_discounts_tx_idx` ON `transaction_discounts` (`transaction_id`);--> statement-breakpoint
CREATE TABLE `transaction_line_options` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`line_id` integer NOT NULL,
	`option_id` integer,
	`group_name` text NOT NULL,
	`option_name` text NOT NULL,
	`kitchen_name` text NOT NULL,
	`station` text NOT NULL,
	`price_delta` integer NOT NULL,
	FOREIGN KEY (`line_id`) REFERENCES `transaction_lines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`option_id`) REFERENCES `options`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `transaction_line_options_line_idx` ON `transaction_line_options` (`line_id`);--> statement-breakpoint
CREATE TABLE `transaction_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`transaction_id` integer NOT NULL,
	`line_no` integer NOT NULL,
	`product_id` integer,
	`original_line_id` integer,
	`product_name` text NOT NULL,
	`kitchen_name` text NOT NULL,
	`category_name` text NOT NULL,
	`station` text NOT NULL,
	`unit_price` integer NOT NULL,
	`quantity` integer NOT NULL,
	`tax_rate` integer NOT NULL,
	`gross_amount` integer NOT NULL,
	`line_discount_amount` integer DEFAULT 0 NOT NULL,
	`allocated_order_discount` integer DEFAULT 0 NOT NULL,
	`net_amount` integer NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`original_line_id`) REFERENCES `transaction_lines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `transaction_lines_tx_idx` ON `transaction_lines` (`transaction_id`);--> statement-breakpoint
CREATE TABLE `transaction_tax_summaries` (
	`transaction_id` integer NOT NULL,
	`tax_rate` integer NOT NULL,
	`taxable_amount` integer NOT NULL,
	`tax_amount` integer NOT NULL,
	PRIMARY KEY(`transaction_id`, `tax_rate`),
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`receipt_number` text NOT NULL,
	`kind` text NOT NULL,
	`original_transaction_id` integer,
	`business_day_id` integer NOT NULL,
	`register_id` integer NOT NULL,
	`register_session_id` integer NOT NULL,
	`employee_id` integer NOT NULL,
	`approved_by_employee_id` integer,
	`reason` text,
	`dining_option` text NOT NULL,
	`payment_method` text NOT NULL,
	`subtotal` integer NOT NULL,
	`discount_total` integer NOT NULL,
	`total` integer NOT NULL,
	`cash_received` integer,
	`change` integer,
	`idempotency_key` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`original_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_day_id`) REFERENCES `business_days`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`register_id`) REFERENCES `registers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`register_session_id`) REFERENCES `register_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approved_by_employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_receipt_number_unique` ON `transactions` (`receipt_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_idempotency_key_unique` ON `transactions` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `transactions_business_day_idx` ON `transactions` (`business_day_id`);--> statement-breakpoint
CREATE INDEX `transactions_original_idx` ON `transactions` (`original_transaction_id`);