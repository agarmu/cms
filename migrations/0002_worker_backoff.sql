ALTER TABLE "image_asset_garbage" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "image_asset_garbage" ADD COLUMN "failed" text;--> statement-breakpoint
ALTER TABLE "image_uploads" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;