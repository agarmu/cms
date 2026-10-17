// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

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

    static readonly photos = pg.pgTable("photos", {
        id: pg.uuid("id").$type<UUID>().primaryKey().defaultRandom(),
        takenAt: pg
            .timestamp("taken_at", { withTimezone: true, mode: "date" })
            .notNull(),
        postedAt: pg
            .timestamp("posted_at", { withTimezone: true, mode: "date" })
            .notNull(),
        altText: pg.text("alt_text").notNull(),
        caption: pg.text("caption").notNull(),
        description: pg.text("description").notNull().default(""),
        location: pg.text("location"),
        visible: pg.boolean("visible").notNull(),
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
                .references(() => DatabaseSchema.photos.id),
            width: pg.integer("width").notNull(),
            height: pg.integer("height").notNull(),
            byteSize: pg.bigint("byte_size", { mode: "number" }),
            assetLocation: pg.text("asset_location").notNull(),
        },
        (table) => [
            pg.check("image_assets_width_positive", sql`${table.width} > 0`),
            pg.check("image_assets_height_positive", sql`${table.height} > 0`),
            pg.check(
                "image_assets_byte_size_valid",
                sql`${table.byteSize} > 0 AND ${table.byteSize} <= 9007199254740991`,
            ),
        ],
    );

    // Persist pending checks and completion receipts across service restarts.
    static readonly imageUploads = pg.pgTable(
        "image_uploads",
        {
            id: pg.uuid("id").$type<UUID>().primaryKey(),
            photoId: pg.uuid("photo_id").$type<UUID>().notNull(),
            kind: pg
                .text("kind", { enum: ["creation", "replacement"] })
                .notNull()
                .default("replacement"),
            ownerIssuer: pg.text("owner_issuer"),
            ownerSubject: pg.text("owner_subject"),
            created: pg
                .timestamp("created", { withTimezone: true, mode: "date" })
                .notNull()
                .defaultNow(),
            assets: pg.jsonb("assets").$type<
                {
                    width: number;
                    height: number;
                    byteSize?: number | null;
                    assetLocation: string;
                }[]
            >(),
            consumed: pg.timestamp("consumed", {
                withTimezone: true,
                mode: "date",
            }),
            inputHash: pg.text("input_hash"),
            expires: pg
                .timestamp("expires", { withTimezone: true, mode: "date" })
                .notNull()
                .default(sql`now() + interval '24 hours'`),
            cleaned: pg.timestamp("cleaned", {
                withTimezone: true,
                mode: "date",
            }),
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
                .index("image_uploads_expiry_idx")
                .on(table.expires)
                .where(sql`cleaned IS NULL`),
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
            photos: many(DatabaseSchema.photos),
        }),
    );

    static readonly lensesRelations = relations(
        DatabaseSchema.lenses,
        ({ many }) => ({
            photos: many(DatabaseSchema.photos),
        }),
    );

    static readonly photosRelations = relations(
        DatabaseSchema.photos,
        ({ one, many }) => ({
            camera: one(DatabaseSchema.cameras, {
                fields: [DatabaseSchema.photos.cameraId],
                references: [DatabaseSchema.cameras.id],
            }),
            lens: one(DatabaseSchema.lenses, {
                fields: [DatabaseSchema.photos.lensId],
                references: [DatabaseSchema.lenses.id],
            }),
            assets: many(DatabaseSchema.imageAssets),
        }),
    );

    static readonly imageAssetsRelations = relations(
        DatabaseSchema.imageAssets,
        ({ one }) => ({
            image: one(DatabaseSchema.photos, {
                fields: [DatabaseSchema.imageAssets.photoId],
                references: [DatabaseSchema.photos.id],
            }),
        }),
    );

    static get definition() {
        return {
            cameras: DatabaseSchema.cameras,
            lenses: DatabaseSchema.lenses,
            photos: DatabaseSchema.photos,
            imageAssets: DatabaseSchema.imageAssets,
            imageUploads: DatabaseSchema.imageUploads,
            imageAssetGarbage: DatabaseSchema.imageAssetGarbage,
            camerasRelations: DatabaseSchema.camerasRelations,
            lensesRelations: DatabaseSchema.lensesRelations,
            photosRelations: DatabaseSchema.photosRelations,
            imageAssetsRelations: DatabaseSchema.imageAssetsRelations,
        };
    }
}

export type Camera = typeof DatabaseSchema.cameras.$inferSelect;
export type NewCamera = typeof DatabaseSchema.cameras.$inferInsert;
export type Lens = typeof DatabaseSchema.lenses.$inferSelect;
export type NewLens = typeof DatabaseSchema.lenses.$inferInsert;
export type Image = typeof DatabaseSchema.photos.$inferSelect;
export type NewImage = typeof DatabaseSchema.photos.$inferInsert;
export type ImageAsset = typeof DatabaseSchema.imageAssets.$inferSelect;
export type NewImageAsset = typeof DatabaseSchema.imageAssets.$inferInsert;
