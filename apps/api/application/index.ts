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
import type { AuthenticationProvider } from "../auth/provider";
import type { McpConfiguration } from "../mcp/config";
import { LocalUploadStorage } from "../services/local-upload-storage";
import type { ReadDatabase } from "../api/database";

export type ApplicationDependencies = {
    authentication: AuthenticationProvider;
    allowedSubjects?: readonly string[] | undefined;
    db: Database;
    getBlobStorage: () => BlobStorage;
    reportError: (error: Error) => void;
    imageConfig?: ImageConfiguration;
    workerConfig?: WorkerConfiguration;
    httpConfig?: HttpConfiguration;
    mcpConfig?: McpConfiguration | undefined;
    demo?: { db: ReadDatabase; getBlobStorage: () => BlobStorage } | undefined;
};

export class Application {
    readonly http: HttpApplication;
    private storage: ImageStorage | undefined;
    private blobs: BlobStorage | undefined;
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
                let demoStorage: ImageStorage | undefined;
                return {
                    http: new HttpApplication(
                        {
                            db: options.db,
                            getImageStorage: this.getImageStorage,
                            imageConfig: options.imageConfig,
                            getLocalUploads: () => {
                                const storage = this.getBlobStorage();
                                return storage instanceof LocalUploadStorage
                                    ? storage
                                    : undefined;
                            },
                            reportError: options.reportError,
                            authentication: options.authentication,
                            allowedSubjects: options.allowedSubjects,
                            mcp: options.mcpConfig,
                            demo: options.demo
                                ? {
                                      db: options.demo.db,
                                      getImageStorage: () =>
                                          (demoStorage ??= new ImageStorage(
                                              options.demo!.getBlobStorage(),
                                              options.imageConfig,
                                          )),
                                  }
                                : undefined,
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
                    this.getBlobStorage(),
                    this.options.imageConfig,
                ),
        ));

    private readonly getBlobStorage = () =>
        (this.blobs ??= this.options.getBlobStorage());

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
