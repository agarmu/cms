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
