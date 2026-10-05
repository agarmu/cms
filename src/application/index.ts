import type { Database } from "../api/database";
import { createApp } from "../http/app";
import type { BlobStorage } from "../services/blob-storage";
import { startBackgroundWorker } from "../services/background-worker";
import { collectImageGarbage } from "../services/image-garbage-collector";
import { ImageStorage } from "../services/image-storage";
import { checkImageUploads } from "../services/image-upload-worker";

export type ApplicationDependencies = {
    db: Database;
    getBlobStorage: () => BlobStorage;
    reportError: (error: Error) => void;
};

// Assembling an application does not open sockets or start background work.
export function createApplication(options: ApplicationDependencies) {
    let storage: ImageStorage | undefined;
    const getImageStorage = () =>
        (storage ??= new ImageStorage(options.getBlobStorage()));
    const dependencies = {
        db: options.db,
        getStorage: getImageStorage,
        reportError: options.reportError,
    };
    const http = createApp({
        db: options.db,
        getImageStorage,
        reportError: options.reportError,
    });
    let stopWorker: (() => Promise<void>) | undefined;
    let stopped = false;

    return {
        http,
        start() {
            if (stopped) throw new Error("Application has stopped");
            stopWorker ??= startBackgroundWorker({
                tasks: [
                    () => checkImageUploads(dependencies),
                    () => collectImageGarbage(dependencies),
                ],
                reportError: options.reportError,
            });
        },
        async stop() {
            stopped = true;
            await stopWorker?.();
        },
    };
}

export type Application = ReturnType<typeof createApplication>;
