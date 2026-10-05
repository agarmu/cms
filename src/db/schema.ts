import type { UUID } from "node:crypto";
import { relations, sql } from "drizzle-orm";
import * as pg from "drizzle-orm/pg-core";

export class DatabaseSchema {
    static readonly cameras = pg.pgTable("cameras", {
        id: pg.uuid("id").$type<UUID>().primaryKey().defaultRandom(),
        name: pg.text("name").notNull(),
    });

    static readonly lenses = pg.pgTable("lenses", {
        id: pg.uuid("id").$type<UUID>().primaryKey().defaultRandom(),
        name: pg.text("name").notNull(),
    });

    static readonly images = pg.pgTable("images", {
        id: pg.uuid("id").$type<UUID>().primaryKey().defaultRandom(),
        taken: pg
            .timestamp("taken", { withTimezone: true, mode: "date" })
            .notNull(),
        posted: pg
            .timestamp("posted", { withTimezone: true, mode: "date" })
            .notNull(),
        alt: pg.text("alt").notNull(),
        description: pg.text("description").notNull(),
        enabled: pg.boolean("enabled").notNull(),
        cameraId: pg
            .uuid("camera_id")
            .$type<UUID>()
            .references(() => DatabaseSchema.cameras.id),
        lensId: pg
            .uuid("lens_id")
            .$type<UUID>()
            .references(() => DatabaseSchema.lenses.id),
    });

    static readonly imageAssets = pg.pgTable(
        "image_assets",
        {
            id: pg.integer("id").primaryKey().generatedAlwaysAsIdentity(),
            photoId: pg
                .uuid("photo_id")
                .$type<UUID>()
                .notNull()
                .references(() => DatabaseSchema.images.id),
            width: pg.integer("width").notNull(),
            height: pg.integer("height").notNull(),
            assetLocation: pg.text("asset_location").notNull(),
        },
        (table) => [
            pg.check("image_assets_width_positive", sql`${table.width} > 0`),
            pg.check("image_assets_height_positive", sql`${table.height} > 0`),
        ],
    );

    // Persist pending checks and completion receipts across service restarts.
    static readonly imageUploads = pg.pgTable(
        "image_uploads",
        {
            id: pg.uuid("id").$type<UUID>().primaryKey(),
            photoId: pg
                .uuid("photo_id")
                .$type<UUID>()
                .notNull()
                .references(() => DatabaseSchema.images.id, {
                    onDelete: "cascade",
                }),
            created: pg
                .timestamp("created", { withTimezone: true, mode: "date" })
                .notNull()
                .defaultNow(),
            tokenHash: pg.text("token_hash").notNull(),
            completed: pg.timestamp("completed", {
                withTimezone: true,
                mode: "date",
            }),
            cancelled: pg.timestamp("cancelled", {
                withTimezone: true,
                mode: "date",
            }),
            failed: pg.text("failed"),
            retryCount: pg.integer("retry_count").notNull().default(0),
            nextCheck: pg
                .timestamp("next_check", { withTimezone: true, mode: "date" })
                .notNull()
                .default(sql`now() + interval '15 minutes'`),
        },
        (table) => [
            pg.index("image_uploads_photo_id_idx").on(table.photoId),
            pg
                .index("image_uploads_pending_idx")
                .on(table.nextCheck)
                .where(
                    sql`completed IS NULL AND failed IS NULL AND cancelled IS NULL`,
                ),
        ],
    );

    // No foreign key: queued objects must survive deletion of their photo.
    static readonly imageAssetGarbage = pg.pgTable(
        "image_asset_garbage",
        {
            photoId: pg.uuid("photo_id").$type<UUID>().notNull(),
            assetLocation: pg.text("asset_location").notNull(),
            retryCount: pg.integer("retry_count").notNull().default(0),
            failed: pg.text("failed"),
            nextCheck: pg
                .timestamp("next_check", { withTimezone: true, mode: "date" })
                .notNull()
                .default(sql`now() + interval '1 hour'`),
        },
        (table) => [
            pg.primaryKey({ columns: [table.photoId, table.assetLocation] }),
            pg.index("image_asset_garbage_next_check_idx").on(table.nextCheck),
        ],
    );

    static readonly camerasRelations = relations(
        DatabaseSchema.cameras,
        ({ many }) => ({
            images: many(DatabaseSchema.images),
        }),
    );

    static readonly lensesRelations = relations(
        DatabaseSchema.lenses,
        ({ many }) => ({
            images: many(DatabaseSchema.images),
        }),
    );

    static readonly imagesRelations = relations(
        DatabaseSchema.images,
        ({ one, many }) => ({
            camera: one(DatabaseSchema.cameras, {
                fields: [DatabaseSchema.images.cameraId],
                references: [DatabaseSchema.cameras.id],
            }),
            lens: one(DatabaseSchema.lenses, {
                fields: [DatabaseSchema.images.lensId],
                references: [DatabaseSchema.lenses.id],
            }),
            assets: many(DatabaseSchema.imageAssets),
        }),
    );

    static readonly imageAssetsRelations = relations(
        DatabaseSchema.imageAssets,
        ({ one }) => ({
            image: one(DatabaseSchema.images, {
                fields: [DatabaseSchema.imageAssets.photoId],
                references: [DatabaseSchema.images.id],
            }),
        }),
    );

    static get definition() {
        return {
            cameras: DatabaseSchema.cameras,
            lenses: DatabaseSchema.lenses,
            images: DatabaseSchema.images,
            imageAssets: DatabaseSchema.imageAssets,
            imageUploads: DatabaseSchema.imageUploads,
            imageAssetGarbage: DatabaseSchema.imageAssetGarbage,
            camerasRelations: DatabaseSchema.camerasRelations,
            lensesRelations: DatabaseSchema.lensesRelations,
            imagesRelations: DatabaseSchema.imagesRelations,
            imageAssetsRelations: DatabaseSchema.imageAssetsRelations,
        };
    }
}

export type Camera = typeof DatabaseSchema.cameras.$inferSelect;
export type NewCamera = typeof DatabaseSchema.cameras.$inferInsert;
export type Lens = typeof DatabaseSchema.lenses.$inferSelect;
export type NewLens = typeof DatabaseSchema.lenses.$inferInsert;
export type Image = typeof DatabaseSchema.images.$inferSelect;
export type NewImage = typeof DatabaseSchema.images.$inferInsert;
export type ImageAsset = typeof DatabaseSchema.imageAssets.$inferSelect;
export type NewImageAsset = typeof DatabaseSchema.imageAssets.$inferInsert;
