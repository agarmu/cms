CREATE SCHEMA "photos_cms_internal";
--> statement-breakpoint
CREATE TABLE "photos_cms_internal"."database_identity" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	CONSTRAINT "database_identity_singleton" CHECK ("photos_cms_internal"."database_identity"."singleton")
);
