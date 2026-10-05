import { z } from "zod";
import { Tracing } from "../telemetry/tracing";
import { HttpConfiguration } from "../http/config";
import type { HttpSettings } from "../http/config";
import { ImageConfiguration } from "../services/image-config";
import type { ImageSettings } from "../services/image-config";
import { WorkerConfiguration } from "../services/worker-config";
import type { WorkerSettings } from "../services/worker-config";
import { StorageConfiguration } from "../services/storage-config";
import type { StorageSettings } from "../services/storage-config";

export type ApplicationSettings = {
    databaseUrl: string;
    port?: number | string;
    storage?: StorageSettings | StorageConfiguration;
    images?: ImageSettings;
    workers?: WorkerSettings;
    http?: HttpSettings;
};

export class ApplicationConfig {
    private static readonly schema = z.object({
        databaseUrl: z.url({ protocol: /^postgres(ql)?$/ }),
        port: z.coerce.number().int().min(0).max(65535).default(3000),
    });

    readonly databaseUrl: string;
    readonly port: number;
    readonly storage: StorageConfiguration;
    readonly images: ImageConfiguration;
    readonly workers: WorkerConfiguration;
    readonly http: HttpConfiguration;

    constructor(values: ApplicationSettings) {
        const settings = Tracing.withSyncSpan("application.config", () =>
            ApplicationConfig.schema.parse(values),
        );
        this.databaseUrl = settings.databaseUrl;
        this.port = settings.port;
        this.storage =
            values.storage instanceof StorageConfiguration
                ? values.storage
                : new StorageConfiguration(values.storage);
        this.images = new ImageConfiguration(values.images);
        this.workers = new WorkerConfiguration(values.workers);
        this.http = new HttpConfiguration(values.http);
    }

    static fromEnv(env: Record<string, string | undefined> = process.env) {
        return new ApplicationConfig({
            databaseUrl: env["DATABASE_URL"] ?? "",
            ...(env["PORT"] !== undefined ? { port: env["PORT"] } : {}),
            storage: StorageConfiguration.fromEnv(env),
        });
    }
}
