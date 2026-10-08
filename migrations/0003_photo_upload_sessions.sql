ALTER TABLE "image_uploads" DROP CONSTRAINT "image_uploads_photo_id_images_id_fk";
--> statement-breakpoint
ALTER TABLE "image_uploads" ADD COLUMN "kind" text DEFAULT 'replacement' NOT NULL;--> statement-breakpoint
ALTER TABLE "image_uploads" ADD COLUMN "owner_issuer" text;--> statement-breakpoint
ALTER TABLE "image_uploads" ADD COLUMN "owner_subject" text;--> statement-breakpoint
ALTER TABLE "image_uploads" ADD COLUMN "assets" jsonb;--> statement-breakpoint
ALTER TABLE "image_uploads" ADD COLUMN "consumed" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "image_uploads" ADD COLUMN "input_hash" text;--> statement-breakpoint
ALTER TABLE "image_uploads" ADD COLUMN "expires" timestamp with time zone DEFAULT now() + interval '24 hours' NOT NULL;--> statement-breakpoint
ALTER TABLE "image_uploads" ADD COLUMN "cleaned" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "image_uploads_expiry_idx" ON "image_uploads" USING btree ("expires") WHERE cleaned IS NULL;--> statement-breakpoint
ALTER TABLE "image_uploads" DROP COLUMN "token_hash";