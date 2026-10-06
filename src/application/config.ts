import { z } from "zod";
import { Tracing } from "../telemetry/tracing";
import { DatabaseConfiguration } from "../db/config";
import { HttpConfiguration } from "../http/config";
import { ImageConfiguration } from "../services/image-config";
import { WorkerConfiguration } from "../services/worker-config";
import { StorageConfiguration } from "../services/storage-config";
import { TelemetryConfiguration } from "../telemetry/config";

export type ApplicationSettings = z.input<typeof ApplicationConfig.schema>;
export type ApplicationSecrets = z.input<
    typeof ApplicationConfig.secretsSchema
>;

export class ApplicationConfig {
    static readonly schema = z.strictObject({
        port: z.int().min(0).max(65535).default(3000),
        database: DatabaseConfiguration.schema,
        storage: StorageConfiguration.schema,
        images: ImageConfiguration.schema.prefault({}),
        workers: WorkerConfiguration.schema.prefault({}),
        http: HttpConfiguration.schema.prefault({}),
        telemetry: TelemetryConfiguration.schema.prefault({}),
    });
    static readonly secretsSchema = z.strictObject({
        database: DatabaseConfiguration.secretsSchema.prefault({}),
        storage: StorageConfiguration.secretsSchema.prefault({}),
        telemetry: TelemetryConfiguration.secretsSchema.prefault({}),
    });

    readonly database: DatabaseConfiguration;
    readonly port: number;
    readonly storage: StorageConfiguration;
    readonly images: ImageConfiguration;
    readonly workers: WorkerConfiguration;
    readonly http: HttpConfiguration;
    readonly telemetry: TelemetryConfiguration;

    constructor(values: ApplicationSettings, secrets: ApplicationSecrets = {}) {
        const settings = Tracing.withSyncSpan("application.config", () => {
            // Zod/TOML errors can contain supplied values, including credentials.
            const publicResult = ApplicationConfig.schema.safeParse(values);
            if (!publicResult.success)
                throw new Error("Invalid configuration settings");
            const secretResult =
                ApplicationConfig.secretsSchema.safeParse(secrets);
            if (!secretResult.success)
                throw new Error("Invalid secrets settings");
            return { ...publicResult.data, secrets: secretResult.data };
        });
        this.database = new DatabaseConfiguration(
            settings.database,
            settings.secrets.database,
        );
        this.port = settings.port;
        this.storage = new StorageConfiguration(
            settings.storage,
            settings.secrets.storage,
        );
        this.images = new ImageConfiguration(settings.images);
        this.workers = new WorkerConfiguration(settings.workers);
        this.http = new HttpConfiguration(settings.http);
        this.telemetry = new TelemetryConfiguration(
            settings.telemetry,
            settings.secrets.telemetry,
        );
    }

    static async fromFiles(
        configPath = "config.toml",
        secretsPath = "secrets.toml",
    ) {
        const read = async (path: string) => {
            let text: string;
            try {
                text = await Bun.file(path).text();
            } catch {
                throw new Error("Cannot read configuration file: " + path);
            }
            try {
                return Bun.TOML.parse(text);
            } catch {
                throw new Error("Invalid TOML configuration file: " + path);
            }
        };
        const [config, secrets] = await Promise.all([
            read(configPath),
            read(secretsPath),
        ]);
        // The constructor validates the unknown data before using it.
        return new ApplicationConfig(
            config as ApplicationSettings,
            secrets as ApplicationSecrets,
        );
    }
}
