import { DatabaseConnection } from "../db/connection";
import type { DatabaseSession } from "../db/connection";
import type { BlobStorage } from "../services/blob-storage";
import { Tracing } from "../telemetry/tracing";
import type { ApplicationConfig } from "./config";
import { Application } from "./index";
import { StorageFactory } from "./storage";

export type RuntimeDependencies = {
    connect?: (url: string) => Promise<DatabaseSession>;
    getBlobStorage?: () => BlobStorage;
    reportError?: (error: Error) => void;
};

export class ApplicationRuntime {
    private connection: DatabaseSession | undefined;
    private application: Application | undefined;
    private server: ReturnType<typeof Bun.serve> | undefined;
    private starting: Promise<this> | undefined;
    private stopping: Promise<void> | undefined;
    private releasing: Promise<void> | undefined;

    constructor(
        private readonly config: ApplicationConfig,
        private readonly options: RuntimeDependencies = {},
    ) {}

    get url() {
        if (!this.server) throw new Error("Application has not started");
        return this.server.url;
    }

    start(): Promise<this> {
        if (this.stopping || this.releasing)
            return Promise.reject(new Error("Application has stopped"));
        return (this.starting ??= this.initialize());
    }

    private async initialize() {
        try {
            await Tracing.withSpan("runtime.startup", async () => {
                this.connection = await (
                    this.options.connect ?? DatabaseConnection.open
                )(this.config.databaseUrl);
                const factory = new StorageFactory(this.config.storage);
                this.application = new Application({
                    db: this.connection.db,
                    getBlobStorage:
                        this.options.getBlobStorage ?? (() => factory.create()),
                    reportError:
                        this.options.reportError ??
                        ((error) => console.error(error)),
                    imageConfig: this.config.images,
                    workerConfig: this.config.workers,
                    httpConfig: this.config.http,
                });
                this.server = await Tracing.withSpan(
                    "http.server.start",
                    async () =>
                        Bun.serve({
                            port: this.config.port,
                            fetch: this.application!.http.fetch,
                        }),
                );
                this.application.start();
            });
            return this;
        } catch (error) {
            try {
                await this.release();
            } catch (cleanupError) {
                throw new AggregateError(
                    [error, cleanupError],
                    "Application startup and cleanup failed",
                );
            }
            throw error;
        }
    }

    stop() {
        return (this.stopping ??= (async () => {
            // A stop requested during startup must also release resources opened later.
            try {
                await this.starting;
            } catch {
                /* Startup reports its own failure. */
            }
            await this.release();
        })());
    }

    private release() {
        return (this.releasing ??= Tracing.withSpan(
            "runtime.shutdown",
            async () => {
                try {
                    if (this.server)
                        await Tracing.withSpan("http.server.stop", () =>
                            this.server!.stop(),
                        );
                } finally {
                    try {
                        await this.application?.stop();
                    } finally {
                        await this.connection?.close();
                    }
                }
            },
        ));
    }
}
