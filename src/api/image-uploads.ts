import { createHash, randomUUID } from "node:crypto";
import type { UUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import type { AuthIdentity } from "../auth/provider";
import { DatabaseSchema } from "../db/schema";
import { ConflictError, ForbiddenError, NotFoundError } from "../lib/errors";
import { UploadCancelledError } from "../services/image-storage";
import type { ImageStorage } from "../services/image-storage";
import { Tracing } from "../telemetry/tracing";
import type { Database, ReadDatabase } from "./database";
import { ApiScope } from "./call";
import { Scope } from "./scope";
import { PhotoApi, PhotoValidation } from "./photos";

const uploads = DatabaseSchema.imageUploads;
type Upload = typeof uploads.$inferSelect;
export class UploadExpiredError extends ConflictError {}

export class ImageUploadApi {
    private static async receipt(db: ReadDatabase, uploadId: UUID) {
        const [upload] = await db
            .select()
            .from(uploads)
            .where(eq(uploads.id, uploadId))
            .execute();
        if (!upload) throw new NotFoundError("Upload not found");
        return upload;
    }

    private static requireAccess(
        upload: Upload,
        identity: AuthIdentity,
        photoId?: UUID,
    ) {
        if (
            photoId
                ? upload.kind !== "replacement" ||
                  upload.photoId !== photoId.toLowerCase()
                : upload.kind !== "creation"
        ) {
            throw new NotFoundError("Upload not found");
        }
        const scope =
            upload.kind === "creation"
                ? Scope.PhotosCreate
                : Scope.PhotosAssetsWrite;
        if (!identity.scopes.has(scope))
            throw new ForbiddenError(`Upload requires ${scope}`);
        if (
            upload.ownerIssuer !== identity.issuer ||
            upload.ownerSubject !== identity.subject
        ) {
            throw new ForbiddenError("Upload belongs to another account");
        }
    }

    private static requireActive(upload: Upload) {
        if (upload.cancelled)
            throw new UploadCancelledError("Upload has been cancelled");
        if (upload.failed)
            throw new ConflictError("Upload has failed; start a new upload");
        if (upload.expires.getTime() <= Date.now())
            throw new UploadExpiredError(
                "Upload has expired; start a new upload",
            );
    }

    private static status(upload: Upload) {
        const committed =
            upload.kind === "creation" ? upload.consumed : upload.completed;
        return {
            id: upload.id,
            status: committed
                ? "completed"
                : upload.cancelled
                  ? "cancelled"
                  : upload.failed
                    ? "failed"
                    : upload.expires.getTime() <= Date.now()
                      ? "expired"
                      : upload.completed
                        ? "ready"
                        : "pending",
            processedAt: upload.completed,
            completedAt: committed,
            cancelledAt: upload.cancelled,
            expiresAt: upload.expires,
            error: upload.failed,
        } as const;
    }

    private static async start(
        db: Database,
        storage: ImageStorage,
        photoId: UUID,
        kind: Upload["kind"],
        contentType: string,
        identity: AuthIdentity,
    ) {
        const scope =
            kind === "creation" ? Scope.PhotosCreate : Scope.PhotosAssetsWrite;
        if (!identity.scopes.has(scope))
            throw new ForbiddenError(`Upload requires ${scope}`);
        const uploadId = randomUUID();
        const signed = await storage.createUpload(
            photoId,
            uploadId,
            contentType,
        );
        const [upload] = await db
            .insert(uploads)
            .values({
                id: uploadId,
                photoId,
                kind,
                ownerIssuer: identity.issuer,
                ownerSubject: identity.subject,
            })
            .returning()
            .execute();
        if (!upload) throw new Error("Upload insert returned no record");
        return {
            ...ImageUploadApi.status(upload),
            upload: {
                url: signed.url,
                method: signed.method,
                headers: signed.headers,
                expiresIn: signed.expiresIn,
            },
        };
    }

    @ApiScope.scoped(Scope.PhotosCreate)
    @Tracing.traced("image.upload.create")
    static async create(
        db: Database,
        storage: ImageStorage,
        contentType: string,
        identity: AuthIdentity,
    ) {
        return ImageUploadApi.start(
            db,
            storage,
            randomUUID(),
            "creation",
            contentType,
            identity,
        );
    }

    @ApiScope.scoped(Scope.PhotosAssetsWrite)
    @Tracing.traced("image.upload.replace")
    static async replace(
        db: Database,
        storage: ImageStorage,
        photoId: UUID,
        contentType: string,
        identity: AuthIdentity,
    ) {
        photoId = (await PhotoApi.read(db, photoId)).id;
        return ImageUploadApi.start(
            db,
            storage,
            photoId,
            "replacement",
            contentType,
            identity,
        );
    }

    static async read(
        db: ReadDatabase,
        uploadId: UUID,
        identity: AuthIdentity,
        photoId?: UUID,
    ) {
        const upload = await ImageUploadApi.receipt(db, uploadId);
        ImageUploadApi.requireAccess(upload, identity, photoId);
        const status = ImageUploadApi.status(upload);
        return {
            ...status,
            assets:
                status.status === "ready"
                    ? (upload.assets ?? []).map(
                          ({ assetLocation, width, height }) => ({
                              filename: assetLocation,
                              width,
                              height,
                              url: `/api/photo-uploads/${upload.id}/assets/${encodeURIComponent(assetLocation)}`,
                          }),
                      )
                    : [],
        };
    }

    static async readAsset(
        db: ReadDatabase,
        storage: ImageStorage,
        uploadId: UUID,
        filename: string,
        identity: AuthIdentity,
    ) {
        const upload = await ImageUploadApi.receipt(db, uploadId);
        ImageUploadApi.requireAccess(upload, identity);
        ImageUploadApi.requireActive(upload);
        if (
            upload.consumed ||
            !upload.completed ||
            !upload.assets?.some((asset) => asset.assetLocation === filename)
        ) {
            throw new NotFoundError("Upload asset not found");
        }
        const expiresIn = Math.min(
            900,
            Math.floor((upload.expires.getTime() - Date.now()) / 1000),
        );
        if (expiresIn <= 0)
            throw new UploadExpiredError(
                "Upload has expired; start a new upload",
            );
        const asset = await storage.read(upload.photoId, filename, expiresIn);
        if (!asset) throw new NotFoundError("Upload asset not found");
        return asset;
    }

    static async cancel(
        db: Database,
        uploadId: UUID,
        identity: AuthIdentity,
        photoId?: UUID,
    ) {
        await db.transaction(async (tx) => {
            const [upload] = await tx
                .select()
                .from(uploads)
                .where(eq(uploads.id, uploadId))
                .for("update")
                .execute();
            if (!upload) throw new NotFoundError("Upload not found");
            ImageUploadApi.requireAccess(upload, identity, photoId);
            if (
                upload.consumed ||
                (upload.kind === "replacement" && upload.completed)
            )
                throw new ConflictError(
                    "Completed uploads cannot be cancelled",
                );
            if (!upload.cancelled)
                await tx
                    .update(uploads)
                    .set({ cancelled: new Date() })
                    .where(eq(uploads.id, upload.id))
                    .execute();
        });
        return ImageUploadApi.read(db, uploadId, identity, photoId);
    }

    static async finish(
        db: Database,
        storage: ImageStorage,
        uploadId: UUID,
        identity: AuthIdentity,
        photoId?: UUID,
    ) {
        ImageUploadApi.requireAccess(
            await ImageUploadApi.receipt(db, uploadId),
            identity,
            photoId,
        );
        await ImageUploadApi.complete(db, storage, uploadId);
        return ImageUploadApi.read(db, uploadId, identity, photoId);
    }

    @ApiScope.scoped(Scope.PhotosCreate)
    @Tracing.traced("photo.createFromUpload")
    static async createPhoto(
        db: Database,
        input: z.infer<typeof PhotoValidation.creation>,
        identity: AuthIdentity,
    ) {
        const { uploadId, ...metadata } = PhotoValidation.creation.parse(input);
        const inputHash = createHash("sha256")
            .update(JSON.stringify(metadata))
            .digest("hex");
        return db.transaction(async (tx) => {
            const [upload] = await tx
                .select()
                .from(uploads)
                .where(eq(uploads.id, uploadId))
                .for("update")
                .execute();
            if (!upload) throw new NotFoundError("Upload not found");
            ImageUploadApi.requireAccess(upload, identity);
            if (upload.consumed) {
                if (upload.inputHash !== inputHash)
                    throw new ConflictError(
                        "Upload has already been used with different photo details",
                    );
                const [photo] = await tx
                    .select({ id: DatabaseSchema.images.id })
                    .from(DatabaseSchema.images)
                    .where(eq(DatabaseSchema.images.id, upload.photoId))
                    .execute();
                if (!photo) throw new NotFoundError("Photo not found");
                return photo;
            }
            ImageUploadApi.requireActive(upload);
            if (!upload.completed || !upload.assets?.length)
                throw new ConflictError("Upload is not ready");
            const photo = await PhotoApi.create(
                tx,
                { ...metadata, assets: upload.assets },
                upload.photoId,
            );
            await tx
                .update(uploads)
                .set({ consumed: new Date(), inputHash })
                .where(eq(uploads.id, upload.id))
                .execute();
            return { id: photo.id };
        });
    }

    @Tracing.traced("image.upload.complete")
    static async complete(db: Database, storage: ImageStorage, uploadId: UUID) {
        const upload = await ImageUploadApi.receipt(db, uploadId);
        if (
            upload.consumed ||
            (upload.kind === "replacement" && upload.completed)
        )
            return;
        ImageUploadApi.requireActive(upload);
        if (upload.completed) return;
        const processed = await storage.processUpload(
            upload.photoId,
            upload.id,
            async () => {
                ImageUploadApi.requireActive(
                    await ImageUploadApi.receipt(db, upload.id),
                );
            },
        );
        let saved = false;
        try {
            await Tracing.withSpan("image.upload.publish", () =>
                db.transaction(async (tx) => {
                    // Replacement and deletion both lock the photo before the upload receipt.
                    if (upload.kind === "replacement") {
                        const [photo] = await tx
                            .select({ id: DatabaseSchema.images.id })
                            .from(DatabaseSchema.images)
                            .where(eq(DatabaseSchema.images.id, upload.photoId))
                            .for("update")
                            .execute();
                        if (!photo) throw new NotFoundError("Photo not found");
                    }
                    const [current] = await tx
                        .select()
                        .from(uploads)
                        .where(eq(uploads.id, upload.id))
                        .for("update")
                        .execute();
                    if (!current) throw new NotFoundError("Upload not found");
                    if (current.completed) return;
                    ImageUploadApi.requireActive(current);
                    if (current.kind === "replacement")
                        await PhotoApi.update(tx, current.photoId, {
                            assets: processed.assets,
                        });
                    await tx
                        .update(uploads)
                        .set({
                            completed: new Date(),
                            assets:
                                current.kind === "creation"
                                    ? processed.assets
                                    : null,
                        })
                        .where(eq(uploads.id, current.id))
                        .execute();
                    saved = true;
                }),
            );
            if (!saved) await processed.cleanup();
        } catch (error) {
            try {
                await processed.cleanup();
            } catch (cleanupError) {
                throw new AggregateError(
                    [error, cleanupError],
                    "Upload processing and cleanup failed",
                );
            }
            throw error;
        }
    }

    static async expire(db: Database, storage: ImageStorage, uploadId: UUID) {
        const upload = await ImageUploadApi.receipt(db, uploadId);
        if (upload.cleaned || upload.expires.getTime() > Date.now()) return;
        await storage.deleteOriginal(upload.photoId, upload.id);
        await db.transaction(async (tx) => {
            const [current] = await tx
                .select()
                .from(uploads)
                .where(eq(uploads.id, upload.id))
                .for("update")
                .execute();
            if (
                !current ||
                current.cleaned ||
                current.expires.getTime() > Date.now()
            )
                return;
            if (
                current.kind === "creation" &&
                !current.consumed &&
                current.assets?.length
            ) {
                await tx
                    .insert(DatabaseSchema.imageAssetGarbage)
                    .values(
                        current.assets.map((asset) => ({
                            photoId: current.photoId,
                            assetLocation: asset.assetLocation,
                            nextCheck: new Date(),
                        })),
                    )
                    .onConflictDoNothing()
                    .execute();
            }
            await tx
                .update(uploads)
                .set({ cleaned: new Date(), assets: null })
                .where(eq(uploads.id, current.id))
                .execute();
        });
    }
}
