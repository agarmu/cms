import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import type { SQL } from "bun";
import type { Database } from "../api/database";
import { Tracing } from "../telemetry/tracing";
import { DatabaseFactory } from "./index";

export interface DatabaseSession {
    db: Database;
    close(): Promise<void>;
}

export class DatabaseConnection implements DatabaseSession {
    private closing: Promise<void> | undefined;

    private constructor(
        private readonly client: SQL,
        readonly db: ReturnType<typeof DatabaseFactory.create>,
    ) {}

    static async open(
        url: string,
        migrationsFolder = fileURLToPath(
            new URL("../../migrations/", import.meta.url),
        ),
    ) {
        // Resolve the constructor only after telemetry patches Bun SQL.
        const bun = require("bun") as typeof import("bun");
        const client = await Tracing.withSpan(
            "db.client.initialize",
            async () => new bun.SQL(url),
        );
        try {
            const db = await Tracing.withSpan("db.initialize", async () =>
                DatabaseFactory.create(client),
            );
            await Tracing.withSpan("db.migrate", () =>
                migrate(db, { migrationsFolder }),
            );
            return new DatabaseConnection(client, db);
        } catch (error) {
            try {
                await Tracing.withSpan("db.client.close", () => client.close());
            } catch (cleanupError) {
                throw new AggregateError(
                    [error, cleanupError],
                    "Database initialization and cleanup failed",
                );
            }
            throw error;
        }
    }

    close() {
        return (this.closing ??= Tracing.withSpan("db.client.close", () =>
            this.client.close(),
        ));
    }
}
