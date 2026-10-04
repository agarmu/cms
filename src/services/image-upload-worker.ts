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
    const uploads = await options.db
        .select()
        .from(imageUploads)
        .where(and(pending, lte(imageUploads.nextCheck, new Date())))
        .orderBy(asc(imageUploads.nextCheck))
        .limit(10)
        .execute();
    for (const upload of uploads) {
        try {
            await ImageUploadApi.complete(
                options.db,
                options.getStorage(),
                upload.photoId,
                upload.id,
            );
        } catch (error) {
            if (error instanceof UploadCancelledError) continue;
            let failed: string | undefined;
            let delayMs = 10_000;
            if (
                error instanceof InvalidImageError ||
                error instanceof ImageTooLargeError
            ) {
                failed = error.message;
            } else if (error instanceof NotFoundError) {
                if (Date.now() - upload.created.getTime() >= uploadWaitMs)
                    failed = "Original image was not uploaded within one hour";
            } else {
                options.reportError(
                    error instanceof Error ? error : new Error(String(error)),
                );
                delayMs = 30_000;
            }
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
    }
}

export function startImageUploadWorker(
    options: Parameters<typeof checkImageUploads>[0],
) {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running: Promise<void> | undefined;
    const run = () => {
        running = checkImageUploads(options)
            .catch((error: unknown) =>
                options.reportError(
                    error instanceof Error ? error : new Error(String(error)),
                ),
            )
            .finally(() => {
                if (!stopped) timer = setTimeout(run, 5000);
            });
    };
    timer = setTimeout(run, 5000);
    return async () => {
        stopped = true;
        clearTimeout(timer);
        await running;
    };
}
