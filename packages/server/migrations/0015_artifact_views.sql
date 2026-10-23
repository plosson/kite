CREATE TABLE `artifact_views` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`version` integer NOT NULL,
	`viewed_at` text NOT NULL,
	`viewer_user_id` text,
	`viewer_key` text NOT NULL,
	`access` text NOT NULL,
	`client` text NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`viewer_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `artifact_views_artifact_idx` ON `artifact_views` (`artifact_id`,`viewed_at`);--> statement-breakpoint
CREATE INDEX `artifact_views_viewer_idx` ON `artifact_views` (`artifact_id`,`viewer_key`,`viewed_at`);--> statement-breakpoint
CREATE INDEX `artifact_views_viewed_at_idx` ON `artifact_views` (`viewed_at`);