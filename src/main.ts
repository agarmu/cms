import { startTelemetry } from "./telemetry/setup";

const telemetry = startTelemetry();
let client: import("bun").SQL | undefined;
try {
    // Load application and database modules only after the provider has registered.
    const [bun, url, migrator, validation, database, http, tracing] =
        await Promise.all([
            import("bun"),
            import("node:url"),
            import("drizzle-orm/bun-sql/migrator"),
            import("zod"),
            import("./db"),
            import("./http/app"),
            import("./telemetry/tracing"),
        ]);
    const config = validation.z
        .object({
            databaseUrl: validation.z.url({ protocol: /^postgres(ql)?$/ }),
            port: validation.z.coerce
                .number()
                .int()
                .min(1)
                .max(65535)
                .default(3000),
        })
        .parse({
            databaseUrl: process.env["DATABASE_URL"],
            port: process.env["PORT"],
        });

    client = new bun.SQL(config.databaseUrl);
    const db = database.createDatabase(client);
    await tracing.withSpan("db.migrate", () =>
        migrator.migrate(db, {
            migrationsFolder: url.fileURLToPath(
                new URL("../migrations/", import.meta.url),
            ),
        }),
    );
    const app = http.createApp({
        db,
        reportError: (error) => console.error(error),
    });
    const server = Bun.serve({ port: config.port, fetch: app.fetch });
    const shutdown = Promise.withResolvers<void>();
    const stop = () => shutdown.resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    console.info(`Listening on ${server.url}`);
    try {
        await shutdown.promise;
    } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        await server.stop();
    }
} finally {
    try {
        await client?.close();
    } finally {
        await telemetry?.shutdown();
    }
}
