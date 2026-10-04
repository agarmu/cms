import type { UUID } from "node:crypto";
import { relations, sql } from "drizzle-orm";
import * as pg from "drizzle-orm/pg-core";

export const cameras = pg.pgTable("cameras", {
    id: pg.uuid("id").$type<UUID>().primaryKey().defaultRandom(),
    name: pg.text("name").notNull(),
});

export const lenses = pg.pgTable("lenses", {
    id: pg.uuid("id").$type<UUID>().primaryKey().defaultRandom(),
    name: pg.text("name").notNull(),
});

export const images = pg.pgTable("images", {
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
        .references(() => cameras.id),
    lensId: pg
        .uuid("lens_id")
        .$type<UUID>()
        .references(() => lenses.id),
});

export const imageAssets = pg.pgTable(
    "image_assets",
    {
        id: pg.integer("id").primaryKey().generatedAlwaysAsIdentity(),
        photoId: pg
            .uuid("photo_id")
            .$type<UUID>()
            .notNull()
            .references(() => images.id),
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
export const imageUploads = pg.pgTable(
    "image_uploads",
    {
        id: pg.uuid("id").$type<UUID>().primaryKey(),
        photoId: pg
            .uuid("photo_id")
            .$type<UUID>()
            .notNull()
            .references(() => images.id, { onDelete: "cascade" }),
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
export const imageAssetGarbage = pg.pgTable(
    "image_asset_garbage",
    {
        photoId: pg.uuid("photo_id").$type<UUID>().notNull(),
        assetLocation: pg.text("asset_location").notNull(),
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

export const camerasRelations = relations(cameras, ({ many }) => ({
    images: many(images),
}));

export const lensesRelations = relations(lenses, ({ many }) => ({
    images: many(images),
}));

export const imagesRelations = relations(images, ({ one, many }) => ({
    camera: one(cameras, {
        fields: [images.cameraId],
        references: [cameras.id],
    }),
    lens: one(lenses, {
        fields: [images.lensId],
        references: [lenses.id],
    }),
    assets: many(imageAssets),
}));

export const imageAssetsRelations = relations(imageAssets, ({ one }) => ({
    image: one(images, {
        fields: [imageAssets.photoId],
        references: [images.id],
    }),
}));

export type Camera = typeof cameras.$inferSelect;
export type NewCamera = typeof cameras.$inferInsert;
export type Lens = typeof lenses.$inferSelect;
export type NewLens = typeof lenses.$inferInsert;
export type Image = typeof images.$inferSelect;
export type NewImage = typeof images.$inferInsert;
export type ImageAsset = typeof imageAssets.$inferSelect;
export type NewImageAsset = typeof imageAssets.$inferInsert;
