import { startTelemetry } from "./telemetry/setup";
import { withSpan } from "./telemetry/tracing";

const telemetry = startTelemetry();
let client: import("bun").SQL | undefined;
let processServer: ReturnType<typeof Bun.serve> | undefined;
try {
    // Load application and database modules only after the provider has registered.
    await withSpan("runtime.startup", async () => {
        const [url, migrator, validation, database, http] = await Promise.all([
            import("node:url"),
            import("drizzle-orm/bun-sql/migrator"),
            import("zod"),
            import("./db"),
            import("./http/app"),
        ]);
        // Bun SQL instrumentation patches require("bun").SQL before this lookup.
        const bun = require("bun") as typeof import("bun");
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

        client = await withSpan(
            "db.client.initialize",
            async () => new bun.SQL(config.databaseUrl),
        );
        const db = await withSpan("db.initialize", async () =>
            database.createDatabase(client!),
        );
        await withSpan("db.migrate", () =>
            migrator.migrate(db, {
                migrationsFolder: url.fileURLToPath(
                    new URL("../migrations/", import.meta.url),
                ),
            }),
        );
        const app = await withSpan("http.app.initialize", async () =>
            http.createApp({
                db,
                reportError: (error) => console.error(error),
            }),
        );
        const server = await withSpan("http.server.start", async () =>
            Bun.serve({ port: config.port, fetch: app.fetch }),
        );
        processServer = server;
    });
    const server = processServer!;
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
        await withSpan("http.server.stop", () => server.stop());
    }
} finally {
    try {
        if (client) {
            await withSpan("db.client.close", () => client!.close());
        }
    } finally {
        await telemetry?.shutdown();
    }
}
