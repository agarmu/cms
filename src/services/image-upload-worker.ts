import { and, asc, eq, isNull, lte } from "drizzle-orm";
import { ImageUploadApi } from "../api/image-uploads";
import type { Database } from "../api/database";
import { DatabaseSchema } from "../db/schema";
import { NotFoundError } from "../lib/errors";
import {
    ImageTooLargeError,
    InvalidImageError,
    UploadCancelledError,
} from "./image-storage";
import type { ImageStorage } from "./image-storage";
import { Tracing } from "../telemetry/tracing";
import { WorkerConfiguration } from "./worker-config";

export class ImageUploadWorker {
    private readonly pending = and(
        isNull(DatabaseSchema.imageUploads.completed),
        isNull(DatabaseSchema.imageUploads.failed),
        isNull(DatabaseSchema.imageUploads.cancelled),
    );

    constructor(
        private readonly options: {
            db: Database;
            getStorage: () => ImageStorage;
            reportError: (error: Error) => void;
        },
        private readonly config = new WorkerConfiguration(),
    ) {}

    async check() {
        return Tracing.withSpan("image.upload.check", async () => {
            const uploads = await this.options.db
                .select()
                .from(DatabaseSchema.imageUploads)
                .where(
                    and(
                        this.pending,
                        lte(DatabaseSchema.imageUploads.nextCheck, new Date()),
                    ),
                )
                .orderBy(asc(DatabaseSchema.imageUploads.nextCheck))
                .limit(this.config.batchSize)
                .execute();
            Tracing.setSpanAttributes({
                "image.upload.jobs.count": uploads.length,
            });
            for (const upload of uploads) {
                await Tracing.withSpan(
                    "image.upload.job",
                    async () => {
                        try {
                            await ImageUploadApi.complete(
                                this.options.db,
                                this.options.getStorage(),
                                upload.photoId,
                                upload.id,
                            );
                            Tracing.setSpanAttributes({
                                "job.outcome": "completed",
                            });
                        } catch (error) {
                            if (error instanceof UploadCancelledError) {
                                Tracing.setSpanAttributes({
                                    "job.outcome": "cancelled",
                                });
                                return;
                            }
                            let failed: string | undefined;
                            let delayMs = this.config.uploadRetryMs;
                            if (
                                error instanceof InvalidImageError ||
                                error instanceof ImageTooLargeError
                            ) {
                                failed = error.message;
                            } else if (error instanceof NotFoundError) {
                                if (
                                    Date.now() - upload.created.getTime() >=
                                    this.config.uploadWaitMs
                                ) {
                                    failed =
                                        this.config.uploadWaitMs === 3_600_000
                                            ? "Original image was not uploaded within one hour"
                                            : `Original image was not uploaded within ${this.config.uploadWaitMs / 1000} seconds`;
                                }
                            } else {
                                this.options.reportError(
                                    error instanceof Error
                                        ? error
                                        : new Error(String(error)),
                                );
                                delayMs = this.config.failureRetryMs;
                            }
                            if (failed || !(error instanceof NotFoundError))
                                Tracing.recordSpanError(error);
                            Tracing.setSpanAttributes({
                                "job.outcome": failed ? "failed" : "pending",
                                "job.retry_delay_ms": delayMs,
                            });
                            // A different worker may have completed this upload while we waited.
                            await this.options.db
                                .update(DatabaseSchema.imageUploads)
                                .set({
                                    ...(failed ? { failed } : {}),
                                    nextCheck: new Date(Date.now() + delayMs),
                                })
                                .where(
                                    and(
                                        eq(
                                            DatabaseSchema.imageUploads.id,
                                            upload.id,
                                        ),
                                        this.pending,
                                    ),
                                )
                                .execute();
                        }
                    },
                    {
                        "photo.id": upload.photoId,
                        "image.upload.id": upload.id,
                    },
                );
            }
        });
    }
}
