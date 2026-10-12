// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

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
        options: Bun.SQL.Options,
        migrationsFolder = fileURLToPath(
            new URL("../../../migrations/", import.meta.url),
        ),
    ) {
        // Resolve the constructor only after telemetry patches Bun SQL.
        const bun = require("bun") as typeof import("bun");
        const client = await Tracing.withSpan(
            "db.client.initialize",
            async () => new bun.SQL(options),
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
