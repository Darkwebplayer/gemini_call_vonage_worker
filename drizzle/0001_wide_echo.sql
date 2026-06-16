CREATE TABLE `job_details` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`shift_start` text,
	`shift_end` text,
	`location` text,
	`status` text,
	`updated_at` text
);
