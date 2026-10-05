import { and, asc, eq, isNull, lte } from "drizzle-orm";
import { ImageUploadApi } from "../api/image-uploads";
import type { Database } from "../api/database";
import { imageUploads } from "../db/schema";
import { NotFoundError } from "../lib/errors";
import {
    ImageTooLargeError,
    InvalidImageError,
    UploadCancelledError,
} from "./image-storage";
import type { ImageStorage } from "./image-storage";
import {
    recordSpanError,
    setSpanAttributes,
    withSpan,
} from "../telemetry/tracing";

const pending = and(
    isNull(imageUploads.completed),
    isNull(imageUploads.failed),
    isNull(imageUploads.cancelled),
);
const uploadWaitMs = 60 * 60 * 1000;

// The database stores the schedule; timers merely wake the worker up.
export async function checkImageUploads(options: {
    db: Database;
    getStorage: () => ImageStorage;
    reportError: (error: Error) => void;
}) {
    return withSpan("image.upload.check", async () => {
        const uploads = await options.db
            .select()
            .from(imageUploads)
            .where(and(pending, lte(imageUploads.nextCheck, new Date())))
            .orderBy(asc(imageUploads.nextCheck))
            .limit(10)
            .execute();
        setSpanAttributes({ "image.upload.jobs.count": uploads.length });
        for (const upload of uploads) {
            await withSpan(
                "image.upload.job",
                async () => {
                    try {
                        await ImageUploadApi.complete(
                            options.db,
                            options.getStorage(),
                            upload.photoId,
                            upload.id,
                        );
                        setSpanAttributes({ "job.outcome": "completed" });
                    } catch (error) {
                        if (error instanceof UploadCancelledError) {
                            setSpanAttributes({ "job.outcome": "cancelled" });
                            return;
                        }
                        let failed: string | undefined;
                        let delayMs = 10_000;
                        if (
                            error instanceof InvalidImageError ||
                            error instanceof ImageTooLargeError
                        ) {
                            failed = error.message;
                        } else if (error instanceof NotFoundError) {
                            if (
                                Date.now() - upload.created.getTime() >=
                                uploadWaitMs
                            )
                                failed =
                                    "Original image was not uploaded within one hour";
                        } else {
                            options.reportError(
                                error instanceof Error
                                    ? error
                                    : new Error(String(error)),
                            );
                            delayMs = 30_000;
                        }
                        if (failed || !(error instanceof NotFoundError))
                            recordSpanError(error);
                        setSpanAttributes({
                            "job.outcome": failed ? "failed" : "pending",
                            "job.retry_delay_ms": delayMs,
                        });
                        // A different worker may have completed this upload while we waited.
                        await options.db
                            .update(imageUploads)
                            .set({
                                ...(failed ? { failed } : {}),
                                nextCheck: new Date(Date.now() + delayMs),
                            })
                            .where(and(eq(imageUploads.id, upload.id), pending))
                            .execute();
                    }
                },
                { "photo.id": upload.photoId, "image.upload.id": upload.id },
            );
        }
    });
}
