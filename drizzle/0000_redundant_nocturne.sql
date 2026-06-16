CREATE TABLE `check_in_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`worker_id` text NOT NULL,
	`call_uuid` text NOT NULL,
	`status` text NOT NULL,
	`recorded_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`phone` text NOT NULL,
	`status` text,
	`updated_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workers_phone_unique` ON `workers` (`phone`);