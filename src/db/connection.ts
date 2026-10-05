import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import type { Database } from "../api/database";
import { withSpan } from "../telemetry/tracing";
import { createDatabase } from "./index";

export type DatabaseConnection = { db: Database; close: () => Promise<void> };

export async function openDatabase(url: string): Promise<DatabaseConnection> {
    // Resolve SQL after telemetry has patched Bun's constructor.
    const bun = require("bun") as typeof import("bun");
    const client = await withSpan(
        "db.client.initialize",
        async () => new bun.SQL(url),
    );
    const close = () => withSpan("db.client.close", () => client.close());
    try {
        const db = await withSpan("db.initialize", async () =>
            createDatabase(client),
        );
        await withSpan("db.migrate", () =>
            migrate(db, {
                migrationsFolder: fileURLToPath(
                    new URL("../../migrations/", import.meta.url),
                ),
            }),
        );
        return { db, close };
    } catch (error) {
        try {
            await close();
        } catch (cleanupError) {
            throw new AggregateError(
                [error, cleanupError],
                "Database initialization and cleanup failed",
            );
        }
        throw error;
    }
}
