import { traced, withSpan } from "../telemetry/tracing";
import type { UUID } from "node:crypto";
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { images, imageAssets } from "../db/schema";
import { NotFoundError } from "../lib/errors";
import type { Database, ReadDatabase } from "./database";
import { CameraApi } from "./resources/cameras";
import { LensApi } from "./resources/lenses";
import { ImageApi } from "./resources/images";
import { ImageAssetApi } from "./resources/image-assets";
import * as validation from "./validation";
import type { Page } from "./types";
import { scoped } from "./call";
import { Scope } from "./scope";

export const equipmentLink = z.union([
    z.strictObject({ id: validation.uuid }),
    z.strictObject({ create: validation.equipment }),
]);
export const photo = validation.image
    .omit({ cameraId: true, lensId: true })
    .extend({
        camera: equipmentLink.nullable().optional(),
        lens: equipmentLink.nullable().optional(),
        assets: z
            .array(validation.imageAsset.omit({ photoId: true }))
            .optional(),
    });
export const photoChanges = photo
    .partial()
    .refine((value) =>
        Object.values(value).some((field) => field !== undefined),
    );

async function equipmentId(
    db: Database,
    value: z.infer<typeof equipmentLink> | null | undefined,
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

async function replaceAssets(
    db: Database,
    photoId: UUID,
    assets: NonNullable<z.infer<typeof photo>["assets"]>,
) {
    return withSpan(
        "photo.assets.replace",
        async () => {
            await db
                .delete(imageAssets)
                .where(eq(imageAssets.photoId, photoId))
                .execute();
            for (const asset of assets)
                await ImageAssetApi.create(db, { ...asset, photoId });
        },
        { "photo.assets.count": assets.length },
    );
}

async function lockPhoto(db: Database, id: UUID) {
    // Serialize modifications and deletion, including requests that only replace assets.
    return withSpan(
        "photo.lock",
        async () => {
            const [row] = await db
                .select({ id: images.id })
                .from(images)
                .where(eq(images.id, id))
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

// Photo writes are atomic: inline equipment and assets cannot outlive a failed write.
export class PhotoApi {
    @scoped(Scope.ImagesRead)
    @traced("photo.list")
    static async list(db: ReadDatabase, page: Page) {
        const { limit, offset } = validation.pagination.parse(page);
        return db.query.images.findMany({
            limit,
            offset,
            orderBy: [desc(images.posted), asc(images.id)],
            with: { camera: true, lens: true, assets: true },
        });
    }

    @scoped(Scope.ImagesRead)
    @traced("photo.read")
    static async read(db: ReadDatabase, id: UUID) {
        id = validation.uuid.parse(id);
        const row = await db.query.images.findFirst({
            where: eq(images.id, id),
            with: { camera: true, lens: true, assets: true },
        });
        if (!row) throw new NotFoundError("Photo not found");
        return row;
    }

    @scoped(Scope.ImagesWrite)
    @traced("photo.create")
    static async create(db: Database, input: z.infer<typeof photo>) {
        const { camera, lens, assets, ...metadata } = photo.parse(input);
        return withSpan("photo.transaction", () =>
            db.transaction(async (tx) => {
                const cameraId = await equipmentId(tx, camera, "camera");
                const lensId = await equipmentId(tx, lens, "lens");
                const [row] = await ImageApi.create(tx, {
                    ...metadata,
                    cameraId,
                    lensId,
                });
                if (!row) throw new Error("Photo insert returned no record");
                if (assets) await replaceAssets(tx, row.id, assets);
                return PhotoApi.read(tx, row.id);
            }),
        );
    }

    @scoped(Scope.ImagesWrite)
    @traced("photo.update")
    static async update(
        db: Database,
        id: UUID,
        input: z.infer<typeof photoChanges>,
    ) {
        id = validation.uuid.parse(id);
        const { camera, lens, assets, ...metadata } = photoChanges.parse(input);
        return withSpan("photo.transaction", () =>
            db.transaction(async (tx) => {
                await lockPhoto(tx, id);
                const cameraId = await equipmentId(tx, camera, "camera");
                const lensId = await equipmentId(tx, lens, "lens");
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
                if (assets !== undefined) await replaceAssets(tx, id, assets);
                return PhotoApi.read(tx, id);
            }),
        );
    }

    @scoped(Scope.ImagesWrite)
    @traced("photo.remove")
    static async remove(db: Database, id: UUID) {
        id = validation.uuid.parse(id);
        return withSpan("photo.transaction", () =>
            db.transaction(async (tx) => {
                await lockPhoto(tx, id);
                await tx
                    .delete(imageAssets)
                    .where(eq(imageAssets.photoId, id))
                    .execute();
                const [row] = await ImageApi.remove(tx, id);
                if (!row) throw new NotFoundError("Photo not found");
                // Equipment is retained; removal is always a separate explicit operation.
            }),
        );
    }
}
