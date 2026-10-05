import {
    createHash,
    randomBytes,
    randomUUID,
    timingSafeEqual,
} from "node:crypto";
import type { UUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { images, imageUploads } from "../db/schema";
import { ConflictError, NotFoundError } from "../lib/errors";
import {
    MissingOriginalError,
    UploadCancelledError,
} from "../services/image-storage";
import type { ImageStorage } from "../services/image-storage";
import { traced } from "../telemetry/tracing";
import type { Database, ReadDatabase } from "./database";
import { scoped } from "./call";
import { Scope } from "./scope";
import { PhotoApi } from "./photos";

export class InvalidUploadTokenError extends Error {}
const tokenHash = (token: string) =>
    createHash("sha256").update(token).digest();

async function receipt(db: ReadDatabase, photoId: UUID, uploadId: UUID) {
    const [upload] = await db
        .select()
        .from(imageUploads)
        .where(
            and(
                eq(imageUploads.id, uploadId),
                eq(imageUploads.photoId, photoId),
            ),
        )
        .execute();
    if (!upload) throw new NotFoundError("Upload not found");
    return upload;
}

async function authorize(
    db: ReadDatabase,
    photoId: UUID,
    uploadId: UUID,
    token: string,
) {
    const upload = await receipt(db, photoId, uploadId);
    if (
        !timingSafeEqual(tokenHash(token), Buffer.from(upload.tokenHash, "hex"))
    ) {
        throw new InvalidUploadTokenError("Invalid upload token");
    }
    return upload;
}

function requirePending(upload: typeof imageUploads.$inferSelect) {
    if (upload.cancelled)
        throw new UploadCancelledError("Upload has been cancelled");
    if (upload.failed)
        throw new ConflictError("Upload has failed; start a new upload");
}

export class ImageUploadApi {
    @scoped(Scope.ImagesWrite)
    @traced("image.upload.create")
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
            .insert(imageUploads)
            .values({
                id: uploadId,
                photoId,
                tokenHash: tokenHash(token).toString("hex"),
            })
            .execute();
        const statusUrl = `/images/${photoId}/uploads/${uploadId}`;
        return {
            ...upload,
            token,
            statusUrl,
            interruptUrl: `${statusUrl}/interrupt`,
            cancelUrl: statusUrl,
        };
    }

    @scoped(Scope.ImagesRead)
    @traced("image.upload.read")
    static async read(db: ReadDatabase, photoId: UUID, uploadId: UUID) {
        const upload = await receipt(db, photoId, uploadId);
        return {
            uploadId: upload.id,
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

    @scoped(Scope.ImagesWrite)
    @traced("image.upload.cancel")
    static async cancel(
        db: Database,
        photoId: UUID,
        uploadId: UUID,
        token: string,
    ) {
        const upload = await authorize(db, photoId, uploadId, token);
        if (upload.cancelled) return ImageUploadApi.read(db, photoId, uploadId);
        const [cancelled] = await db
            .update(imageUploads)
            .set({ cancelled: new Date() })
            .where(
                and(
                    eq(imageUploads.id, uploadId),
                    isNull(imageUploads.completed),
                ),
            )
            .returning()
            .execute();
        if (!cancelled)
            throw new ConflictError("Completed uploads cannot be cancelled");
        return ImageUploadApi.read(db, photoId, uploadId);
    }

    @scoped(Scope.ImagesWrite)
    @traced("image.upload.interrupt")
    static async interrupt(
        db: Database,
        storage: ImageStorage,
        photoId: UUID,
        uploadId: UUID,
        token: string,
        ready: boolean,
    ) {
        await authorize(db, photoId, uploadId, token);
        if (!ready) return ImageUploadApi.cancel(db, photoId, uploadId, token);
        try {
            const photo = await ImageUploadApi.complete(
                db,
                storage,
                photoId,
                uploadId,
            );
            return {
                ...(await ImageUploadApi.read(db, photoId, uploadId)),
                photo,
            };
        } catch (error) {
            if (error instanceof MissingOriginalError)
                return ImageUploadApi.cancel(db, photoId, uploadId, token);
            if (error instanceof UploadCancelledError)
                return ImageUploadApi.read(db, photoId, uploadId);
            throw error;
        }
    }

    @scoped(Scope.ImagesWrite)
    @traced("image.upload.complete")
    static async complete(
        db: Database,
        storage: ImageStorage,
        photoId: UUID,
        uploadId: UUID,
    ) {
        const upload = await receipt(db, photoId, uploadId);
        photoId = upload.photoId;
        uploadId = upload.id;
        if (upload.completed) return PhotoApi.read(db, photoId);
        requirePending(upload);
        // Keep S3 downloads and conversion outside the transaction so cancellation
        // can be persisted immediately, including from another service instance.
        const processed = await storage.processUpload(
            photoId,
            uploadId,
            async () => {
                requirePending(await receipt(db, photoId, uploadId));
            },
        );
        let published = false;
        try {
            const result = await db.transaction(async (tx) => {
                const [photo] = await tx
                    .select({ id: images.id })
                    .from(images)
                    .where(eq(images.id, photoId))
                    .for("update")
                    .execute();
                if (!photo) throw new NotFoundError("Photo not found");
                // Lock the receipt before publishing: cancellation either wins here or
                // observes completion after commit. It cannot race asset publication.
                const [current] = await tx
                    .select()
                    .from(imageUploads)
                    .where(
                        and(
                            eq(imageUploads.id, uploadId),
                            eq(imageUploads.photoId, photoId),
                        ),
                    )
                    .for("update")
                    .execute();
                if (!current) throw new NotFoundError("Upload not found");
                if (current.completed) return PhotoApi.read(tx, photoId);
                requirePending(current);
                const updated = await PhotoApi.update(tx, photoId, {
                    assets: processed.assets,
                });
                await tx
                    .update(imageUploads)
                    .set({ completed: new Date() })
                    .where(eq(imageUploads.id, uploadId))
                    .execute();
                published = true;
                return updated;
            });
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
