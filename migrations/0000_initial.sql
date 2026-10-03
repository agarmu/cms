CREATE TABLE "cameras" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "image_assets" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "image_assets_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"photo_id" uuid NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"asset_location" text NOT NULL,
	CONSTRAINT "image_assets_width_positive" CHECK ("image_assets"."width" > 0),
	CONSTRAINT "image_assets_height_positive" CHECK ("image_assets"."height" > 0)
);
--> statement-breakpoint
CREATE TABLE "images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"taken" timestamp with time zone NOT NULL,
	"posted" timestamp with time zone NOT NULL,
	"alt" text NOT NULL,
	"description" text NOT NULL,
	"enabled" boolean NOT NULL,
	"camera_id" uuid,
	"lens_id" uuid
);
--> statement-breakpoint
CREATE TABLE "lenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "image_assets" ADD CONSTRAINT "image_assets_photo_id_images_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."images"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "images" ADD CONSTRAINT "images_camera_id_cameras_id_fk" FOREIGN KEY ("camera_id") REFERENCES "public"."cameras"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "images" ADD CONSTRAINT "images_lens_id_lenses_id_fk" FOREIGN KEY ("lens_id") REFERENCES "public"."lenses"("id") ON DELETE no action ON UPDATE no action;