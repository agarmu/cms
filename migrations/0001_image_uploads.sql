CREATE TABLE "image_uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"photo_id" uuid NOT NULL,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"token_hash" text NOT NULL,
	"completed" timestamp with time zone,
	"cancelled" timestamp with time zone,
	"failed" text,
	"next_check" timestamp with time zone DEFAULT now() + interval '15 minutes' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "image_uploads" ADD CONSTRAINT "image_uploads_photo_id_images_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."images"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "image_uploads_photo_id_idx" ON "image_uploads" USING btree ("photo_id");
--> statement-breakpoint
CREATE INDEX "image_uploads_pending_idx" ON "image_uploads" USING btree ("next_check") WHERE completed IS NULL AND failed IS NULL AND cancelled IS NULL;
--> statement-breakpoint
CREATE TABLE "image_asset_garbage" (
	"photo_id" uuid NOT NULL,
	"asset_location" text NOT NULL,
	"next_check" timestamp with time zone DEFAULT now() + interval '1 hour' NOT NULL,
	CONSTRAINT "image_asset_garbage_photo_id_asset_location_pk" PRIMARY KEY("photo_id","asset_location")
);
--> statement-breakpoint
CREATE INDEX "image_asset_garbage_next_check_idx" ON "image_asset_garbage" USING btree ("next_check");
