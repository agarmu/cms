import { SQL } from "bun";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { z } from "zod";
import { createDatabase } from "./db";
import { createApp } from "./http/app";

const config = z
    .object({
        databaseUrl: z.url({ protocol: /^postgres(ql)?$/ }),
        port: z.coerce.number().int().min(1).max(65535).default(3000),
    })
    .parse({
        databaseUrl: process.env["DATABASE_URL"],
        port: process.env["PORT"],
    });

const client = new SQL(config.databaseUrl);
try {
    const db = createDatabase(client);
    await migrate(db, {
        migrationsFolder: fileURLToPath(
            new URL("../migrations/", import.meta.url),
        ),
    });
    const app = createApp({
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
        await server.stop(true);
    }
} finally {
    await client.close();
}
