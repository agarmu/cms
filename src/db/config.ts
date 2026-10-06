import { z } from "zod";

export class DatabaseConfiguration {
    static readonly schema = z.strictObject({
        url: z.url({ protocol: /^postgres(ql)?$/ }).refine((value) => {
            const url = new URL(value);
            return !url.password && !url.search && !url.hash;
        }, "Use a password-free URL without query parameters; configure options in database tables"),
        connectTimeout: z.int().positive().default(10_000),
        pool: z
            .strictObject({
                maxConnections: z.int().positive().default(10),
                idleTimeout: z.int().nonnegative().default(30_000),
            })
            .prefault({}),
        tls: z
            .strictObject({
                mode: z
                    .enum([
                        "disable",
                        "allow",
                        "prefer",
                        "require",
                        "verify-ca",
                        "verify-full",
                    ])
                    .default("disable"),
            })
            .prefault({}),
    });
    static readonly secretsSchema = z.strictObject({
        password: z.string().optional(),
    });

    readonly url: string;
    readonly connectTimeout: number;
    readonly pool: z.output<typeof DatabaseConfiguration.schema>["pool"];
    readonly tls: z.output<typeof DatabaseConfiguration.schema>["tls"];
    private readonly password: string;

    constructor(
        values: z.input<typeof DatabaseConfiguration.schema>,
        secrets: z.input<typeof DatabaseConfiguration.secretsSchema> = {},
    ) {
        const settings = DatabaseConfiguration.schema.parse(values);
        this.url = settings.url;
        this.connectTimeout = settings.connectTimeout;
        this.pool = settings.pool;
        this.tls = settings.tls;
        this.password =
            DatabaseConfiguration.secretsSchema.parse(secrets).password ?? "";
    }

    clientOptions(): Bun.SQL.PostgresOrMySQLOptions {
        return {
            url: this.url,
            password: this.password,
            connectionTimeout: this.connectTimeout / 1000,
            max: this.pool.maxConnections,
            idleTimeout: this.pool.idleTimeout / 1000,
            tls: this.tls.mode,
        };
    }
}
