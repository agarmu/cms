ALTER TABLE "images" RENAME TO "photos";--> statement-breakpoint
ALTER TABLE "photos" RENAME COLUMN "taken" TO "taken_at";--> statement-breakpoint
ALTER TABLE "photos" RENAME COLUMN "posted" TO "posted_at";--> statement-breakpoint
ALTER TABLE "photos" RENAME COLUMN "alt" TO "alt_text";--> statement-breakpoint
ALTER TABLE "photos" RENAME COLUMN "description" TO "caption";--> statement-breakpoint
ALTER TABLE "photos" RENAME COLUMN "enabled" TO "visible";--> statement-breakpoint
ALTER TABLE "photos" DROP CONSTRAINT "images_camera_id_cameras_id_fk";
--> statement-breakpoint
ALTER TABLE "photos" DROP CONSTRAINT "images_lens_id_lenses_id_fk";
--> statement-breakpoint
ALTER TABLE "image_assets" DROP CONSTRAINT "image_assets_photo_id_images_id_fk";
--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "location" text;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_camera_id_cameras_id_fk" FOREIGN KEY ("camera_id") REFERENCES "public"."cameras"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_lens_id_lenses_id_fk" FOREIGN KEY ("lens_id") REFERENCES "public"."lenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_assets" ADD CONSTRAINT "image_assets_photo_id_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photos"("id") ON DELETE no action ON UPDATE no action;