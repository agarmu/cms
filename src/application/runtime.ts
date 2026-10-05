import { openDatabase } from "../db/connection";
import type { DatabaseConnection } from "../db/connection";
import type { BlobStorage } from "../services/blob-storage";
import { withSpan } from "../telemetry/tracing";
import type { ApplicationConfig } from "./config";
import { createApplication } from "./index";
import type { Application } from "./index";
import { createBlobStorage } from "./storage";

export async function startApplication(
    config: ApplicationConfig,
    options: {
        connect?: (url: string) => Promise<DatabaseConnection>;
        getBlobStorage?: () => BlobStorage;
        reportError?: (error: Error) => void;
    } = {},
) {
    let connection: DatabaseConnection | undefined;
    let application: Application | undefined;
    let server: ReturnType<typeof Bun.serve> | undefined;
    let stopping: Promise<void> | undefined;
    const stop = () =>
        (stopping ??= (async () => {
            // Drain requests and workers before releasing their database dependency.
            try {
                if (server)
                    await withSpan("http.server.stop", () => server!.stop());
            } finally {
                try {
                    await application?.stop();
                } finally {
                    await connection?.close();
                }
            }
        })());

    try {
        await withSpan("runtime.startup", async () => {
            connection = await (options.connect ?? openDatabase)(
                config.databaseUrl,
            );
            application = await withSpan("http.app.initialize", async () =>
                createApplication({
                    db: connection!.db,
                    getBlobStorage: options.getBlobStorage ?? createBlobStorage,
                    reportError:
                        options.reportError ??
                        ((error) => console.error(error)),
                }),
            );
            server = await withSpan("http.server.start", async () =>
                Bun.serve({
                    port: config.port,
                    fetch: application!.http.fetch,
                }),
            );
            application.start();
        });
        return { url: server!.url, stop };
    } catch (error) {
        try {
            await stop();
        } catch (cleanupError) {
            throw new AggregateError(
                [error, cleanupError],
                "Application startup and cleanup failed",
            );
        }
        throw error;
    }
}
