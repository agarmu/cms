import { z } from "zod";
import { DatabaseConfiguration } from "../db/config";
import { StorageConfiguration } from "../services/storage-config";

export class DemoConfiguration {
    static readonly schema = z.strictObject({
        database: DatabaseConfiguration.schema,
        storage: StorageConfiguration.schema,
    });
    static readonly secretsSchema = z.strictObject({
        database: DatabaseConfiguration.secretsSchema.prefault({}),
        storage: StorageConfiguration.secretsSchema.prefault({}),
    });

    readonly database: DatabaseConfiguration;
    readonly storage: StorageConfiguration;

    constructor(
        values: z.input<typeof DemoConfiguration.schema>,
        secrets: z.input<typeof DemoConfiguration.secretsSchema> = {},
    ) {
        const settings = DemoConfiguration.schema.parse(values);
        const credentials = DemoConfiguration.secretsSchema.parse(secrets);
        this.database = new DatabaseConfiguration(
            settings.database,
            credentials.database,
        );
        this.storage = new StorageConfiguration(
            settings.storage,
            credentials.storage,
        );
    }

    static databaseTarget(value: string) {
        if (!URL.canParse(value)) return undefined;
        const url = new URL(value);
        let database = url.pathname;
        try {
            database = decodeURIComponent(database);
        } catch {
            // Compare the literal path when it has no valid decoded form.
        }
        return `${url.hostname}:${url.port || "5432"}/${database}`;
    }
}
