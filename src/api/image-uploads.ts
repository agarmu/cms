import {
    createHash,
    randomBytes,
    randomUUID,
    timingSafeEqual,
} from "node:crypto";
import type { UUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { DatabaseSchema } from "../db/schema";
import { ConflictError, NotFoundError } from "../lib/errors";
import { UploadCancelledError } from "../services/image-storage";
import type { ImageStorage } from "../services/image-storage";
import { Tracing } from "../telemetry/tracing";
import type { Database, ReadDatabase } from "./database";
import { ApiScope } from "./call";
import { Scope } from "./scope";
import { PhotoApi } from "./photos";

export class InvalidUploadTokenError extends Error {}
export class ImageUploadApi {
    private static tokenHash(token: string) {
        return createHash("sha256").update(token).digest();
    }

    private static async receipt(
        db: ReadDatabase,
        photoId: UUID,
        uploadId: UUID,
    ) {
        const [upload] = await db
            .select()
            .from(DatabaseSchema.imageUploads)
            .where(
                and(
                    eq(DatabaseSchema.imageUploads.id, uploadId),
                    eq(DatabaseSchema.imageUploads.photoId, photoId),
                ),
            )
            .execute();
        if (!upload) throw new NotFoundError("Upload not found");
        return upload;
    }

    private static async authorize(
        db: ReadDatabase,
        photoId: UUID,
        uploadId: UUID,
        token: string,
    ) {
        const upload = await ImageUploadApi.receipt(db, photoId, uploadId);
        if (
            !timingSafeEqual(
                ImageUploadApi.tokenHash(token),
                Buffer.from(upload.tokenHash, "hex"),
            )
        ) {
            throw new InvalidUploadTokenError("Invalid upload token");
        }
        return upload;
    }

    private static requirePending(
        upload: typeof DatabaseSchema.imageUploads.$inferSelect,
    ) {
        if (upload.cancelled)
            throw new UploadCancelledError("Upload has been cancelled");
        if (upload.failed)
            throw new ConflictError("Upload has failed; start a new upload");
    }

    @ApiScope.scoped(Scope.PhotosAssetsWrite)
    @Tracing.traced("image.upload.create")
    static async create(
        db: Database,
        storage: ImageStorage,
        photoId: UUID,
        contentType: string,
    ) {
        photoId = (await PhotoApi.read(db, photoId)).id;
        const uploadId = randomUUID();
        const token = randomBytes(32).toString("hex");
        const upload = await storage.createUpload(
            photoId,
            uploadId,
            contentType,
        );
        await db
            .insert(DatabaseSchema.imageUploads)
            .values({
                id: uploadId,
                photoId,
                tokenHash: ImageUploadApi.tokenHash(token).toString("hex"),
            })
            .execute();
        return { ...upload, token };
    }

    @ApiScope.scoped(Scope.PhotosRead)
    @Tracing.traced("image.upload.read")
    static async read(db: ReadDatabase, photoId: UUID, uploadId: UUID) {
        const upload = await ImageUploadApi.receipt(db, photoId, uploadId);
        return {
            id: upload.id,
            status: upload.completed
                ? "completed"
                : upload.cancelled
                  ? "cancelled"
                  : upload.failed
                    ? "failed"
                    : "pending",
            completedAt: upload.completed,
            cancelledAt: upload.cancelled,
            error: upload.failed,
        };
    }

    @ApiScope.scoped(Scope.PhotosAssetsWrite)
    @Tracing.traced("image.upload.cancel")
    static async cancel(
        db: Database,
        photoId: UUID,
        uploadId: UUID,
        token: string,
    ) {
        const upload = await ImageUploadApi.authorize(
            db,
            photoId,
            uploadId,
            token,
        );
        if (upload.cancelled) return ImageUploadApi.read(db, photoId, uploadId);
        const [cancelled] = await db
            .update(DatabaseSchema.imageUploads)
            .set({ cancelled: new Date() })
            .where(
                and(
                    eq(DatabaseSchema.imageUploads.id, uploadId),
                    isNull(DatabaseSchema.imageUploads.completed),
                ),
            )
            .returning()
            .execute();
        if (!cancelled)
            throw new ConflictError("Completed uploads cannot be cancelled");
        return ImageUploadApi.read(db, photoId, uploadId);
    }

    @ApiScope.scoped(Scope.PhotosAssetsWrite)
    @Tracing.traced("image.upload.finish")
    static async finish(
        db: Database,
        storage: ImageStorage,
        photoId: UUID,
        uploadId: UUID,
        token: string,
    ) {
        await ImageUploadApi.authorize(db, photoId, uploadId, token);
        await ImageUploadApi.complete(db, storage, photoId, uploadId);
        return ImageUploadApi.read(db, photoId, uploadId);
    }

    @ApiScope.scoped(Scope.PhotosAssetsWrite)
    @Tracing.traced("image.upload.complete")
    static async complete(
        db: Database,
        storage: ImageStorage,
        photoId: UUID,
        uploadId: UUID,
    ) {
        const upload = await ImageUploadApi.receipt(db, photoId, uploadId);
        photoId = upload.photoId;
        uploadId = upload.id;
        if (upload.completed) return PhotoApi.read(db, photoId);
        ImageUploadApi.requirePending(upload);
        // Keep S3 downloads and conversion outside the transaction so cancellation
        // can be persisted immediately, including from another service instance.
        const processed = await storage.processUpload(
            photoId,
            uploadId,
            async () => {
                ImageUploadApi.requirePending(
                    await ImageUploadApi.receipt(db, photoId, uploadId),
                );
            },
        );
        let published = false;
        try {
            const result = await Tracing.withSpan("image.upload.publish", () =>
                db.transaction(async (tx) => {
                    const [photo] = await tx
                        .select({ id: DatabaseSchema.images.id })
                        .from(DatabaseSchema.images)
                        .where(eq(DatabaseSchema.images.id, photoId))
                        .for("update")
                        .execute();
                    if (!photo) throw new NotFoundError("Photo not found");
                    // Lock the receipt before publishing: cancellation either wins here or
                    // observes completion after commit. It cannot race asset publication.
                    const [current] = await tx
                        .select()
                        .from(DatabaseSchema.imageUploads)
                        .where(
                            and(
                                eq(DatabaseSchema.imageUploads.id, uploadId),
                                eq(
                                    DatabaseSchema.imageUploads.photoId,
                                    photoId,
                                ),
                            ),
                        )
                        .for("update")
                        .execute();
                    if (!current) throw new NotFoundError("Upload not found");
                    if (current.completed) return PhotoApi.read(tx, photoId);
                    ImageUploadApi.requirePending(current);
                    const updated = await PhotoApi.update(tx, photoId, {
                        assets: processed.assets,
                    });
                    await tx
                        .update(DatabaseSchema.imageUploads)
                        .set({ completed: new Date() })
                        .where(eq(DatabaseSchema.imageUploads.id, uploadId))
                        .execute();
                    published = true;
                    return updated;
                }),
            );
            if (!published) await processed.cleanup();
            return result;
        } catch (error) {
            try {
                await processed.cleanup();
            } catch (cleanupError) {
                throw new AggregateError(
                    [error, cleanupError],
                    "Photo update and upload cleanup failed",
                );
            }
            throw error;
        }
    }
}
