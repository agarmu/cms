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
//
import { Tracing } from "../telemetry/tracing";
import type { UUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { DatabaseSchema } from "../db/schema";
import { NotFoundError } from "../lib/errors";
import type { Database, ReadDatabase } from "./database";
import { CameraApi } from "./resources/cameras";
import { LensApi } from "./resources/lenses";
import { ImageApi } from "./resources/images";
import { ImageAssetApi } from "./resources/image-assets";
import { ApiValidation as validation } from "./validation";
import type { Page } from "./types";
import { ApiScope } from "./call";
import { Scope } from "./scope";
import type { AuthIdentity } from "../auth/provider";

export class PhotoValidation {
    static readonly equipmentLink = z.union([
        z.strictObject({ id: validation.uuid }),
        z.strictObject({ create: validation.equipment }),
    ]);
    static readonly photo = validation.image
        .omit({ cameraId: true, lensId: true })
        .extend({
            camera: PhotoValidation.equipmentLink.nullable().optional(),
            lens: PhotoValidation.equipmentLink.nullable().optional(),
            assets: z
                .array(validation.imageAsset.omit({ photoId: true }))
                .optional(),
        });
    static readonly photoChanges = PhotoValidation.photo
        .partial()
        .refine((value) =>
            Object.values(value).some((field) => field !== undefined),
        );
    static readonly creation = PhotoValidation.photo
        .omit({ assets: true })
        .extend({ uploadId: validation.uuid });
}

// Photo writes are atomic: inline equipment and assets cannot outlive a failed write.
export class PhotoApi {
    private static async equipmentId(
        db: Database,
        value: z.infer<typeof PhotoValidation.equipmentLink> | null | undefined,
        kind: "camera" | "lens",
    ) {
        if (value == null) return value;
        if ("id" in value) return value.id;
        const [row] = await (kind === "camera" ? CameraApi : LensApi).create(
            db,
            value.create,
        );
        if (!row) throw new Error("Equipment insert returned no record");
        return row.id;
    }

    private static async replaceAssets(
        db: Database,
        photoId: UUID,
        assets: NonNullable<z.infer<typeof PhotoValidation.photo>["assets"]>,
    ) {
        return Tracing.withSpan(
            "photo.assets.replace",
            async () => {
                const removed = await db
                    .delete(DatabaseSchema.imageAssets)
                    .where(eq(DatabaseSchema.imageAssets.photoId, photoId))
                    .returning({
                        photoId: DatabaseSchema.imageAssets.photoId,
                        assetLocation: DatabaseSchema.imageAssets.assetLocation,
                    })
                    .execute();
                const retained = new Set(
                    assets.map((asset) => asset.assetLocation),
                );
                const obsolete = new Map(
                    removed.map((asset) => [asset.assetLocation, asset]),
                );
                for (const filename of retained) obsolete.delete(filename);
                if (obsolete.size) {
                    await db
                        .insert(DatabaseSchema.imageAssetGarbage)
                        .values([...obsolete.values()])
                        .onConflictDoUpdate({
                            target: [
                                DatabaseSchema.imageAssetGarbage.photoId,
                                DatabaseSchema.imageAssetGarbage.assetLocation,
                            ],
                            // Reattachment and removal restart the grace period for signed URLs.
                            set: {
                                nextCheck: sql`now() + interval '1 hour'`,
                                retryCount: 0,
                                failed: null,
                            },
                        })
                        .execute();
                }
                for (const asset of assets)
                    await ImageAssetApi.create(db, { ...asset, photoId });
            },
            { "photo.assets.count": assets.length },
        );
    }

    private static async lockPhoto(db: Database, id: UUID) {
        // Serialize modifications and deletion, including requests that only replace assets.
        return Tracing.withSpan(
            "photo.lock",
            async () => {
                const [row] = await db
                    .select({ id: DatabaseSchema.images.id })
                    .from(DatabaseSchema.images)
                    .where(eq(DatabaseSchema.images.id, id))
                    .for("update")
                    .execute();
                if (!row) throw new NotFoundError("Photo not found");
            },
            {
                "db.system.name": "postgresql",
                "db.operation.name": "SELECT",
                "db.collection.name": "images",
            },
        );
    }

    @ApiScope.scoped(Scope.PhotosRead)
    @Tracing.traced("photo.list")
    static async list(db: ReadDatabase, page: Page, identity?: AuthIdentity) {
        const { limit, offset } = validation.pagination.parse(page);
        return db.query.images.findMany({
            where:
                identity && !identity.scopes.has(Scope.PhotosReadHidden)
                    ? eq(DatabaseSchema.images.enabled, true)
                    : undefined,
            limit,
            offset,
            orderBy: [
                desc(DatabaseSchema.images.posted),
                asc(DatabaseSchema.images.id),
            ],
            with: { camera: true, lens: true, assets: true },
        });
    }

    @ApiScope.scoped(Scope.PhotosRead)
    @Tracing.traced("photo.read")
    static async read(db: ReadDatabase, id: UUID, identity?: AuthIdentity) {
        id = validation.uuid.parse(id);
        const row = await db.query.images.findFirst({
            where: and(
                eq(DatabaseSchema.images.id, id),
                identity && !identity.scopes.has(Scope.PhotosReadHidden)
                    ? eq(DatabaseSchema.images.enabled, true)
                    : undefined,
            ),
            with: { camera: true, lens: true, assets: true },
        });
        if (!row) throw new NotFoundError("Photo not found");
        return row;
    }

    @ApiScope.scoped(Scope.PhotosCreate)
    @Tracing.traced("photo.create")
    static async create(
        db: Database,
        input: z.infer<typeof PhotoValidation.photo>,
        id?: UUID,
    ) {
        const { camera, lens, assets, ...metadata } =
            PhotoValidation.photo.parse(input);
        return Tracing.withSpan("photo.transaction", () =>
            db.transaction(async (tx) => {
                const cameraId = await PhotoApi.equipmentId(
                    tx,
                    camera,
                    "camera",
                );
                const lensId = await PhotoApi.equipmentId(tx, lens, "lens");
                const [row] = await ImageApi.create(
                    tx,
                    { ...metadata, cameraId, lensId },
                    id,
                );
                if (!row) throw new Error("Photo insert returned no record");
                if (assets?.length)
                    await PhotoApi.replaceAssets(tx, row.id, assets);
                return PhotoApi.read(tx, row.id);
            }),
        );
    }

    @ApiScope.scoped(Scope.PhotosMetadataUpdate)
    @Tracing.traced("photo.update")
    static async update(
        db: Database,
        id: UUID,
        input: z.infer<typeof PhotoValidation.photoChanges>,
    ) {
        id = validation.uuid.parse(id);
        const { camera, lens, assets, ...metadata } =
            PhotoValidation.photoChanges.parse(input);
        return Tracing.withSpan("photo.transaction", () =>
            db.transaction(async (tx) => {
                await PhotoApi.lockPhoto(tx, id);
                const cameraId = await PhotoApi.equipmentId(
                    tx,
                    camera,
                    "camera",
                );
                const lensId = await PhotoApi.equipmentId(tx, lens, "lens");
                if (
                    Object.values({ ...metadata, cameraId, lensId }).some(
                        (value) => value !== undefined,
                    )
                ) {
                    const [row] = await ImageApi.update(tx, id, {
                        ...metadata,
                        cameraId,
                        lensId,
                    });
                    if (!row) throw new NotFoundError("Photo not found");
                }
                if (assets !== undefined)
                    await PhotoApi.replaceAssets(tx, id, assets);
                return PhotoApi.read(tx, id);
            }),
        );
    }

    @ApiScope.scoped(Scope.PhotosDelete)
    @Tracing.traced("photo.remove")
    static async remove(db: Database, id: UUID) {
        id = validation.uuid.parse(id);
        return Tracing.withSpan("photo.transaction", () =>
            db.transaction(async (tx) => {
                await PhotoApi.lockPhoto(tx, id);
                await PhotoApi.replaceAssets(tx, id, []);
                const [row] = await ImageApi.remove(tx, id);
                if (!row) throw new NotFoundError("Photo not found");
                // Equipment is retained; removal is always a separate explicit operation.
            }),
        );
    }
}
