import type { Database } from "../api/database";
import { HttpApplication } from "../http/app";
import { HttpConfiguration } from "../http/config";
import type { BlobStorage } from "../services/blob-storage";
import { BackgroundWorker } from "../services/background-worker";
import { ImageGarbageCollector } from "../services/image-garbage-collector";
import { ImageStorage } from "../services/image-storage";
import { ImageUploadWorker } from "../services/image-upload-worker";
import { ImageConfiguration } from "../services/image-config";
import { WorkerConfiguration } from "../services/worker-config";
import { Tracing } from "../telemetry/tracing";

export type ApplicationDependencies = {
    db: Database;
    getBlobStorage: () => BlobStorage;
    reportError: (error: Error) => void;
    imageConfig?: ImageConfiguration;
    workerConfig?: WorkerConfiguration;
    httpConfig?: HttpConfiguration;
};

export class Application {
    readonly http: HttpApplication;
    private storage: ImageStorage | undefined;
    private readonly worker: BackgroundWorker;
    private stopped = false;

    constructor(private readonly options: ApplicationDependencies) {
        const components = Tracing.withSyncSpan(
            "application.initialize",
            () => {
                const dependencies = {
                    db: options.db,
                    getStorage: this.getImageStorage,
                    reportError: options.reportError,
                };
                const workerConfig =
                    options.workerConfig ?? new WorkerConfiguration();
                const uploads = new ImageUploadWorker(
                    dependencies,
                    workerConfig,
                );
                const garbage = new ImageGarbageCollector(
                    dependencies,
                    workerConfig,
                );
                return {
                    http: new HttpApplication(
                        {
                            db: options.db,
                            getImageStorage: this.getImageStorage,
                            reportError: options.reportError,
                        },
                        options.httpConfig ?? new HttpConfiguration(),
                    ),
                    worker: new BackgroundWorker(
                        {
                            tasks: [
                                () => uploads.check(),
                                () => garbage.collect(),
                            ],
                            reportError: options.reportError,
                        },
                        workerConfig,
                    ),
                };
            },
        );
        this.http = components.http;
        this.worker = components.worker;
    }

    private readonly getImageStorage = () =>
        (this.storage ??= Tracing.withSyncSpan(
            "image.storage.initialize",
            () =>
                new ImageStorage(
                    this.options.getBlobStorage(),
                    this.options.imageConfig,
                ),
        ));

    start() {
        return Tracing.withSyncSpan("application.start", () => {
            if (this.stopped) throw new Error("Application has stopped");
            this.worker.start();
            return this;
        });
    }

    stop() {
        return Tracing.withSpan("application.stop", async () => {
            this.stopped = true;
            await this.worker.stop();
        });
    }
}
